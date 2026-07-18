use crate::execution_artifacts::{
    collect_artifacts, create_run_directory, declared_artifacts, prepare_artifact_backups,
    restore_artifacts, valid_cell_id, verify_inputs, ExecutionArtifact, ExecutionEnvironment,
    ExecutionInput,
};
use crate::execution_trust::{require_execution_trust, ExecutionTrustStore};
use crate::jupyter_publishing::publishing_helper;
use crate::runtime::{
    configure_project_environment, discover_jupyter_kernels_impl, JupyterKernelProbe,
    RuntimeHealth, RuntimeLanguage, JULIA_PROJECT_ARGUMENT,
};
use crate::{canonical_root, now_millis, HostError};
use jupyter_protocol::{
    connection_info::Transport, ClearOutput, ConnectionInfo, ExecuteReply, ExecuteRequest,
    ExecutionCount, ExecutionState, InterruptRequest, JupyterKernelspec, JupyterMessage,
    JupyterMessageContent, KernelInfoReply, KernelInfoRequest, Media, ReplyStatus, ShutdownRequest,
    Stdio,
};
use jupyter_zmq_client::{
    create_client_control_connection, create_client_shell_connection_with_identity,
    peek_ports_with_listeners, peer_identity_for_session, ClientControlConnection,
    ClientIoPubConnection, ClientShellConnection, Connection,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::ffi::OsStr;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio as ProcessStdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tokio::sync::mpsc as async_mpsc;
use uuid::Uuid;
use zeromq::Socket as _;

const MAX_CODE_BYTES: usize = 2 * 1024 * 1024;
const MAX_KERNEL_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_KERNEL_PROCESS_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_KERNEL_STARTUP_DIAGNOSTIC_CHARS: usize = 12 * 1024;
const JULIA_STARTUP_FILE_ARGUMENT: &str = "--startup-file=no";
const DEFAULT_CHANNEL_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const JULIA_CHANNEL_CONNECT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const DEFAULT_STARTUP_STEP_TIMEOUT: Duration = Duration::from_secs(25);
const JULIA_STARTUP_STEP_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const DEFAULT_SESSION_START_TIMEOUT: Duration = Duration::from_secs(55);
const JULIA_SESSION_START_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const LIFECYCLE_TIMEOUT: Duration = Duration::from_secs(35);
const DEFAULT_EXECUTION_TIMEOUT: Duration = Duration::from_secs(330);
const JULIA_EXECUTION_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const KERNEL_BUSY_ERROR: &str = "This language kernel is already executing a cell.";

fn channel_connect_timeout(language: RuntimeLanguage) -> Duration {
    if language == RuntimeLanguage::Julia {
        JULIA_CHANNEL_CONNECT_TIMEOUT
    } else {
        DEFAULT_CHANNEL_CONNECT_TIMEOUT
    }
}

fn startup_step_timeout(language: RuntimeLanguage) -> Duration {
    if language == RuntimeLanguage::Julia {
        JULIA_STARTUP_STEP_TIMEOUT
    } else {
        DEFAULT_STARTUP_STEP_TIMEOUT
    }
}

fn session_start_timeout(language: RuntimeLanguage) -> Duration {
    if language == RuntimeLanguage::Julia {
        JULIA_SESSION_START_TIMEOUT
    } else {
        DEFAULT_SESSION_START_TIMEOUT
    }
}

fn execution_timeout(language: RuntimeLanguage) -> Duration {
    if language == RuntimeLanguage::Julia {
        JULIA_EXECUTION_TIMEOUT
    } else {
        DEFAULT_EXECUTION_TIMEOUT
    }
}

fn timeout_description(timeout: Duration) -> String {
    if timeout.as_secs() % 60 == 0 {
        let minutes = timeout.as_secs() / 60;
        format!("{minutes} minute{}", if minutes == 1 { "" } else { "s" })
    } else {
        format!("{} seconds", timeout.as_secs())
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelExecutionRequest {
    pub root: String,
    pub cell_id: String,
    pub language: RuntimeLanguage,
    pub kernel_name: String,
    pub code: String,
    #[serde(default)]
    pub attributes: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub inputs: Vec<ExecutionInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum KernelExecutionMessage {
    Stream {
        sequence: u64,
        name: String,
        text: String,
    },
    Display {
        sequence: u64,
        data: serde_json::Map<String, serde_json::Value>,
        #[serde(default)]
        metadata: serde_json::Map<String, serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_id: Option<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        update: bool,
    },
    Error {
        sequence: u64,
        name: String,
        message: String,
        #[serde(default)]
        traceback: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum KernelExecutionStatus {
    Ok,
    Error,
    Interrupted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KernelExecutionResult {
    pub status: KernelExecutionStatus,
    pub messages: Vec<KernelExecutionMessage>,
    pub artifacts: Vec<ExecutionArtifact>,
    pub environment: ExecutionEnvironment,
    pub kernel_run_id: String,
    pub execution_count: Option<u64>,
    pub session_generation: u64,
    pub execution_sequence: u64,
}

#[derive(Clone)]
struct KernelLaunchConfig {
    root: PathBuf,
    language: RuntimeLanguage,
    kernel: JupyterKernelProbe,
    kernelspec: JupyterKernelspec,
}

struct NativeExecution {
    status: KernelExecutionStatus,
    messages: Vec<KernelExecutionMessage>,
    execution_count: Option<u64>,
    kernel_run_id: String,
    environment: ExecutionEnvironment,
    session_generation: u64,
    execution_sequence: u64,
    shutdown: bool,
}

enum KernelCommand {
    Execute {
        code: String,
        response: mpsc::SyncSender<Result<NativeExecution, String>>,
    },
    Interrupt {
        response: mpsc::SyncSender<Result<bool, String>>,
    },
    Restart {
        response: mpsc::SyncSender<Result<ExecutionEnvironment, String>>,
    },
    Shutdown {
        response: mpsc::SyncSender<Result<(), String>>,
    },
}

struct KernelReady {
    environment: ExecutionEnvironment,
    session_id: String,
}

struct KernelSession {
    root: PathBuf,
    kernel_name: String,
    session_id: String,
    sender: async_mpsc::UnboundedSender<KernelCommand>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    environment: Mutex<ExecutionEnvironment>,
}

#[derive(Default)]
struct KernelRegistryInner {
    sessions: Mutex<HashMap<RuntimeLanguage, Arc<KernelSession>>>,
}

impl Drop for KernelRegistryInner {
    fn drop(&mut self) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        for session in sessions.drain().map(|(_, session)| session) {
            terminate_session(&session);
        }
    }
}

#[derive(Clone, Default)]
pub struct KernelProcessRegistry {
    inner: Arc<KernelRegistryInner>,
}

fn integration(message: impl Into<String>) -> HostError {
    HostError::Integration(message.into())
}

fn registry_error() -> HostError {
    integration("The Jupyter-kernel registry is unavailable.")
}

fn worker_error(error: String) -> HostError {
    if error == KERNEL_BUSY_ERROR {
        HostError::Conflict(error)
    } else {
        integration(error)
    }
}

fn validate_kernel(
    kernel_name: &str,
    language: RuntimeLanguage,
) -> Result<JupyterKernelProbe, HostError> {
    let inventory = discover_jupyter_kernels_impl();
    let kernel = inventory
        .kernels
        .iter()
        .find(|kernel| kernel.name == kernel_name && kernel.language == Some(language))
        .ok_or_else(|| {
            integration(format!(
                "Jupyter kernel {kernel_name} was not found for the selected language. Refresh execution environments."
            ))
        })?;
    if kernel.health != RuntimeHealth::Available {
        return Err(integration(kernel.message.clone().unwrap_or_else(|| {
            format!("Jupyter kernel {kernel_name} is unavailable.")
        })));
    }
    Ok(kernel.clone())
}

fn load_kernelspec(kernel: &JupyterKernelProbe) -> Result<JupyterKernelspec, HostError> {
    let path = Path::new(&kernel.resource_dir).join("kernel.json");
    let bytes = fs::read(&path).map_err(|error| {
        integration(format!(
            "Could not read the selected Jupyter kernelspec {}: {error}",
            path.display()
        ))
    })?;
    let spec: JupyterKernelspec = serde_json::from_slice(&bytes).map_err(|error| {
        integration(format!(
            "Could not parse the selected Jupyter kernelspec {}: {error}",
            path.display()
        ))
    })?;
    if spec.argv.is_empty()
        || !spec
            .argv
            .iter()
            .any(|argument| argument == "{connection_file}")
    {
        return Err(integration(
            "The selected Jupyter kernelspec needs a non-empty argv and a {connection_file} placeholder.",
        ));
    }
    Ok(spec)
}

fn runtime_directory(root: &Path) -> Result<PathBuf, String> {
    let directory = root.join(".draftmatter").join("runtime");
    fs::create_dir_all(&directory).map_err(|error| {
        format!("Could not create DraftMatter's kernel runtime directory: {error}")
    })?;
    Ok(directory)
}

fn write_connection_file(path: &Path, connection: &ConnectionInfo) -> Result<(), String> {
    let bytes = serde_json::to_vec(connection)
        .map_err(|error| format!("Could not serialize Jupyter connection details: {error}"))?;
    fs::write(path, bytes)
        .map_err(|error| format!("Could not write the Jupyter connection file: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Could not secure the Jupyter connection file: {error}"))?;
    }
    Ok(())
}

fn kernel_command(config: &KernelLaunchConfig, connection_path: &Path) -> Result<Command, String> {
    let executable = config
        .kernelspec
        .argv
        .first()
        .ok_or_else(|| "The selected Jupyter kernelspec has no executable.".to_string())?;
    let mut command = Command::new(executable);
    if config.language == RuntimeLanguage::Julia {
        command
            .arg(JULIA_STARTUP_FILE_ARGUMENT)
            .arg(JULIA_PROJECT_ARGUMENT);
    }
    let mut skip_julia_option_value = false;
    for argument in &config.kernelspec.argv[1..] {
        if config.language == RuntimeLanguage::Julia {
            if skip_julia_option_value {
                skip_julia_option_value = false;
                continue;
            }
            if argument == "--project" || argument == "--startup-file" {
                skip_julia_option_value = true;
                continue;
            }
            if argument.starts_with("--project=") || argument.starts_with("--startup-file=") {
                continue;
            }
        }
        command.arg(if argument == "{connection_file}" {
            connection_path.as_os_str()
        } else {
            OsStr::new(argument)
        });
    }
    if let Some(environment) = &config.kernelspec.env {
        command.envs(environment);
    }
    configure_project_environment(&mut command, config.language, &config.root);
    command
        .current_dir(&config.root)
        .stdin(ProcessStdio::null())
        .stdout(ProcessStdio::piped())
        .stderr(ProcessStdio::piped());
    Ok(command)
}

#[derive(Default)]
struct BoundedProcessOutput {
    bytes: Vec<u8>,
}

impl BoundedProcessOutput {
    fn push(&mut self, bytes: &[u8]) {
        if bytes.len() >= MAX_KERNEL_PROCESS_OUTPUT_BYTES {
            self.bytes.clear();
            self.bytes.extend_from_slice(
                &bytes[bytes.len().saturating_sub(MAX_KERNEL_PROCESS_OUTPUT_BYTES)..],
            );
            return;
        }
        let excess = self
            .bytes
            .len()
            .saturating_add(bytes.len())
            .saturating_sub(MAX_KERNEL_PROCESS_OUTPUT_BYTES);
        if excess > 0 {
            self.bytes.drain(..excess);
        }
        self.bytes.extend_from_slice(bytes);
    }
}

struct KernelProcessOutput {
    stdout: Arc<Mutex<BoundedProcessOutput>>,
    stderr: Arc<Mutex<BoundedProcessOutput>>,
    stdout_reader: Option<thread::JoinHandle<()>>,
    stderr_reader: Option<thread::JoinHandle<()>>,
}

impl KernelProcessOutput {
    fn capture(child: &mut Child) -> Self {
        let stdout = Arc::new(Mutex::new(BoundedProcessOutput::default()));
        let stderr = Arc::new(Mutex::new(BoundedProcessOutput::default()));
        let stdout_reader = child.stdout.take().map(|reader| {
            let output = Arc::clone(&stdout);
            thread::spawn(move || drain_kernel_process_output(reader, output))
        });
        let stderr_reader = child.stderr.take().map(|reader| {
            let output = Arc::clone(&stderr);
            thread::spawn(move || drain_kernel_process_output(reader, output))
        });
        Self {
            stdout,
            stderr,
            stdout_reader,
            stderr_reader,
        }
    }

    fn finish(&mut self) {
        if let Some(reader) = self.stdout_reader.take() {
            let _ = reader.join();
        }
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
    }

    fn diagnostic(&self) -> Option<String> {
        let stderr = self
            .stderr
            .lock()
            .ok()
            .map(|output| output.bytes.clone())
            .unwrap_or_default();
        let stdout = self
            .stdout
            .lock()
            .ok()
            .map(|output| output.bytes.clone())
            .unwrap_or_default();
        readable_kernel_diagnostic(if stderr.is_empty() { &stdout } else { &stderr })
    }
}

fn drain_kernel_process_output(mut reader: impl Read, output: Arc<Mutex<BoundedProcessOutput>>) {
    let mut buffer = [0_u8; 8192];
    loop {
        let Ok(read) = reader.read(&mut buffer) else {
            break;
        };
        if read == 0 {
            break;
        }
        let Ok(mut output) = output.lock() else {
            break;
        };
        output.push(&buffer[..read]);
    }
}

fn strip_terminal_escapes(value: &str) -> String {
    let mut cleaned = String::with_capacity(value.len());
    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        if character != '\u{1b}' {
            if character == '\n' || character == '\t' || !character.is_control() {
                cleaned.push(character);
            }
            continue;
        }
        match characters.next() {
            Some('[') => {
                for control in characters.by_ref() {
                    if ('@'..='~').contains(&control) {
                        break;
                    }
                }
            }
            Some(']') => {
                let mut previous_escape = false;
                for control in characters.by_ref() {
                    if control == '\u{7}' || (previous_escape && control == '\\') {
                        break;
                    }
                    previous_escape = control == '\u{1b}';
                }
            }
            Some(_) | None => {}
        }
    }
    cleaned
}

fn readable_kernel_diagnostic(bytes: &[u8]) -> Option<String> {
    let cleaned = strip_terminal_escapes(&String::from_utf8_lossy(bytes)).replace('\r', "");
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return None;
    }
    let characters = cleaned.chars().count();
    if characters <= MAX_KERNEL_STARTUP_DIAGNOSTIC_CHARS {
        return Some(cleaned.to_string());
    }
    let tail = cleaned
        .chars()
        .skip(characters - MAX_KERNEL_STARTUP_DIAGNOSTIC_CHARS)
        .collect::<String>();
    Some(format!("…{}", tail.trim_start()))
}

fn exited_before_iopub(
    status: std::process::ExitStatus,
    output: &mut KernelProcessOutput,
) -> String {
    output.finish();
    let summary = format!("The Jupyter kernel process exited before opening IOPub ({status}).");
    match output.diagnostic() {
        Some(diagnostic) => format!("{summary}\n\nKernel startup output:\n{diagnostic}"),
        None => summary,
    }
}

fn cleanup_failed_launch(child: &mut Child, connection_path: &Path) {
    let _ = child.kill();
    let _ = child.wait();
    let _ = fs::remove_file(connection_path);
}

async fn open_iopub_channel(
    connection_info: &ConnectionInfo,
    topic: &str,
    session_id: &str,
    language: RuntimeLanguage,
    child: &mut Child,
    output: &mut KernelProcessOutput,
) -> Result<ClientIoPubConnection, String> {
    let endpoint = connection_info.iopub_url();
    let mut options = zeromq::SocketOptions::default();
    options.connect_timeout(channel_connect_timeout(language));
    let mut socket = zeromq::SubSocket::with_options(options);
    socket
        .subscribe(topic)
        .await
        .map_err(|error| error.to_string())?;
    {
        let connection = socket.connect(&endpoint);
        tokio::pin!(connection);

        loop {
            tokio::select! {
                result = &mut connection => {
                    match result {
                        Ok(()) => break,
                        Err(error) => {
                            if let Some(status) = child.try_wait().map_err(|inspect_error| {
                                format!("Could not inspect the Jupyter kernel process: {inspect_error}")
                            })? {
                                return Err(exited_before_iopub(status, output));
                            }
                            return Err(error.to_string());
                        }
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(250)) => {
                    if let Some(status) = child.try_wait().map_err(|error| {
                        format!("Could not inspect the Jupyter kernel process: {error}")
                    })? {
                        return Err(exited_before_iopub(status, output));
                    }
                }
            }
        }
    }
    Ok(Connection::new(socket, &connection_info.key, session_id))
}

fn parent_matches(message: &JupyterMessage, parent_id: &str) -> bool {
    message
        .parent_header
        .as_ref()
        .map(|header| header.msg_id.as_str())
        == Some(parent_id)
}

fn media_map(media: &Media) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    serde_json::to_value(media)
        .map_err(|error| format!("Could not normalize a kernel MIME bundle: {error}"))?
        .as_object()
        .cloned()
        .ok_or_else(|| "The kernel returned a MIME bundle that was not an object.".to_string())
}

fn execution_count(value: ExecutionCount) -> Option<u64> {
    u64::try_from(value.value()).ok()
}

fn push_reply_error(messages: &mut Vec<KernelExecutionMessage>, reply: &ExecuteReply) {
    let Some(error) = &reply.error else {
        return;
    };
    if messages.iter().any(|message| {
        matches!(message, KernelExecutionMessage::Error { name, message, .. }
            if name == &error.ename && message == &error.evalue)
    }) {
        return;
    }
    messages.push(KernelExecutionMessage::Error {
        sequence: messages.len() as u64,
        name: error.ename.clone(),
        message: error.evalue.clone(),
        traceback: error.traceback.clone(),
    });
}

struct NativeKernel {
    config: KernelLaunchConfig,
    child: Child,
    process_output: KernelProcessOutput,
    connection_path: PathBuf,
    shell: ClientShellConnection,
    iopub: ClientIoPubConnection,
    control: ClientControlConnection,
    environment: ExecutionEnvironment,
    session_id: String,
    generation: u64,
    execution_sequence: u64,
    stopped: bool,
}

impl NativeKernel {
    async fn launch(
        config: KernelLaunchConfig,
        generation: u64,
        commands: &mut async_mpsc::UnboundedReceiver<KernelCommand>,
    ) -> Result<Self, String> {
        let ip = std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);
        let (ports, listeners) = peek_ports_with_listeners(ip, 5)
            .await
            .map_err(|error| format!("Could not reserve ports for the Jupyter kernel: {error}"))?;
        let session_id = Uuid::new_v4().to_string();
        let connection = ConnectionInfo {
            ip: ip.to_string(),
            transport: Transport::TCP,
            stdin_port: ports[0],
            control_port: ports[1],
            hb_port: ports[2],
            shell_port: ports[3],
            iopub_port: ports[4],
            key: Uuid::new_v4().to_string(),
            signature_scheme: "hmac-sha256".to_string(),
            kernel_name: Some(config.kernel.name.clone()),
        };
        let connection_path =
            runtime_directory(&config.root)?.join(format!("kernel-{}.json", Uuid::new_v4()));
        write_connection_file(&connection_path, &connection)?;
        let mut command = kernel_command(&config, &connection_path)?;
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let _ = fs::remove_file(&connection_path);
                return Err(format!(
                    "Could not start the selected Jupyter kernel: {error}"
                ));
            }
        };
        let mut process_output = KernelProcessOutput::capture(&mut child);
        drop(listeners);

        let iopub = match open_iopub_channel(
            &connection,
            "",
            &session_id,
            config.language,
            &mut child,
            &mut process_output,
        )
        .await
        {
            Ok(connection) => connection,
            Err(error) => {
                cleanup_failed_launch(&mut child, &connection_path);
                process_output.finish();
                return Err(format!("Could not open the Jupyter IOPub channel: {error}"));
            }
        };
        let identity = match peer_identity_for_session(&session_id) {
            Ok(identity) => identity,
            Err(error) => {
                cleanup_failed_launch(&mut child, &connection_path);
                process_output.finish();
                return Err(format!(
                    "Could not create the Jupyter client identity: {error}"
                ));
            }
        };
        let shell =
            match create_client_shell_connection_with_identity(&connection, &session_id, identity)
                .await
            {
                Ok(connection) => connection,
                Err(error) => {
                    cleanup_failed_launch(&mut child, &connection_path);
                    process_output.finish();
                    return Err(format!("Could not open the Jupyter shell channel: {error}"));
                }
            };
        let control = match create_client_control_connection(&connection, &session_id).await {
            Ok(connection) => connection,
            Err(error) => {
                cleanup_failed_launch(&mut child, &connection_path);
                process_output.finish();
                return Err(format!(
                    "Could not open the Jupyter control channel: {error}"
                ));
            }
        };

        let mut kernel = Self {
            config,
            child,
            process_output,
            connection_path,
            shell,
            iopub,
            control,
            environment: ExecutionEnvironment {
                identity: String::new(),
                version: None,
                details: BTreeMap::new(),
            },
            session_id,
            generation,
            execution_sequence: 0,
            stopped: false,
        };
        let info = kernel.kernel_info().await?;
        kernel.environment = kernel.environment_from_info(&info);
        let helper = publishing_helper(kernel.config.language).to_string();
        let startup_timeout = startup_step_timeout(kernel.config.language);
        let helper_result = kernel
            .execute_protocol(helper, false, commands, false, startup_timeout)
            .await?;
        if helper_result.status != KernelExecutionStatus::Ok {
            let message = helper_result
                .messages
                .iter()
                .find_map(|message| match message {
                    KernelExecutionMessage::Error { message, .. } => Some(message.clone()),
                    _ => None,
                })
                .unwrap_or_else(|| "the kernel rejected the helper definition".to_string());
            kernel.stop_now().await;
            return Err(format!(
                "Could not inject DraftMatter's publishing helper into the selected kernel: {message}"
            ));
        }
        Ok(kernel)
    }

    fn environment_from_info(&self, info: &KernelInfoReply) -> ExecutionEnvironment {
        let mut details = BTreeMap::from([
            ("mode".to_string(), "interactive-kernel".to_string()),
            ("kernel".to_string(), self.config.kernel.name.clone()),
            (
                "implementation".to_string(),
                if info.implementation.is_empty() {
                    "jupyter".to_string()
                } else {
                    info.implementation.clone()
                },
            ),
            ("language".to_string(), info.language_info.name.clone()),
            ("client".to_string(), "bundled-native-zmq".to_string()),
        ]);
        if self.config.language == RuntimeLanguage::Julia {
            details.insert(
                "project".to_string(),
                self.config.root.to_string_lossy().into_owned(),
            );
        }
        ExecutionEnvironment {
            identity: self.config.kernel.name.clone(),
            version: (!info.language_info.version.is_empty())
                .then(|| info.language_info.version.clone()),
            details,
        }
    }

    async fn kernel_info(&mut self) -> Result<KernelInfoReply, String> {
        let timeout = startup_step_timeout(self.config.language);
        let request: JupyterMessage = KernelInfoRequest::default().into();
        let request_id = request.header.msg_id.clone();
        self.shell
            .send(request)
            .await
            .map_err(|error| format!("Could not request Jupyter kernel information: {error}"))?;
        tokio::time::timeout(timeout, async {
            loop {
                let message = self.shell.read().await.map_err(|error| {
                    format!("Could not read Jupyter kernel information: {error}")
                })?;
                if !parent_matches(&message, &request_id) {
                    continue;
                }
                if let JupyterMessageContent::KernelInfoReply(reply) = message.content {
                    if reply.status == ReplyStatus::Error {
                        let message = reply
                            .error
                            .as_ref()
                            .map(|error| error.evalue.clone())
                            .unwrap_or_else(|| {
                                "the kernel rejected kernel_info_request".to_string()
                            });
                        return Err(format!(
                            "The Jupyter kernel did not become ready: {message}"
                        ));
                    }
                    return Ok(*reply);
                }
            }
        })
        .await
        .map_err(|_| {
            format!(
                "The Jupyter kernel did not become ready within {}.",
                timeout_description(timeout)
            )
        })?
    }

    async fn execute_protocol(
        &mut self,
        code: String,
        store_history: bool,
        commands: &mut async_mpsc::UnboundedReceiver<KernelCommand>,
        count_sequence: bool,
        timeout: Duration,
    ) -> Result<NativeExecution, String> {
        if count_sequence {
            self.execution_sequence += 1;
        }
        let request: JupyterMessage = ExecuteRequest {
            code,
            silent: false,
            store_history,
            user_expressions: None,
            allow_stdin: false,
            stop_on_error: false,
        }
        .into();
        let request_id = request.header.msg_id.clone();
        self.shell
            .send(request)
            .await
            .map_err(|error| format!("Could not send code to the Jupyter kernel: {error}"))?;

        let mut messages = Vec::new();
        let mut sequence = 0_u64;
        let mut count = None;
        let mut shell_status = None;
        let mut shell_complete = false;
        let mut idle = false;
        let mut clear_on_next = false;
        let mut interrupted = false;
        let mut shutdown = false;

        let execution = tokio::time::timeout(timeout, async {
            while !shell_complete || !idle {
                tokio::select! {
                    iopub = self.iopub.read(), if !idle => {
                        let message = iopub.map_err(|error| format!("Could not read Jupyter kernel output: {error}"))?;
                        if !parent_matches(&message, &request_id) {
                            continue;
                        }
                        match message.content {
                            JupyterMessageContent::Status(status) if status.execution_state == ExecutionState::Idle => idle = true,
                            JupyterMessageContent::ClearOutput(ClearOutput { wait }) => {
                                if wait { clear_on_next = true; } else { messages.clear(); }
                            }
                            JupyterMessageContent::StreamContent(stream) => {
                                if clear_on_next { messages.clear(); clear_on_next = false; }
                                messages.push(KernelExecutionMessage::Stream {
                                    sequence,
                                    name: match stream.name { Stdio::Stderr => "stderr", Stdio::Stdout => "stdout" }.to_string(),
                                    text: stream.text,
                                });
                                sequence += 1;
                            }
                            JupyterMessageContent::DisplayData(display) => {
                                if clear_on_next { messages.clear(); clear_on_next = false; }
                                messages.push(KernelExecutionMessage::Display {
                                    sequence,
                                    data: media_map(&display.data)?,
                                    metadata: display.metadata,
                                    display_id: display.transient.and_then(|value| value.display_id),
                                    update: false,
                                });
                                sequence += 1;
                            }
                            JupyterMessageContent::UpdateDisplayData(display) => {
                                if clear_on_next { messages.clear(); clear_on_next = false; }
                                messages.push(KernelExecutionMessage::Display {
                                    sequence,
                                    data: media_map(&display.data)?,
                                    metadata: display.metadata,
                                    display_id: display.transient.display_id,
                                    update: true,
                                });
                                sequence += 1;
                            }
                            JupyterMessageContent::ExecuteResult(result) => {
                                if clear_on_next { messages.clear(); clear_on_next = false; }
                                count = execution_count(result.execution_count);
                                messages.push(KernelExecutionMessage::Display {
                                    sequence,
                                    data: media_map(&result.data)?,
                                    metadata: result.metadata,
                                    display_id: result.transient.and_then(|value| value.display_id),
                                    update: false,
                                });
                                sequence += 1;
                            }
                            JupyterMessageContent::ExecuteInput(input) => {
                                count = execution_count(input.execution_count);
                            }
                            JupyterMessageContent::ErrorOutput(error) => {
                                if clear_on_next { messages.clear(); clear_on_next = false; }
                                messages.push(KernelExecutionMessage::Error {
                                    sequence,
                                    name: error.ename,
                                    message: error.evalue,
                                    traceback: error.traceback,
                                });
                                sequence += 1;
                            }
                            _ => {}
                        }
                    }
                    shell = self.shell.read(), if !shell_complete => {
                        let message = shell.map_err(|error| format!("Could not read the Jupyter execution reply: {error}"))?;
                        if !parent_matches(&message, &request_id) {
                            continue;
                        }
                        if let JupyterMessageContent::ExecuteReply(reply) = message.content {
                            count = execution_count(reply.execution_count).or(count);
                            shell_status = Some(reply.status.clone());
                            push_reply_error(&mut messages, &reply);
                            shell_complete = true;
                        }
                    }
                    command = commands.recv() => {
                        let Some(command) = command else {
                            self.stop_now().await;
                            shutdown = true;
                            interrupted = true;
                            break;
                        };
                        match command {
                            KernelCommand::Interrupt { response } => {
                                let result = self.interrupt_now().await;
                                if result.is_ok() { interrupted = true; }
                                let _ = response.send(result.map(|_| true));
                            }
                            KernelCommand::Shutdown { response } => {
                                self.stop_now().await;
                                shutdown = true;
                                interrupted = true;
                                let _ = response.send(Ok(()));
                                break;
                            }
                            KernelCommand::Restart { response } => {
                                let _ = response.send(Err("Wait for the active kernel execution to settle before restarting it.".to_string()));
                            }
                            KernelCommand::Execute { response, .. } => {
                                let _ = response.send(Err(KERNEL_BUSY_ERROR.to_string()));
                            }
                        }
                    }
                }
            }
            Ok::<(), String>(())
        })
        .await;

        match execution {
            Ok(result) => result?,
            Err(_) => {
                return Err(format!(
                    "The Jupyter kernel did not become idle within {}.",
                    timeout_description(timeout)
                ))
            }
        }
        if serde_json::to_vec(&messages)
            .map_err(|error| format!("Could not measure normalized kernel output: {error}"))?
            .len()
            > MAX_KERNEL_RESPONSE_BYTES
        {
            return Err("The Jupyter kernel response exceeded the 16 MB safety limit.".to_string());
        }
        let status = if interrupted {
            KernelExecutionStatus::Interrupted
        } else if shell_status == Some(ReplyStatus::Ok)
            && !messages
                .iter()
                .any(|message| matches!(message, KernelExecutionMessage::Error { .. }))
        {
            KernelExecutionStatus::Ok
        } else {
            KernelExecutionStatus::Error
        };
        Ok(NativeExecution {
            status,
            messages,
            execution_count: count,
            kernel_run_id: format!("kernel:{}:{}", self.session_id, request_id),
            environment: self.environment.clone(),
            session_generation: self.generation,
            execution_sequence: self.execution_sequence,
            shutdown,
        })
    }

    async fn interrupt_now(&mut self) -> Result<(), String> {
        let message_interrupt = self
            .config
            .kernelspec
            .interrupt_mode
            .as_deref()
            .is_some_and(|mode| mode.eq_ignore_ascii_case("message"));
        #[cfg(unix)]
        if !message_interrupt {
            let result = unsafe { libc::kill(self.child.id() as i32, libc::SIGINT) };
            if result == 0 {
                return Ok(());
            }
            return Err(format!(
                "Could not interrupt the Jupyter kernel process: {}",
                std::io::Error::last_os_error()
            ));
        }
        #[cfg(not(unix))]
        let _ = message_interrupt;
        let request: JupyterMessage = InterruptRequest::default().into();
        tokio::time::timeout(Duration::from_secs(5), self.control.send(request))
            .await
            .map_err(|_| "The Jupyter interrupt request timed out.".to_string())?
            .map_err(|error| format!("Could not send the Jupyter interrupt request: {error}"))
    }

    async fn stop_now(&mut self) {
        if self.stopped {
            return;
        }
        let request: JupyterMessage = ShutdownRequest { restart: false }.into();
        let _ = tokio::time::timeout(Duration::from_secs(2), self.control.send(request)).await;
        let started = Instant::now();
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() < Duration::from_secs(2) => {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                _ => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break;
                }
            }
        }
        let _ = fs::remove_file(&self.connection_path);
        self.process_output.finish();
        self.stopped = true;
    }
}

impl Drop for NativeKernel {
    fn drop(&mut self) {
        if !self.stopped {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        self.process_output.finish();
        let _ = fs::remove_file(&self.connection_path);
    }
}

fn kernel_worker(
    config: KernelLaunchConfig,
    mut commands: async_mpsc::UnboundedReceiver<KernelCommand>,
    startup: mpsc::SyncSender<Result<KernelReady, String>>,
) {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = startup.send(Err(format!(
                "Could not initialize DraftMatter's bundled Jupyter client: {error}"
            )));
            return;
        }
    };
    runtime.block_on(async move {
        let mut generation = 1_u64;
        let mut kernel = match NativeKernel::launch(config.clone(), generation, &mut commands).await
        {
            Ok(kernel) => kernel,
            Err(error) => {
                let _ = startup.send(Err(error));
                return;
            }
        };
        let _ = startup.send(Ok(KernelReady {
            environment: kernel.environment.clone(),
            session_id: kernel.session_id.clone(),
        }));

        while let Some(command) = commands.recv().await {
            match command {
                KernelCommand::Execute { code, response } => {
                    let timeout = execution_timeout(kernel.config.language);
                    let result = kernel
                        .execute_protocol(code, true, &mut commands, true, timeout)
                        .await;
                    let shutdown = result
                        .as_ref()
                        .map(|result| result.shutdown)
                        .unwrap_or(false);
                    let _ = response.send(result);
                    if shutdown {
                        return;
                    }
                }
                KernelCommand::Interrupt { response } => {
                    let result = kernel.interrupt_now().await.map(|_| true);
                    let _ = response.send(result);
                }
                KernelCommand::Restart { response } => {
                    kernel.stop_now().await;
                    generation += 1;
                    match NativeKernel::launch(config.clone(), generation, &mut commands).await {
                        Ok(restarted) => {
                            kernel = restarted;
                            let _ = response.send(Ok(kernel.environment.clone()));
                        }
                        Err(error) => {
                            let _ = response.send(Err(error));
                            return;
                        }
                    }
                }
                KernelCommand::Shutdown { response } => {
                    kernel.stop_now().await;
                    let _ = response.send(Ok(()));
                    return;
                }
            }
        }
        kernel.stop_now().await;
    });
}

fn start_session(
    root: &Path,
    kernel: &JupyterKernelProbe,
) -> Result<Arc<KernelSession>, HostError> {
    let language = kernel.language.unwrap_or(RuntimeLanguage::Python);
    let timeout = session_start_timeout(language);
    let config = KernelLaunchConfig {
        root: root.to_path_buf(),
        language,
        kernel: kernel.clone(),
        kernelspec: load_kernelspec(kernel)?,
    };
    let (sender, receiver) = async_mpsc::unbounded_channel();
    let (startup_sender, startup_receiver) = mpsc::sync_channel(1);
    let worker = thread::Builder::new()
        .name(format!("draftmatter-{}-kernel", kernel.name))
        .spawn(move || kernel_worker(config, receiver, startup_sender))
        .map_err(|error| {
            integration(format!(
                "Could not start the Jupyter client worker: {error}"
            ))
        })?;
    let ready = startup_receiver
        .recv_timeout(timeout)
        .map_err(|_| {
            integration(format!(
                "The Jupyter kernel did not start within {}.",
                timeout_description(timeout)
            ))
        })?
        .map_err(worker_error)?;
    Ok(Arc::new(KernelSession {
        root: root.to_path_buf(),
        kernel_name: kernel.name.clone(),
        session_id: ready.session_id,
        sender,
        worker: Mutex::new(Some(worker)),
        environment: Mutex::new(ready.environment),
    }))
}

fn request_worker<T>(
    session: &KernelSession,
    timeout: Duration,
    command: impl FnOnce(mpsc::SyncSender<Result<T, String>>) -> KernelCommand,
) -> Result<T, HostError> {
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    session
        .sender
        .send(command(response_sender))
        .map_err(|_| integration("The selected Jupyter kernel session is no longer running."))?;
    response_receiver
        .recv_timeout(timeout)
        .map_err(|_| integration("The Jupyter kernel command timed out."))?
        .map_err(worker_error)
}

fn terminate_session(session: &KernelSession) {
    let _: Result<(), _> = request_worker(session, Duration::from_secs(8), |response| {
        KernelCommand::Shutdown { response }
    });
    if let Ok(mut worker) = session.worker.lock() {
        if let Some(worker) = worker.take() {
            let _ = worker.join();
        }
    }
}

fn session_for(
    root: &Path,
    language: RuntimeLanguage,
    kernel: &JupyterKernelProbe,
    registry: &KernelProcessRegistry,
) -> Result<Arc<KernelSession>, HostError> {
    let existing = registry
        .inner
        .sessions
        .lock()
        .map_err(|_| registry_error())?
        .get(&language)
        .cloned();
    if let Some(session) = existing {
        if session.root == root && session.kernel_name == kernel.name {
            return Ok(session);
        }
        registry
            .inner
            .sessions
            .lock()
            .map_err(|_| registry_error())?
            .remove(&language);
        terminate_session(&session);
    }
    let session = start_session(root, kernel)?;
    registry
        .inner
        .sessions
        .lock()
        .map_err(|_| registry_error())?
        .insert(language, session.clone());
    Ok(session)
}

fn remove_session(
    language: RuntimeLanguage,
    registry: &KernelProcessRegistry,
) -> Result<Option<Arc<KernelSession>>, HostError> {
    Ok(registry
        .inner
        .sessions
        .lock()
        .map_err(|_| registry_error())?
        .remove(&language))
}

pub fn execute_kernel_impl(
    request: KernelExecutionRequest,
    trust: &ExecutionTrustStore,
    registry: &KernelProcessRegistry,
) -> Result<KernelExecutionResult, HostError> {
    let timeout = execution_timeout(request.language);
    if !valid_cell_id(&request.cell_id) {
        return Err(HostError::InvalidProject(
            "Executable cell IDs may contain only letters, numbers, dots, colons, dashes, and underscores."
                .to_string(),
        ));
    }
    if request.code.len() > MAX_CODE_BYTES {
        return Err(HostError::UnsupportedFile(
            "Executable cell source exceeds the 2 MB safety limit.".to_string(),
        ));
    }
    let root = canonical_root(&request.root)?;
    require_execution_trust(&root, trust)?;
    let kernel = validate_kernel(&request.kernel_name, request.language)?;
    verify_inputs(&root, &request.inputs)?;
    let artifacts = declared_artifacts(&root, &request.attributes)?;
    let run_directory = create_run_directory(&root, &request.cell_id)?;
    let backups = prepare_artifact_backups(&artifacts, &run_directory.0)?;
    let session = match session_for(&root, request.language, &kernel, registry) {
        Ok(session) => session,
        Err(error) => {
            restore_artifacts(&backups)?;
            return Err(error);
        }
    };
    let mut response =
        match request_worker(&session, timeout + Duration::from_secs(5), |response| {
            KernelCommand::Execute {
                code: request.code,
                response,
            }
        }) {
            Ok(response) => response,
            Err(error) => {
                restore_artifacts(&backups)?;
                if !matches!(error, HostError::Conflict(_)) {
                    if let Some(removed) = remove_session(request.language, registry)? {
                        terminate_session(&removed);
                    }
                }
                return Err(error);
            }
        };
    *session.environment.lock().map_err(|_| registry_error())? = response.environment.clone();
    let mut produced = Vec::new();
    if response.status == KernelExecutionStatus::Ok {
        match collect_artifacts(&artifacts) {
            Ok(artifacts) => produced = artifacts,
            Err(error) => {
                response.messages.push(KernelExecutionMessage::Error {
                    sequence: response.messages.len() as u64,
                    name: error.name,
                    message: error.message,
                    traceback: error.traceback,
                });
                response.status = KernelExecutionStatus::Error;
            }
        }
    }
    if response.status != KernelExecutionStatus::Ok {
        restore_artifacts(&backups)?;
    }
    Ok(KernelExecutionResult {
        status: response.status,
        messages: response.messages,
        artifacts: produced,
        environment: response.environment,
        kernel_run_id: if response.kernel_run_id.is_empty() {
            format!(
                "kernel:{}:{}:{}",
                session.session_id,
                now_millis(),
                request.cell_id
            )
        } else {
            response.kernel_run_id
        },
        execution_count: response.execution_count,
        session_generation: response.session_generation,
        execution_sequence: response.execution_sequence,
    })
}

pub fn interrupt_kernel_impl(
    language: RuntimeLanguage,
    registry: &KernelProcessRegistry,
) -> Result<bool, HostError> {
    let session = registry
        .inner
        .sessions
        .lock()
        .map_err(|_| registry_error())?
        .get(&language)
        .cloned();
    let Some(session) = session else {
        return Ok(false);
    };
    request_worker(&session, LIFECYCLE_TIMEOUT, |response| {
        KernelCommand::Interrupt { response }
    })
}

pub fn restart_kernel_impl(
    language: RuntimeLanguage,
    registry: &KernelProcessRegistry,
) -> Result<bool, HostError> {
    let session = registry
        .inner
        .sessions
        .lock()
        .map_err(|_| registry_error())?
        .get(&language)
        .cloned();
    let Some(session) = session else {
        return Ok(false);
    };
    let environment = request_worker(&session, session_start_timeout(language), |response| {
        KernelCommand::Restart { response }
    })?;
    *session.environment.lock().map_err(|_| registry_error())? = environment;
    Ok(true)
}

pub fn terminate_kernel_impl(
    language: RuntimeLanguage,
    registry: &KernelProcessRegistry,
) -> Result<bool, HostError> {
    let Some(session) = remove_session(language, registry)? else {
        return Ok(false);
    };
    terminate_session(&session);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution_trust::{
        trust_project_for_session_impl, ExecutionTrustStore, TRUST_ACKNOWLEDGEMENT,
    };
    use crate::jupyter_publishing::PUBLISHED_VALUE_MIME;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn serializes_kernel_messages_to_the_normalized_transport_shape() {
        let message = KernelExecutionMessage::Display {
            sequence: 2,
            data: serde_json::Map::from_iter([(
                "text/plain".to_string(),
                serde_json::Value::String("42".to_string()),
            )]),
            metadata: serde_json::Map::new(),
            display_id: None,
            update: false,
        };
        assert_eq!(
            serde_json::to_value(message).unwrap(),
            serde_json::json!({"kind":"display","sequence":2,"data":{"text/plain":"42"},"metadata":{}})
        );
    }

    #[test]
    fn lifecycle_commands_are_idempotent_without_a_started_session() {
        let registry = KernelProcessRegistry::default();
        assert!(!interrupt_kernel_impl(RuntimeLanguage::Python, &registry).unwrap());
        assert!(!restart_kernel_impl(RuntimeLanguage::R, &registry).unwrap());
        assert!(!terminate_kernel_impl(RuntimeLanguage::Julia, &registry).unwrap());
    }

    #[test]
    fn julia_gets_compilation_aware_kernel_timeouts() {
        assert_eq!(
            channel_connect_timeout(RuntimeLanguage::Julia),
            Duration::from_secs(10 * 60)
        );
        assert_eq!(
            startup_step_timeout(RuntimeLanguage::Julia),
            Duration::from_secs(2 * 60)
        );
        assert_eq!(
            session_start_timeout(RuntimeLanguage::Julia),
            Duration::from_secs(15 * 60)
        );
        assert_eq!(
            execution_timeout(RuntimeLanguage::Julia),
            Duration::from_secs(30 * 60)
        );
        assert_eq!(
            channel_connect_timeout(RuntimeLanguage::Python),
            DEFAULT_CHANNEL_CONNECT_TIMEOUT
        );
        assert_eq!(
            execution_timeout(RuntimeLanguage::R),
            DEFAULT_EXECUTION_TIMEOUT
        );
        assert_eq!(timeout_description(JULIA_EXECUTION_TIMEOUT), "30 minutes");
    }

    #[test]
    fn a_busy_language_lane_is_a_recoverable_conflict() {
        assert!(matches!(
            worker_error(KERNEL_BUSY_ERROR.to_string()),
            HostError::Conflict(message) if message == KERNEL_BUSY_ERROR
        ));
    }

    #[test]
    fn kernel_specs_must_accept_a_connection_file() {
        let temporary = tempdir().unwrap();
        fs::write(
            temporary.path().join("kernel.json"),
            r#"{"argv":["python"],"display_name":"Broken","language":"python"}"#,
        )
        .unwrap();
        let probe = JupyterKernelProbe {
            name: "broken".to_string(),
            display_name: "Broken".to_string(),
            language: Some(RuntimeLanguage::Python),
            health: RuntimeHealth::Available,
            resource_dir: temporary.path().to_string_lossy().into_owned(),
            executable: Some("python".to_string()),
            message: None,
        };
        assert!(load_kernelspec(&probe).is_err());
    }

    #[test]
    fn julia_kernel_launch_forces_the_open_project() {
        let temporary = tempdir().unwrap();
        let root = fs::canonicalize(temporary.path()).unwrap();
        let kernelspec = serde_json::from_str::<JupyterKernelspec>(
            r#"{"argv":["julia","--startup-file=yes","--project=@.","-i","--project","/global","--startup-file","yes","{connection_file}"],"display_name":"Julia fixture","language":"julia"}"#,
        )
        .unwrap();
        let config = KernelLaunchConfig {
            root: root.clone(),
            language: RuntimeLanguage::Julia,
            kernel: JupyterKernelProbe {
                name: "julia-fixture".to_string(),
                display_name: "Julia fixture".to_string(),
                language: Some(RuntimeLanguage::Julia),
                health: RuntimeHealth::Available,
                resource_dir: root.to_string_lossy().into_owned(),
                executable: Some("julia".to_string()),
                message: None,
            },
            kernelspec,
        };
        let command = kernel_command(&config, &root.join("connection.json")).unwrap();
        let arguments = command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let julia_project = command
            .get_envs()
            .find(|(name, _)| *name == OsStr::new("JULIA_PROJECT"))
            .and_then(|(_, value)| value);

        assert_eq!(
            arguments.first().map(String::as_str),
            Some("--startup-file=no")
        );
        assert_eq!(arguments.get(1).map(String::as_str), Some("--project=."));
        assert_eq!(
            arguments
                .iter()
                .filter(|argument| argument.starts_with("--project"))
                .count(),
            1
        );
        assert_eq!(
            arguments
                .iter()
                .filter(|argument| argument.starts_with("--startup-file"))
                .count(),
            1
        );
        assert_eq!(julia_project, Some(root.as_os_str()));
        assert_eq!(command.get_current_dir(), Some(root.as_path()));
    }

    #[test]
    fn kernel_startup_diagnostics_are_readable_and_keep_the_runtime_error() {
        let diagnostic = readable_kernel_diagnostic(
            b"\x1b[31mERROR:\x1b[0m ArgumentError: Package IJulia not found in current path.\r\n",
        )
        .unwrap();

        assert_eq!(
            diagnostic,
            "ERROR: ArgumentError: Package IJulia not found in current path."
        );
        assert!(!diagnostic.contains('\u{1b}'));
    }

    #[test]
    fn bounded_kernel_output_retains_the_latest_diagnostic() {
        let mut output = BoundedProcessOutput::default();
        output.push(&vec![b'x'; MAX_KERNEL_PROCESS_OUTPUT_BYTES]);
        output.push(b"ERROR: final startup failure");

        assert_eq!(output.bytes.len(), MAX_KERNEL_PROCESS_OUTPUT_BYTES);
        assert!(output.bytes.ends_with(b"ERROR: final startup failure"));
    }

    #[test]
    fn executes_through_an_installed_python_kernel_and_preserves_session_state() {
        let inventory = discover_jupyter_kernels_impl();
        let Some(kernel) = inventory.kernels.iter().find(|kernel| {
            kernel.language == Some(RuntimeLanguage::Python)
                && kernel.health == RuntimeHealth::Available
        }) else {
            return;
        };
        let project = tempdir().unwrap();
        let root = fs::canonicalize(project.path()).unwrap();
        let trust = ExecutionTrustStore::default();
        trust_project_for_session_impl(root.to_str().unwrap(), TRUST_ACKNOWLEDGEMENT, &trust)
            .unwrap();
        let registry = KernelProcessRegistry::default();
        let first = KernelExecutionRequest {
            root: root.to_string_lossy().into_owned(),
            cell_id: "kernel-first".to_string(),
            language: RuntimeLanguage::Python,
            kernel_name: kernel.name.clone(),
            code: r#"from pathlib import Path
shared_value = 41
path = Path("figures/kernel-result.txt")
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text("kernel artifact", encoding="utf-8")
print("kernel-ready")
publish("mean_height", 42, unit="cm", digits=1)
"#
            .to_string(),
            attributes: HashMap::from([(
                "produces".to_string(),
                serde_json::Value::String("figures/kernel-result.txt".to_string()),
            )]),
            inputs: Vec::new(),
        };

        let first_result = execute_kernel_impl(first, &trust, &registry).unwrap();
        assert_eq!(first_result.status, KernelExecutionStatus::Ok);
        assert!(first_result.messages.iter().any(|message| {
            matches!(message, KernelExecutionMessage::Stream { text, .. } if text.contains("kernel-ready"))
        }));
        assert_eq!(first_result.artifacts.len(), 1);
        assert_eq!(first_result.session_generation, 1);
        assert_eq!(first_result.execution_sequence, 1);
        assert!(first_result.messages.iter().any(|message| {
            matches!(message, KernelExecutionMessage::Display { data, .. }
            if data.get(PUBLISHED_VALUE_MIME) == Some(&serde_json::json!({
                "version": 1,
                "name": "mean_height",
                "value": 42,
                "unit": "cm",
                "formatting": {"digits": 1}
            })))
        }));

        let second_result = execute_kernel_impl(
            KernelExecutionRequest {
                root: root.to_string_lossy().into_owned(),
                cell_id: "kernel-second".to_string(),
                language: RuntimeLanguage::Python,
                kernel_name: kernel.name.clone(),
                code: "print(shared_value + 1)".to_string(),
                attributes: HashMap::new(),
                inputs: Vec::new(),
            },
            &trust,
            &registry,
        )
        .unwrap();
        assert!(second_result.messages.iter().any(|message| {
            matches!(message, KernelExecutionMessage::Stream { text, .. } if text.trim() == "42")
        }));
        assert_eq!(second_result.session_generation, 1);
        assert_eq!(second_result.execution_sequence, 2);

        assert!(restart_kernel_impl(RuntimeLanguage::Python, &registry).unwrap());
        let restarted_result = execute_kernel_impl(
            KernelExecutionRequest {
                root: root.to_string_lossy().into_owned(),
                cell_id: "kernel-restarted".to_string(),
                language: RuntimeLanguage::Python,
                kernel_name: kernel.name.clone(),
                code: "print('shared_value' in globals())".to_string(),
                attributes: HashMap::new(),
                inputs: Vec::new(),
            },
            &trust,
            &registry,
        )
        .unwrap();
        assert!(restarted_result.messages.iter().any(|message| {
            matches!(message, KernelExecutionMessage::Stream { text, .. } if text.trim() == "False")
        }));
        assert_eq!(restarted_result.session_generation, 2);
        assert_eq!(restarted_result.execution_sequence, 1);

        let busy_registry = registry.clone();
        let busy_trust = trust.clone();
        let busy_root = root.to_string_lossy().into_owned();
        let busy_kernel = kernel.name.clone();
        let first_lane = thread::spawn(move || {
            execute_kernel_impl(
                KernelExecutionRequest {
                    root: busy_root,
                    cell_id: "kernel-lane-first".to_string(),
                    language: RuntimeLanguage::Python,
                    kernel_name: busy_kernel,
                    code: "import time; time.sleep(1); print('lane-complete')".to_string(),
                    attributes: HashMap::new(),
                    inputs: Vec::new(),
                },
                &busy_trust,
                &busy_registry,
            )
        });
        thread::sleep(Duration::from_millis(200));
        let busy = execute_kernel_impl(
            KernelExecutionRequest {
                root: root.to_string_lossy().into_owned(),
                cell_id: "kernel-lane-second".to_string(),
                language: RuntimeLanguage::Python,
                kernel_name: kernel.name.clone(),
                code: "print('must-not-run-concurrently')".to_string(),
                attributes: HashMap::new(),
                inputs: Vec::new(),
            },
            &trust,
            &registry,
        )
        .unwrap_err();
        assert!(matches!(busy, HostError::Conflict(_)));
        let first_lane = first_lane.join().unwrap().unwrap();
        assert_eq!(first_lane.status, KernelExecutionStatus::Ok);
        assert!(first_lane.messages.iter().any(|message| {
            matches!(message, KernelExecutionMessage::Stream { text, .. } if text.trim() == "lane-complete")
        }));

        let interrupted_registry = registry.clone();
        let interrupted_trust = trust.clone();
        let interrupted_root = root.to_string_lossy().into_owned();
        let interrupted_kernel = kernel.name.clone();
        let running = thread::spawn(move || {
            execute_kernel_impl(
                KernelExecutionRequest {
                    root: interrupted_root,
                    cell_id: "kernel-interrupt".to_string(),
                    language: RuntimeLanguage::Python,
                    kernel_name: interrupted_kernel,
                    code: "import time; time.sleep(30)".to_string(),
                    attributes: HashMap::new(),
                    inputs: Vec::new(),
                },
                &interrupted_trust,
                &interrupted_registry,
            )
        });
        thread::sleep(Duration::from_millis(500));
        assert!(interrupt_kernel_impl(RuntimeLanguage::Python, &registry).unwrap());
        let interrupted = running.join().unwrap().unwrap();
        assert_eq!(interrupted.status, KernelExecutionStatus::Interrupted);

        let alive = execute_kernel_impl(
            KernelExecutionRequest {
                root: root.to_string_lossy().into_owned(),
                cell_id: "kernel-after-interrupt".to_string(),
                language: RuntimeLanguage::Python,
                kernel_name: kernel.name.clone(),
                code: "print('still-alive')".to_string(),
                attributes: HashMap::new(),
                inputs: Vec::new(),
            },
            &trust,
            &registry,
        )
        .unwrap();
        assert_eq!(alive.status, KernelExecutionStatus::Ok);
        assert!(alive.messages.iter().any(|message| {
            matches!(message, KernelExecutionMessage::Stream { text, .. } if text.trim() == "still-alive")
        }));
        assert!(terminate_kernel_impl(RuntimeLanguage::Python, &registry).unwrap());
    }
}

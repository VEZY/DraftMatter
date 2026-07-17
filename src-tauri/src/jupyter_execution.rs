use crate::execution_artifacts::{
    collect_artifacts, create_run_directory, declared_artifacts, prepare_artifact_backups,
    restore_artifacts, valid_cell_id, verify_inputs, ExecutionArtifact, ExecutionEnvironment,
    ExecutionInput,
};
use crate::execution_trust::{require_execution_trust, ExecutionTrustStore};
use crate::runtime::{
    configure_project_environment, discover_jupyter_kernels_impl, resolve_runtime_executable,
    JupyterKernelProbe, RuntimeHealth, RuntimeLanguage,
};
use crate::{canonical_root, now_millis, HostError};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const BRIDGE_SOURCE: &str = include_str!("jupyter_bridge.py");
const MAX_CODE_BYTES: usize = 2 * 1024 * 1024;
const MAX_BRIDGE_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(25);
const LIFECYCLE_TIMEOUT: Duration = Duration::from_secs(35);
const EXECUTION_TIMEOUT: Duration = Duration::from_secs(330);

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeReady {
    ok: bool,
    port: Option<u16>,
    environment: Option<ExecutionEnvironment>,
    session_id: Option<String>,
    error: Option<String>,
    #[serde(default)]
    traceback: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeResponse {
    ok: bool,
    status: Option<String>,
    #[serde(default)]
    messages: Vec<KernelExecutionMessage>,
    execution_count: Option<u64>,
    kernel_run_id: Option<String>,
    session_generation: Option<u64>,
    execution_sequence: Option<u64>,
    environment: Option<ExecutionEnvironment>,
    error: Option<String>,
    #[serde(default)]
    traceback: Vec<String>,
}

struct KernelSession {
    root: PathBuf,
    kernel_name: String,
    port: u16,
    secret: String,
    session_id: String,
    child: Mutex<Child>,
    environment: Mutex<ExecutionEnvironment>,
    interrupted: AtomicBool,
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

fn bridge_failure(error: Option<String>, traceback: &[String]) -> HostError {
    let message =
        error.unwrap_or_else(|| "The Jupyter bridge returned an unspecified error.".to_string());
    if traceback.is_empty() {
        integration(message)
    } else {
        integration(format!("{message}\n{}", traceback.join("\n")))
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

fn supports_jupyter_client(executable: &Path) -> bool {
    let Ok(mut child) = Command::new(executable)
        .args(["-c", "import jupyter_client"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started.elapsed() < Duration::from_secs(5) => {
                thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

fn resolve_jupyter_controller(kernel: &JupyterKernelProbe) -> Result<PathBuf, HostError> {
    let mut candidates = Vec::new();
    if let Some(configured) = env::var_os("DRAFTMATTER_JUPYTER_PYTHON") {
        candidates.push(PathBuf::from(configured));
    }
    if kernel.language == Some(RuntimeLanguage::Python) {
        if let Some(executable) = &kernel.executable {
            candidates.push(PathBuf::from(executable));
        }
    }
    for candidate in discover_jupyter_kernels_impl()
        .kernels
        .into_iter()
        .filter(|candidate| {
            candidate.language == Some(RuntimeLanguage::Python)
                && candidate.health == RuntimeHealth::Available
        })
        .filter_map(|candidate| candidate.executable.map(PathBuf::from))
    {
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    if let Some(executable) = resolve_runtime_executable(RuntimeLanguage::Python) {
        if !candidates.contains(&executable) {
            candidates.push(executable);
        }
    }
    candidates
        .into_iter()
        .find(|candidate| supports_jupyter_client(candidate))
        .ok_or_else(|| {
            integration(
                "Starting an interactive kernel requires a Python environment with jupyter_client. Select a kernel installed from such an environment or configure DRAFTMATTER_JUPYTER_PYTHON.",
            )
        })
}

fn read_startup_line(stdout: impl Read + Send + 'static) -> Result<String, HostError> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout)
            .take(MAX_BRIDGE_RESPONSE_BYTES + 1)
            .read_line(&mut line)
            .map(|_| line);
        let _ = sender.send(result);
    });
    match receiver.recv_timeout(STARTUP_TIMEOUT) {
        Ok(Ok(line)) if line.len() as u64 <= MAX_BRIDGE_RESPONSE_BYTES => Ok(line),
        Ok(Ok(_)) => Err(integration(
            "The Jupyter bridge startup response exceeded 16 MB.",
        )),
        Ok(Err(error)) => Err(integration(format!(
            "Could not read the Jupyter bridge startup response: {error}"
        ))),
        Err(_) => Err(integration(
            "The Jupyter bridge did not start within 25 seconds.",
        )),
    }
}

fn start_session(
    root: &Path,
    kernel: &JupyterKernelProbe,
) -> Result<Arc<KernelSession>, HostError> {
    let controller = resolve_jupyter_controller(kernel)?;
    let secret = Uuid::new_v4().to_string();
    let language = kernel.language.unwrap_or(RuntimeLanguage::Python);
    let mut command = Command::new(&controller);
    command
        .arg("-u")
        .arg("-c")
        .arg(BRIDGE_SOURCE)
        .arg(&kernel.name)
        .arg(root)
        .arg(&secret)
        .arg(if language == RuntimeLanguage::Julia {
            root.as_os_str()
        } else {
            std::ffi::OsStr::new("")
        })
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_project_environment(&mut command, language, root);
    let mut child = command.spawn().map_err(|error| {
        integration(format!(
            "Could not start the Jupyter protocol controller: {error}"
        ))
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| integration("The Jupyter bridge did not expose its startup channel."))?;
    let line = match read_startup_line(stdout) {
        Ok(line) => line,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let ready: BridgeReady = serde_json::from_str(&line).map_err(|error| {
        let _ = child.kill();
        let _ = child.wait();
        integration(format!(
            "The Jupyter bridge returned an invalid startup response: {error}"
        ))
    })?;
    if !ready.ok {
        let _ = child.kill();
        let _ = child.wait();
        return Err(bridge_failure(ready.error, &ready.traceback));
    }
    let (Some(port), Some(mut environment)) = (ready.port, ready.environment) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(integration(
            "The Jupyter bridge did not report complete startup details.",
        ));
    };
    environment.details.insert(
        "controller".to_string(),
        controller.to_string_lossy().into_owned(),
    );
    Ok(Arc::new(KernelSession {
        root: root.to_path_buf(),
        kernel_name: kernel.name.clone(),
        port,
        secret,
        session_id: ready
            .session_id
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        child: Mutex::new(child),
        environment: Mutex::new(environment),
        interrupted: AtomicBool::new(false),
    }))
}

fn command_value(session: &KernelSession, kind: &str, code: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "secret": session.secret,
        "kind": kind,
        "code": code,
    })
}

fn send_command<T: DeserializeOwned>(
    session: &KernelSession,
    command: serde_json::Value,
    timeout: Duration,
) -> Result<T, HostError> {
    let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, session.port));
    let mut stream =
        TcpStream::connect_timeout(&address, Duration::from_secs(3)).map_err(|error| {
            integration(format!("Could not connect to the Jupyter bridge: {error}"))
        })?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    let mut payload = serde_json::to_vec(&command).map_err(|error| {
        integration(format!("Could not serialize the Jupyter command: {error}"))
    })?;
    payload.push(b'\n');
    stream.write_all(&payload)?;
    stream.flush()?;
    let mut bytes = Vec::new();
    BufReader::new(stream)
        .take(MAX_BRIDGE_RESPONSE_BYTES + 1)
        .read_until(b'\n', &mut bytes)?;
    if bytes.len() as u64 > MAX_BRIDGE_RESPONSE_BYTES {
        return Err(integration(
            "The Jupyter bridge response exceeded the 16 MB safety limit.",
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| integration(format!("The Jupyter bridge returned invalid JSON: {error}")))
}

fn terminate_session(session: &KernelSession) {
    let _: Result<BridgeResponse, _> = send_command(
        session,
        command_value(session, "shutdown", None),
        Duration::from_secs(5),
    );
    if let Ok(mut child) = session.child.lock() {
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() < Duration::from_secs(2) => {
                    thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
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
    session.interrupted.store(false, Ordering::SeqCst);
    let mut response: BridgeResponse = match send_command(
        &session,
        command_value(&session, "execute", Some(&request.code)),
        EXECUTION_TIMEOUT,
    ) {
        Ok(response) => response,
        Err(error) => {
            restore_artifacts(&backups)?;
            if let Some(removed) = remove_session(request.language, registry)? {
                terminate_session(&removed);
            }
            return Err(error);
        }
    };
    if !response.ok {
        restore_artifacts(&backups)?;
        return Err(bridge_failure(response.error, &response.traceback));
    }
    if let Some(environment) = response.environment.take() {
        *session.environment.lock().map_err(|_| registry_error())? = environment;
    }
    let interrupted = session.interrupted.load(Ordering::SeqCst);
    let mut status = if interrupted {
        KernelExecutionStatus::Interrupted
    } else if response.status.as_deref() == Some("ok") {
        KernelExecutionStatus::Ok
    } else {
        KernelExecutionStatus::Error
    };
    if interrupted {
        response
            .messages
            .retain(|message| !matches!(message, KernelExecutionMessage::Error { .. }));
    }
    let mut produced = Vec::new();
    if status == KernelExecutionStatus::Ok {
        match collect_artifacts(&artifacts) {
            Ok(artifacts) => produced = artifacts,
            Err(error) => {
                let sequence = response.messages.len() as u64;
                response.messages.push(KernelExecutionMessage::Error {
                    sequence,
                    name: error.name,
                    message: error.message,
                    traceback: error.traceback,
                });
                status = KernelExecutionStatus::Error;
            }
        }
    }
    if status != KernelExecutionStatus::Ok {
        restore_artifacts(&backups)?;
    }
    let environment = session
        .environment
        .lock()
        .map_err(|_| registry_error())?
        .clone();
    let session_generation = response.session_generation.ok_or_else(|| {
        integration("The Jupyter bridge omitted the shared-session generation.")
    })?;
    let execution_sequence = response.execution_sequence.ok_or_else(|| {
        integration("The Jupyter bridge omitted the session execution sequence.")
    })?;
    Ok(KernelExecutionResult {
        status,
        messages: response.messages,
        artifacts: produced,
        environment,
        kernel_run_id: response.kernel_run_id.unwrap_or_else(|| {
            format!(
                "kernel:{}:{}:{}",
                session.session_id,
                now_millis(),
                request.cell_id
            )
        }),
        execution_count: response.execution_count,
        session_generation,
        execution_sequence,
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
    session.interrupted.store(true, Ordering::SeqCst);
    let response: BridgeResponse = send_command(
        &session,
        command_value(&session, "interrupt", None),
        LIFECYCLE_TIMEOUT,
    )?;
    if !response.ok {
        return Err(bridge_failure(response.error, &response.traceback));
    }
    Ok(true)
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
    let mut response: BridgeResponse = send_command(
        &session,
        command_value(&session, "restart", None),
        LIFECYCLE_TIMEOUT,
    )?;
    if !response.ok {
        return Err(bridge_failure(response.error, &response.traceback));
    }
    if let Some(environment) = response.environment.take() {
        *session.environment.lock().map_err(|_| registry_error())? = environment;
    }
    session.interrupted.store(false, Ordering::SeqCst);
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
    fn bridge_injects_explicit_publish_helpers_for_every_supported_language() {
        assert!(BRIDGE_SOURCE.contains("def publish(name, value, *, unit=None, digits=None)"));
        assert!(BRIDGE_SOURCE.contains("publish <- function(name, value, unit = NULL, digits = NULL)"));
        assert!(BRIDGE_SOURCE.contains("macro publish(variable, options...)"));
        assert!(BRIDGE_SOURCE.contains("application/vnd.draftmatter.published-value+json"));
        assert!(!BRIDGE_SOURCE.contains("NotebookApp"));
        assert!(!BRIDGE_SOURCE.contains("ServerApp"));
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
        if resolve_jupyter_controller(kernel).is_err() {
            return;
        }
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
draftmatter_value = 41
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
                if data.get("application/vnd.draftmatter.published-value+json") == Some(&serde_json::json!({
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
                code: "print(draftmatter_value + 1)".to_string(),
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
                code: "print('draftmatter_value' in globals())".to_string(),
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
        assert!(terminate_kernel_impl(RuntimeLanguage::Python, &registry).unwrap());
    }
}

use crate::execution_trust::{require_execution_trust, ExecutionTrustStore};
use crate::runtime::{
    probe_runtime_executable_impl, resolve_runtime_executable, RuntimeHealth, RuntimeLanguage,
};
use crate::{canonical_root, now_millis, safe_relative, HostError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const MAX_CODE_BYTES: usize = 2 * 1024 * 1024;
const MAX_STREAM_BYTES: usize = 4 * 1024 * 1024;
const MAX_INPUTS: usize = 64;
const MAX_ARTIFACTS: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectExecutionInput {
    pub path: String,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectExecutionRequest {
    pub root: String,
    pub cell_id: String,
    pub language: RuntimeLanguage,
    pub code: String,
    #[serde(default)]
    pub attributes: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub inputs: Vec<DirectExecutionInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectExecutionError {
    pub name: String,
    pub message: String,
    pub traceback: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectExecutionArtifact {
    pub path: String,
    pub bytes: u64,
    pub hash: String,
    pub media_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectExecutionEnvironment {
    pub identity: String,
    pub version: Option<String>,
    pub details: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirectExecutionResult {
    pub exit_code: Option<i32>,
    pub interrupted: bool,
    pub stdout: String,
    pub stderr: String,
    pub errors: Vec<DirectExecutionError>,
    pub mime: Vec<serde_json::Value>,
    pub artifacts: Vec<DirectExecutionArtifact>,
    pub environment: DirectExecutionEnvironment,
    pub provider_run_id: String,
}

struct ActiveProcess {
    child: Mutex<Child>,
    interrupted: AtomicBool,
}

#[derive(Clone, Default)]
pub struct DirectProcessRegistry {
    processes: Arc<Mutex<HashMap<RuntimeLanguage, Arc<ActiveProcess>>>>,
}

struct RunDirectory(PathBuf);

impl Drop for RunDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct ArtifactBackup {
    path: PathBuf,
    backup: Option<PathBuf>,
}

struct CapturedStream {
    bytes: Vec<u8>,
    truncated: bool,
}

fn integration(message: impl Into<String>) -> HostError {
    HostError::Integration(message.into())
}

fn process_store_error() -> HostError {
    integration("The direct-process registry is unavailable.")
}

fn valid_cell_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        })
}

fn safe_cell_filename(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn create_run_directory(root: &Path, cell_id: &str) -> Result<RunDirectory, HostError> {
    let parent = root.join(".draftmatter/execution/tmp");
    fs::create_dir_all(&parent)?;
    for attempt in 0..100_u8 {
        let path = parent.join(format!(
            "{}-{}-{}-{attempt}",
            now_millis(),
            std::process::id(),
            safe_cell_filename(cell_id)
        ));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(RunDirectory(path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(integration(
        "Could not allocate a unique direct-execution directory.",
    ))
}

fn sha256_file(path: &Path) -> Result<(String, u64), HostError> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        digest.update(&buffer[..count]);
    }
    let hash = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok((format!("sha256:{hash}"), bytes))
}

fn nearest_existing(path: &Path) -> Option<&Path> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if candidate.exists() {
            return Some(candidate);
        }
        current = candidate.parent();
    }
    None
}

fn ensure_contained(root: &Path, path: &Path) -> Result<(), HostError> {
    let existing = nearest_existing(path).ok_or_else(|| {
        HostError::InvalidPath("No existing parent could be verified.".to_string())
    })?;
    let canonical = fs::canonicalize(existing)?;
    if canonical.starts_with(root) {
        Ok(())
    } else {
        Err(HostError::InvalidPath(format!(
            "Execution paths cannot leave the project through a symlink: {}",
            path.display()
        )))
    }
}

fn project_path(root: &Path, relative: &str, artifact: bool) -> Result<PathBuf, HostError> {
    let safe = safe_relative(relative)?;
    if artifact
        && safe
            .components()
            .next()
            .is_some_and(|component| component == Component::Normal(OsStr::new(".draftmatter")))
    {
        return Err(HostError::InvalidPath(
            "Declared artifacts must be ordinary project files outside .draftmatter.".to_string(),
        ));
    }
    let path = root.join(safe);
    ensure_contained(root, &path)?;
    Ok(path)
}

fn verify_inputs(root: &Path, inputs: &[DirectExecutionInput]) -> Result<(), HostError> {
    if inputs.len() > MAX_INPUTS {
        return Err(HostError::InvalidProject(format!(
            "A cell may declare at most {MAX_INPUTS} input files."
        )));
    }
    for input in inputs {
        let path = project_path(root, &input.path, false)?;
        if !path.is_file() {
            return Err(HostError::NotFound(format!(
                "Declared input is missing: {}",
                input.path
            )));
        }
        let (actual, _) = sha256_file(&path)?;
        if actual != input.hash.to_ascii_lowercase() {
            return Err(HostError::Conflict(format!(
                "Declared input changed before execution: {}",
                input.path
            )));
        }
    }
    Ok(())
}

pub fn fingerprint_execution_inputs_impl(
    root: &str,
    paths: Vec<String>,
) -> Result<Vec<DirectExecutionInput>, HostError> {
    if paths.len() > MAX_INPUTS {
        return Err(HostError::InvalidProject(format!(
            "A cell may declare at most {MAX_INPUTS} input files."
        )));
    }
    let root = canonical_root(root)?;
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .map(|path| {
            if !seen.insert(path.clone()) {
                return Err(HostError::InvalidProject(format!(
                    "Declared input appears more than once: {path}"
                )));
            }
            let absolute = project_path(&root, &path, false)?;
            if !absolute.is_file() {
                return Err(HostError::NotFound(format!(
                    "Declared input is missing: {path}"
                )));
            }
            let (hash, _) = sha256_file(&absolute)?;
            Ok(DirectExecutionInput { path, hash })
        })
        .collect()
}

fn declared_artifacts(
    root: &Path,
    attributes: &HashMap<String, serde_json::Value>,
) -> Result<Vec<(String, PathBuf)>, HostError> {
    let Some(value) = attributes.get("produces") else {
        return Ok(Vec::new());
    };
    let source = value.as_str().ok_or_else(|| {
        HostError::InvalidProject(
            "The produces attribute must be a comma-separated string.".to_string(),
        )
    })?;
    let relative = source
        .split(',')
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    if relative.len() > MAX_ARTIFACTS {
        return Err(HostError::InvalidProject(format!(
            "A cell may declare at most {MAX_ARTIFACTS} artifacts."
        )));
    }
    relative
        .into_iter()
        .map(|path| Ok((path.to_string(), project_path(root, path, true)?)))
        .collect()
}

fn prepare_artifact_backups(
    artifacts: &[(String, PathBuf)],
    run_directory: &Path,
) -> Result<Vec<ArtifactBackup>, HostError> {
    let mut backups = Vec::new();
    for (index, (_, path)) in artifacts.iter().enumerate() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let backup = if path.exists() {
            if !path.is_file() {
                return Err(HostError::InvalidPath(format!(
                    "Declared artifact is not a regular file: {}",
                    path.display()
                )));
            }
            let backup = run_directory.join(format!("artifact-backup-{index}.bin"));
            fs::copy(path, &backup)?;
            Some(backup)
        } else {
            None
        };
        backups.push(ArtifactBackup {
            path: path.clone(),
            backup,
        });
    }
    Ok(backups)
}

fn restore_artifacts(backups: &[ArtifactBackup]) -> Result<(), HostError> {
    for backup in backups {
        if let Some(source) = &backup.backup {
            fs::copy(source, &backup.path)?;
        } else if backup.path.exists() {
            fs::remove_file(&backup.path)?;
        }
    }
    Ok(())
}

fn script_extension(language: RuntimeLanguage) -> &'static str {
    match language {
        RuntimeLanguage::Python => "py",
        RuntimeLanguage::R => "R",
        RuntimeLanguage::Julia => "jl",
    }
}

fn command_arguments(language: RuntimeLanguage, root: &Path, script: &Path) -> Vec<OsString> {
    match language {
        RuntimeLanguage::Python => vec![OsString::from("-u"), script.as_os_str().to_os_string()],
        RuntimeLanguage::R => vec![
            OsString::from("--vanilla"),
            script.as_os_str().to_os_string(),
        ],
        RuntimeLanguage::Julia => vec![
            OsString::from("--startup-file=no"),
            OsString::from("--history-file=no"),
            {
                let mut project = OsString::from("--project=");
                project.push(root.as_os_str());
                project
            },
            script.as_os_str().to_os_string(),
        ],
    }
}

fn capture_stream(mut stream: impl Read) -> CapturedStream {
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let remaining = MAX_STREAM_BYTES.saturating_sub(bytes.len());
                if remaining > 0 {
                    bytes.extend_from_slice(&buffer[..count.min(remaining)]);
                }
                if count > remaining {
                    truncated = true;
                }
            }
        }
    }
    CapturedStream { bytes, truncated }
}

fn wait_for_process(active: &ActiveProcess) -> Result<ExitStatus, HostError> {
    loop {
        let status = active
            .child
            .lock()
            .map_err(|_| process_store_error())?
            .try_wait()?;
        if let Some(status) = status {
            return Ok(status);
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn media_type(path: &Path) -> Option<String> {
    match path
        .extension()
        .and_then(OsStr::to_str)?
        .to_ascii_lowercase()
        .as_str()
    {
        "svg" => Some("image/svg+xml".to_string()),
        "png" => Some("image/png".to_string()),
        "jpg" | "jpeg" => Some("image/jpeg".to_string()),
        "csv" => Some("text/csv".to_string()),
        "json" => Some("application/json".to_string()),
        "html" | "htm" => Some("text/html".to_string()),
        "md" => Some("text/markdown".to_string()),
        _ => None,
    }
}

fn collect_artifacts(
    artifacts: &[(String, PathBuf)],
) -> Result<Vec<DirectExecutionArtifact>, DirectExecutionError> {
    artifacts
        .iter()
        .map(|(relative, path)| {
            if !path.is_file() {
                return Err(DirectExecutionError {
                    name: "ArtifactMissing".to_string(),
                    message: format!("Declared artifact was not produced: {relative}"),
                    traceback: Vec::new(),
                });
            }
            let (hash, bytes) = sha256_file(path).map_err(|error| DirectExecutionError {
                name: "ArtifactUnreadable".to_string(),
                message: format!("Declared artifact could not be read ({relative}): {error}"),
                traceback: Vec::new(),
            })?;
            Ok(DirectExecutionArtifact {
                path: relative.clone(),
                bytes,
                hash,
                media_type: media_type(path),
            })
        })
        .collect()
}

pub fn execute_direct_impl(
    request: DirectExecutionRequest,
    trust: &ExecutionTrustStore,
    registry: &DirectProcessRegistry,
) -> Result<DirectExecutionResult, HostError> {
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
    verify_inputs(&root, &request.inputs)?;
    let artifacts = declared_artifacts(&root, &request.attributes)?;
    let run_directory = create_run_directory(&root, &request.cell_id)?;
    let backups = prepare_artifact_backups(&artifacts, &run_directory.0)?;
    let script = run_directory.0.join(format!(
        "{}.{}",
        safe_cell_filename(&request.cell_id),
        script_extension(request.language)
    ));
    fs::write(&script, request.code.as_bytes())?;

    let runtime = probe_runtime_executable_impl(request.language);
    if runtime.health != RuntimeHealth::Available {
        restore_artifacts(&backups)?;
        return Err(integration(runtime.message.unwrap_or_else(|| {
            "The selected language runtime is unavailable.".to_string()
        })));
    }
    let executable = resolve_runtime_executable(request.language)
        .ok_or_else(|| integration("The discovered runtime disappeared before execution."))?;
    let mut command = Command::new(&executable);
    command
        .args(command_arguments(request.language, &root, &script))
        .current_dir(&root)
        .env("DRAFTMATTER_CELL_ID", &request.cell_id)
        .env("DRAFTMATTER_PROJECT_ROOT", &root)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let active = {
        let mut processes = registry
            .processes
            .lock()
            .map_err(|_| process_store_error())?;
        if processes.contains_key(&request.language) {
            restore_artifacts(&backups)?;
            return Err(HostError::Conflict(format!(
                "A {:?} direct execution is already running.",
                request.language
            )));
        }
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                restore_artifacts(&backups)?;
                return Err(integration(format!(
                    "Could not start the direct runtime: {error}"
                )));
            }
        };
        let active = Arc::new(ActiveProcess {
            child: Mutex::new(child),
            interrupted: AtomicBool::new(false),
        });
        processes.insert(request.language, active.clone());
        active
    };

    let (stdout, stderr) = {
        let mut child = active.child.lock().map_err(|_| process_store_error())?;
        (child.stdout.take(), child.stderr.take())
    };
    let stdout_reader = stdout.map(|stream| thread::spawn(move || capture_stream(stream)));
    let stderr_reader = stderr.map(|stream| thread::spawn(move || capture_stream(stream)));
    let status = wait_for_process(&active);
    registry
        .processes
        .lock()
        .map_err(|_| process_store_error())?
        .remove(&request.language);
    let status = match status {
        Ok(status) => status,
        Err(error) => {
            restore_artifacts(&backups)?;
            return Err(error);
        }
    };
    let stdout = stdout_reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or(CapturedStream {
            bytes: Vec::new(),
            truncated: false,
        });
    let stderr = stderr_reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or(CapturedStream {
            bytes: Vec::new(),
            truncated: false,
        });
    let interrupted = active.interrupted.load(Ordering::SeqCst);
    let mut errors = Vec::new();
    if stdout.truncated || stderr.truncated {
        errors.push(DirectExecutionError {
            name: "OutputLimitExceeded".to_string(),
            message: "Direct execution produced more than 4 MB on stdout or stderr; output was truncated."
                .to_string(),
            traceback: Vec::new(),
        });
    }
    let successful_process = status.success() && !interrupted && errors.is_empty();
    let produced = if successful_process {
        match collect_artifacts(&artifacts) {
            Ok(artifacts) => artifacts,
            Err(error) => {
                errors.push(error);
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let successful = successful_process && errors.is_empty();
    if !successful {
        restore_artifacts(&backups)?;
    }
    let mut details = BTreeMap::new();
    details.insert("mode".to_string(), "script-artifact".to_string());
    let provider_run_id = format!(
        "direct:{}:{}:{}",
        now_millis(),
        std::process::id(),
        safe_cell_filename(&request.cell_id)
    );
    Ok(DirectExecutionResult {
        exit_code: if successful {
            Some(0)
        } else if interrupted {
            status.code()
        } else {
            status.code().filter(|code| *code != 0).or(Some(1))
        },
        interrupted,
        stdout: String::from_utf8_lossy(&stdout.bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr.bytes).into_owned(),
        errors,
        mime: Vec::new(),
        artifacts: produced,
        environment: DirectExecutionEnvironment {
            identity: executable.to_string_lossy().into_owned(),
            version: runtime.version,
            details,
        },
        provider_run_id,
    })
}

pub fn interrupt_direct_impl(
    language: RuntimeLanguage,
    registry: &DirectProcessRegistry,
) -> Result<bool, HostError> {
    let active = registry
        .processes
        .lock()
        .map_err(|_| process_store_error())?
        .get(&language)
        .cloned();
    let Some(active) = active else {
        return Ok(false);
    };
    active.interrupted.store(true, Ordering::SeqCst);
    active
        .child
        .lock()
        .map_err(|_| process_store_error())?
        .kill()?;
    Ok(true)
}

pub fn restart_direct_impl(
    language: RuntimeLanguage,
    registry: &DirectProcessRegistry,
) -> Result<bool, HostError> {
    interrupt_direct_impl(language, registry)
}

pub fn terminate_direct_impl(
    language: RuntimeLanguage,
    registry: &DirectProcessRegistry,
) -> Result<bool, HostError> {
    interrupt_direct_impl(language, registry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution_trust::{
        trust_project_for_session_impl, ExecutionTrustStore, TRUST_ACKNOWLEDGEMENT,
    };
    use tempfile::tempdir;

    fn request(root: &Path) -> DirectExecutionRequest {
        DirectExecutionRequest {
            root: root.to_string_lossy().into_owned(),
            cell_id: "cell-safe".to_string(),
            language: RuntimeLanguage::Python,
            code: "print(1)".to_string(),
            attributes: HashMap::new(),
            inputs: Vec::new(),
        }
    }

    #[test]
    fn refuses_to_resolve_a_runtime_before_project_trust() {
        let project = tempdir().unwrap();
        let error = execute_direct_impl(
            request(project.path()),
            &ExecutionTrustStore::default(),
            &DirectProcessRegistry::default(),
        )
        .unwrap_err();

        assert!(matches!(error, HostError::Integration(message) if message.contains("blocked")));
        assert!(!project.path().join(".draftmatter/execution").exists());
    }

    #[test]
    fn builds_fixed_cross_platform_arguments_for_every_language() {
        let root = Path::new("project-root");
        let script = Path::new("cell-source");

        assert_eq!(
            command_arguments(RuntimeLanguage::Python, root, script),
            vec![OsString::from("-u"), OsString::from("cell-source")]
        );
        assert_eq!(
            command_arguments(RuntimeLanguage::R, root, script),
            vec![OsString::from("--vanilla"), OsString::from("cell-source")]
        );
        assert_eq!(
            command_arguments(RuntimeLanguage::Julia, root, script),
            vec![
                OsString::from("--startup-file=no"),
                OsString::from("--history-file=no"),
                OsString::from("--project=project-root"),
                OsString::from("cell-source")
            ]
        );
    }

    #[test]
    fn verifies_input_hashes_and_rejects_artifact_traversal() {
        let project = tempdir().unwrap();
        fs::write(project.path().join("input.csv"), b"a,b\n1,2\n").unwrap();
        let (hash, _) = sha256_file(&project.path().join("input.csv")).unwrap();
        assert!(verify_inputs(
            &fs::canonicalize(project.path()).unwrap(),
            &[DirectExecutionInput {
                path: "input.csv".to_string(),
                hash
            }]
        )
        .is_ok());
        assert!(project_path(
            &fs::canonicalize(project.path()).unwrap(),
            "../outside.svg",
            true
        )
        .is_err());

        let inputs = fingerprint_execution_inputs_impl(
            project.path().to_str().unwrap(),
            vec!["input.csv".to_string()],
        )
        .unwrap();
        assert_eq!(
            inputs,
            vec![DirectExecutionInput {
                path: "input.csv".to_string(),
                hash: sha256_file(&project.path().join("input.csv")).unwrap().0,
            }]
        );
        assert!(fingerprint_execution_inputs_impl(
            project.path().to_str().unwrap(),
            vec!["../outside.csv".to_string()],
        )
        .is_err());
        assert!(project_path(
            &fs::canonicalize(project.path()).unwrap(),
            ".draftmatter/hidden.svg",
            true
        )
        .is_err());
    }

    #[test]
    fn an_idle_direct_provider_can_be_interrupted_idempotently() {
        let registry = DirectProcessRegistry::default();
        assert!(!interrupt_direct_impl(RuntimeLanguage::Julia, &registry).unwrap());
        assert!(!terminate_direct_impl(RuntimeLanguage::Python, &registry).unwrap());
    }

    #[test]
    fn runs_python_explicitly_and_rolls_declared_artifacts_back_after_failure() {
        if resolve_runtime_executable(RuntimeLanguage::Python).is_none() {
            return;
        }
        let project = tempdir().unwrap();
        let root = fs::canonicalize(project.path()).unwrap();
        let trust = ExecutionTrustStore::default();
        trust_project_for_session_impl(root.to_str().unwrap(), TRUST_ACKNOWLEDGEMENT, &trust)
            .unwrap();
        let registry = DirectProcessRegistry::default();
        let mut successful = request(&root);
        successful.attributes.insert(
            "produces".to_string(),
            serde_json::Value::String("figures/generated/result.txt".to_string()),
        );
        successful.code = r#"from pathlib import Path
path = Path("figures/generated/result.txt")
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text("current", encoding="utf-8")
print("python direct ready")
"#
        .to_string();

        let result = execute_direct_impl(successful, &trust, &registry).unwrap();

        assert_eq!(result.exit_code, Some(0));
        assert!(result.stdout.contains("python direct ready"));
        assert_eq!(result.artifacts.len(), 1);
        assert!(result.artifacts[0].hash.starts_with("sha256:"));

        let mut failed = request(&root);
        failed.attributes.insert(
            "produces".to_string(),
            serde_json::Value::String("figures/generated/result.txt".to_string()),
        );
        failed.code = r#"from pathlib import Path
Path("figures/generated/result.txt").write_text("partial", encoding="utf-8")
raise SystemExit(2)
"#
        .to_string();
        let result = execute_direct_impl(failed, &trust, &registry).unwrap();

        assert_eq!(result.exit_code, Some(2));
        assert!(result.artifacts.is_empty());
        assert_eq!(
            fs::read_to_string(root.join("figures/generated/result.txt")).unwrap(),
            "current"
        );
    }

    #[test]
    fn interrupts_a_running_direct_process_by_language() {
        if resolve_runtime_executable(RuntimeLanguage::Python).is_none() {
            return;
        }
        let project = tempdir().unwrap();
        let root = fs::canonicalize(project.path()).unwrap();
        let trust = ExecutionTrustStore::default();
        trust_project_for_session_impl(root.to_str().unwrap(), TRUST_ACKNOWLEDGEMENT, &trust)
            .unwrap();
        let registry = DirectProcessRegistry::default();
        let mut long_running = request(&root);
        long_running.code =
            "import time\nprint('started', flush=True)\ntime.sleep(30)\n".to_string();
        let runner_trust = trust.clone();
        let runner_registry = registry.clone();
        let runner = thread::spawn(move || {
            execute_direct_impl(long_running, &runner_trust, &runner_registry).unwrap()
        });
        for _ in 0..250 {
            if registry
                .processes
                .lock()
                .unwrap()
                .contains_key(&RuntimeLanguage::Python)
            {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }

        assert!(interrupt_direct_impl(RuntimeLanguage::Python, &registry).unwrap());
        let result = runner.join().unwrap();

        assert!(result.interrupted);
        assert!(result.artifacts.is_empty());
        assert!(!registry
            .processes
            .lock()
            .unwrap()
            .contains_key(&RuntimeLanguage::Python));
    }
}

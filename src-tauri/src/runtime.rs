use crate::{canonical_root, HostError, TaskProgressReporter};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PROBE_OUTPUT_BYTES: u64 = 64 * 1024;
const MAX_KERNEL_SPEC_BYTES: u64 = 128 * 1024;
const MAX_KERNEL_SPECS: usize = 128;
const MAX_SETUP_DIAGNOSTIC_CHARS: usize = 8 * 1024;
pub(crate) const JULIA_PROJECT_ARGUMENT: &str = "--project=.";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeLanguage {
    Python,
    R,
    Julia,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeHealth {
    Available,
    Missing,
    Unhealthy,
}

pub(crate) fn configure_project_environment(
    command: &mut Command,
    language: RuntimeLanguage,
    root: &Path,
) {
    if language == RuntimeLanguage::Julia {
        command.env("JULIA_PROJECT", root);
        if let Ok(load_path) = env::join_paths([OsStr::new("@"), OsStr::new("@stdlib")]) {
            command.env("JULIA_LOAD_PATH", load_path);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeExecutableProbe {
    pub language: RuntimeLanguage,
    pub health: RuntimeHealth,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JupyterKernelProbe {
    pub name: String,
    pub display_name: String,
    pub language: Option<RuntimeLanguage>,
    pub health: RuntimeHealth,
    pub resource_dir: String,
    pub executable: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JupyterKernelInventory {
    pub health: RuntimeHealth,
    pub kernels: Vec<JupyterKernelProbe>,
    pub searched_locations: Vec<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KernelIntegrationSetupResult {
    pub language: RuntimeLanguage,
    pub kernel_name: Option<String>,
    pub inventory: JupyterKernelInventory,
}

#[derive(Debug, Serialize, Deserialize)]
struct KernelSpec {
    argv: Vec<String>,
    display_name: String,
    language: Option<String>,
}

fn candidate_names(language: RuntimeLanguage) -> &'static [&'static str] {
    match language {
        RuntimeLanguage::Python => &["python3", "python"],
        RuntimeLanguage::R => &["Rscript"],
        RuntimeLanguage::Julia => &["julia"],
    }
}

fn runtime_name(language: RuntimeLanguage) -> &'static str {
    match language {
        RuntimeLanguage::Python => "Python",
        RuntimeLanguage::R => "R",
        RuntimeLanguage::Julia => "Julia",
    }
}

fn path_extensions() -> Vec<OsString> {
    if cfg!(windows) {
        env::var_os("PATHEXT")
            .map(|value| {
                env::split_paths(&value)
                    .filter_map(|path| {
                        let extension = path.as_os_str().to_string_lossy().to_ascii_uppercase();
                        matches!(extension.as_str(), ".EXE" | ".COM").then(|| path.into_os_string())
                    })
                    .collect()
            })
            .filter(|extensions: &Vec<OsString>| !extensions.is_empty())
            .unwrap_or_else(|| vec![OsString::from(".EXE"), OsString::from(".COM")])
    } else {
        Vec::new()
    }
}

fn search_paths() -> Vec<PathBuf> {
    let mut paths = env::var_os("PATH")
        .map(|value| env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    if cfg!(target_os = "macos") {
        paths.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
        ]);
    } else if cfg!(unix) {
        paths.extend([PathBuf::from("/usr/local/bin"), PathBuf::from("/usr/bin")]);
    }
    let mut seen = HashSet::new();
    paths.retain(|path| seen.insert(path.clone()));
    paths
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn resolve_executable_in_paths(name: &OsStr, paths: &[PathBuf]) -> Option<PathBuf> {
    let extensions = path_extensions();
    for directory in paths {
        let direct = directory.join(name);
        if executable_file(&direct) {
            return Some(fs::canonicalize(&direct).unwrap_or(direct));
        }
        if Path::new(name).extension().is_none() {
            for extension in &extensions {
                let mut filename = name.to_os_string();
                filename.push(extension);
                let candidate = directory.join(filename);
                if executable_file(&candidate) {
                    return Some(fs::canonicalize(&candidate).unwrap_or(candidate));
                }
            }
        }
    }
    None
}

fn resolve_runtime(language: RuntimeLanguage, paths: &[PathBuf]) -> Option<PathBuf> {
    candidate_names(language)
        .iter()
        .find_map(|name| resolve_executable_in_paths(OsStr::new(name), paths))
}

pub fn resolve_runtime_executable(language: RuntimeLanguage) -> Option<PathBuf> {
    resolve_runtime(language, &search_paths())
}

struct ProbeOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn read_bounded(reader: impl Read) -> Vec<u8> {
    let mut bytes = Vec::new();
    let _ = reader
        .take(MAX_PROBE_OUTPUT_BYTES + 1)
        .read_to_end(&mut bytes);
    bytes.truncate(MAX_PROBE_OUTPUT_BYTES as usize);
    bytes
}

fn run_version_probe(executable: &Path) -> Result<ProbeOutput, String> {
    let mut child = Command::new(executable)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start the version probe: {error}"))?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < PROBE_TIMEOUT => {
                thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The version probe timed out after 5 seconds.".to_string());
            }
            Err(error) => return Err(format!("Could not read the version probe status: {error}")),
        }
    };
    let stdout = child.stdout.take().map(read_bounded).unwrap_or_default();
    let stderr = child.stderr.take().map(read_bounded).unwrap_or_default();
    Ok(ProbeOutput {
        success: status.success(),
        stdout,
        stderr,
    })
}

fn first_output_line(output: &ProbeOutput) -> Option<String> {
    [&output.stdout, &output.stderr]
        .into_iter()
        .find_map(|bytes| {
            String::from_utf8_lossy(bytes)
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(|line| line.chars().take(240).collect())
        })
}

pub fn probe_runtime_executable_impl(language: RuntimeLanguage) -> RuntimeExecutableProbe {
    let paths = search_paths();
    let Some(executable) = resolve_runtime(language, &paths) else {
        return RuntimeExecutableProbe {
            language,
            health: RuntimeHealth::Missing,
            executable: None,
            version: None,
            message: Some(format!(
                "{} was not found on the application PATH.",
                runtime_name(language)
            )),
        };
    };
    let executable_text = executable.to_string_lossy().into_owned();
    match run_version_probe(&executable) {
        Ok(output) if output.success => RuntimeExecutableProbe {
            language,
            health: RuntimeHealth::Available,
            executable: Some(executable_text),
            version: first_output_line(&output),
            message: None,
        },
        Ok(output) => RuntimeExecutableProbe {
            language,
            health: RuntimeHealth::Unhealthy,
            executable: Some(executable_text),
            version: first_output_line(&output),
            message: Some(format!(
                "{} was found but its fixed --version probe failed.",
                runtime_name(language)
            )),
        },
        Err(message) => RuntimeExecutableProbe {
            language,
            health: RuntimeHealth::Unhealthy,
            executable: Some(executable_text),
            version: None,
            message: Some(message),
        },
    }
}

fn push_kernel_root(roots: &mut Vec<PathBuf>, path: Option<PathBuf>) {
    if let Some(path) = path {
        if !roots.contains(&path) {
            roots.push(path);
        }
    }
}

fn kernel_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(path) = env::var_os("JUPYTER_DATA_DIR") {
        push_kernel_root(&mut roots, Some(PathBuf::from(path).join("kernels")));
    }
    if let Some(paths) = env::var_os("JUPYTER_PATH") {
        for path in env::split_paths(&paths) {
            push_kernel_root(&mut roots, Some(path.join("kernels")));
        }
    }
    let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    if cfg!(target_os = "macos") {
        push_kernel_root(
            &mut roots,
            home.map(|path| path.join("Library/Jupyter/kernels")),
        );
        push_kernel_root(&mut roots, Some(PathBuf::from("/Library/Jupyter/kernels")));
    } else if cfg!(windows) {
        push_kernel_root(
            &mut roots,
            env::var_os("APPDATA")
                .map(PathBuf::from)
                .map(|path| path.join("jupyter/kernels")),
        );
        push_kernel_root(
            &mut roots,
            env::var_os("PROGRAMDATA")
                .map(PathBuf::from)
                .map(|path| path.join("jupyter/kernels")),
        );
    } else {
        let user_data = env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| home.map(|path| path.join(".local/share")));
        push_kernel_root(
            &mut roots,
            user_data.map(|path| path.join("jupyter/kernels")),
        );
        push_kernel_root(
            &mut roots,
            Some(PathBuf::from("/usr/local/share/jupyter/kernels")),
        );
        push_kernel_root(
            &mut roots,
            Some(PathBuf::from("/usr/share/jupyter/kernels")),
        );
    }
    roots
}

fn kernel_language(value: Option<&str>) -> Option<RuntimeLanguage> {
    match value
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        value if value.starts_with("python") => Some(RuntimeLanguage::Python),
        "r" | "ir" | "irkernel" => Some(RuntimeLanguage::R),
        value if value.starts_with("julia") => Some(RuntimeLanguage::Julia),
        _ => None,
    }
}

fn kernel_executable(argv: &[String], paths: &[PathBuf]) -> Option<PathBuf> {
    let first = Path::new(argv.first()?);
    if first.is_absolute() {
        return executable_file(first)
            .then(|| fs::canonicalize(first).unwrap_or_else(|_| first.to_path_buf()));
    }
    resolve_executable_in_paths(first.as_os_str(), paths)
}

fn invalid_kernel(name: String, resource_dir: &Path, message: String) -> JupyterKernelProbe {
    JupyterKernelProbe {
        display_name: name.clone(),
        name,
        language: None,
        health: RuntimeHealth::Unhealthy,
        resource_dir: resource_dir.to_string_lossy().into_owned(),
        executable: None,
        message: Some(message),
    }
}

fn discover_jupyter_kernels_in(roots: &[PathBuf], paths: &[PathBuf]) -> JupyterKernelInventory {
    let mut kernels = Vec::new();
    let mut names = HashSet::new();
    'roots: for root in roots {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if kernels.len() >= MAX_KERNEL_SPECS {
                break 'roots;
            }
            let resource_dir = entry.path();
            if !resource_dir.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if !names.insert(name.to_ascii_lowercase()) {
                continue;
            }
            let spec_path = resource_dir.join("kernel.json");
            let Ok(metadata) = fs::metadata(&spec_path) else {
                continue;
            };
            if metadata.len() > MAX_KERNEL_SPEC_BYTES {
                kernels.push(invalid_kernel(
                    name,
                    &resource_dir,
                    "kernel.json exceeds the 128 KB discovery limit.".to_string(),
                ));
                continue;
            }
            let source = match fs::read(&spec_path) {
                Ok(source) => source,
                Err(error) => {
                    kernels.push(invalid_kernel(
                        name,
                        &resource_dir,
                        format!("kernel.json could not be read: {error}"),
                    ));
                    continue;
                }
            };
            let spec = match serde_json::from_slice::<KernelSpec>(&source) {
                Ok(spec) if !spec.argv.is_empty() && !spec.display_name.trim().is_empty() => spec,
                Ok(_) => {
                    kernels.push(invalid_kernel(
                        name,
                        &resource_dir,
                        "kernel.json needs a display_name and non-empty argv.".to_string(),
                    ));
                    continue;
                }
                Err(error) => {
                    kernels.push(invalid_kernel(
                        name,
                        &resource_dir,
                        format!("kernel.json is invalid: {error}"),
                    ));
                    continue;
                }
            };
            let executable = kernel_executable(&spec.argv, paths);
            let health = if executable.is_some() {
                RuntimeHealth::Available
            } else {
                RuntimeHealth::Missing
            };
            kernels.push(JupyterKernelProbe {
                name,
                display_name: spec.display_name,
                language: kernel_language(spec.language.as_deref()),
                health,
                resource_dir: resource_dir.to_string_lossy().into_owned(),
                executable: executable.map(|path| path.to_string_lossy().into_owned()),
                message: (health == RuntimeHealth::Missing).then(|| {
                    "The kernel specification is readable, but its argv executable is missing."
                        .to_string()
                }),
            });
        }
    }
    kernels.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
    });
    let health = if kernels
        .iter()
        .any(|kernel| kernel.health == RuntimeHealth::Available)
    {
        RuntimeHealth::Available
    } else if kernels.is_empty() {
        RuntimeHealth::Missing
    } else {
        RuntimeHealth::Unhealthy
    };
    let message = match health {
        RuntimeHealth::Available => None,
        RuntimeHealth::Missing => Some(
            "No Jupyter kernel specifications were found in standard data locations.".to_string(),
        ),
        RuntimeHealth::Unhealthy => Some(
            "Jupyter kernel specifications were found, but none has a healthy executable."
                .to_string(),
        ),
    };
    JupyterKernelInventory {
        health,
        kernels,
        searched_locations: roots
            .iter()
            .map(|root| root.to_string_lossy().into_owned())
            .collect(),
        message,
    }
}

pub fn discover_jupyter_kernels_impl() -> JupyterKernelInventory {
    discover_jupyter_kernels_in(&kernel_roots(), &search_paths())
}

fn setup_failure(language: RuntimeLanguage, stderr: &[u8], stdout: &[u8]) -> HostError {
    let output = if stderr.is_empty() { stdout } else { stderr };
    let text = String::from_utf8_lossy(output);
    let lines = text.lines().collect::<Vec<_>>();
    let diagnostic = lines
        .iter()
        .find_map(|line| {
            let trimmed = line.trim();
            ["ERROR:", "Error", "Erreur", "Fehler", "Errore", "Erro", "Fout"]
                .iter()
                .any(|prefix| trimmed.starts_with(prefix))
                .then_some(trimmed)
        })
        .or_else(|| {
            lines.iter().rev().find_map(|line| {
                let trimmed = line.trim();
                (!trimmed.is_empty()
                    && !trimmed.starts_with('@')
                    && !trimmed.starts_with('[')
                    && trimmed != "Stacktrace:"
                    && trimmed != "Execution halted"
                    && trimmed != "Exécution arrêtée"
                    && !trimmed.starts_with("Calls:")
                    && !trimmed.starts_with("in expression starting at"))
                .then_some(trimmed)
            })
        })
        .unwrap_or("The setup process exited without a diagnostic.")
        .chars()
        .take(MAX_SETUP_DIAGNOSTIC_CHARS)
        .collect::<String>();
    HostError::Integration(format!(
        "Could not set up the {} kernel integration. {}",
        runtime_name(language),
        diagnostic.trim()
    ))
}

fn read_setup_stream(
    mut reader: impl Read,
    stream: &'static str,
    progress: Option<TaskProgressReporter>,
) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let Ok(read) = reader.read(&mut buffer) else {
            break;
        };
        if read == 0 {
            break;
        }
        if let Some(report) = &progress {
            report(stream, &String::from_utf8_lossy(&buffer[..read]));
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.len() > MAX_SETUP_DIAGNOSTIC_CHARS {
            bytes.drain(..bytes.len() - MAX_SETUP_DIAGNOSTIC_CHARS);
        }
    }
    bytes
}

fn run_setup_command(
    executable: &Path,
    arguments: &[OsString],
    root: &Path,
    language: RuntimeLanguage,
    progress: Option<TaskProgressReporter>,
) -> Result<(), HostError> {
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_project_environment(&mut command, language, root);
    if let Some(report) = &progress {
        report(
            "status",
            &format!("Starting {} setup…\n", runtime_name(language)),
        );
    }
    let mut child = command.spawn().map_err(|error| {
        HostError::Integration(format!(
            "Could not start {} kernel setup: {error}",
            runtime_name(language)
        ))
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        HostError::Integration("The setup process did not expose stdout.".to_string())
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        HostError::Integration("The setup process did not expose stderr.".to_string())
    })?;
    let stdout_progress = progress.clone();
    let stderr_progress = progress.clone();
    let stdout_reader = thread::spawn(move || read_setup_stream(stdout, "stdout", stdout_progress));
    let stderr_reader = thread::spawn(move || read_setup_stream(stderr, "stderr", stderr_progress));
    let status = child.wait().map_err(|error| {
        HostError::Integration(format!(
            "Could not wait for {} kernel setup: {error}",
            runtime_name(language)
        ))
    })?;
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    if let Some(report) = &progress {
        report(
            "status",
            if status.success() {
                "Setup command finished successfully.\n"
            } else {
                "Setup command exited with an error.\n"
            },
        );
    }
    if status.success() {
        Ok(())
    } else {
        Err(setup_failure(language, &stderr, &stdout))
    }
}

fn setup_kernel_name(language: RuntimeLanguage, executable: &Path, root: &Path) -> String {
    let mut digest = Sha256::new();
    digest.update(executable.as_os_str().to_string_lossy().as_bytes());
    if language == RuntimeLanguage::Julia {
        digest.update(root.as_os_str().to_string_lossy().as_bytes());
    }
    let suffix = digest
        .finalize()
        .iter()
        .take(5)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(
        "draftmatter-{}-{suffix}",
        runtime_name(language).to_ascii_lowercase()
    )
}

pub(crate) fn setup_runtime_executable(
    language: RuntimeLanguage,
    selected: Option<&str>,
) -> Result<PathBuf, HostError> {
    let Some(selected) = selected else {
        return resolve_runtime_executable(language).ok_or_else(|| {
            HostError::NotFound(format!(
                "{} is not installed or is not visible to DraftMatter. Install the runtime, then detect environments again.",
                runtime_name(language)
            ))
        });
    };
    let path = PathBuf::from(selected);
    if !path.is_absolute() {
        return Err(HostError::InvalidPath(
            "The selected execution environment must use an absolute runtime path.".to_string(),
        ));
    }
    let executable = fs::canonicalize(&path).map_err(|error| {
        HostError::NotFound(format!(
            "The selected {} environment is no longer available at {}: {error}",
            runtime_name(language),
            path.display()
        ))
    })?;
    if !executable_file(&executable) {
        return Err(HostError::NotFound(format!(
            "The selected {} environment is not executable: {}",
            runtime_name(language),
            executable.display()
        )));
    }
    let probe = run_version_probe(&executable).map_err(HostError::Integration)?;
    if !probe.success {
        return Err(HostError::Integration(format!(
            "The selected {} environment did not pass its version check: {}",
            runtime_name(language),
            first_output_line(&probe).unwrap_or_else(|| "no diagnostic was returned".to_string())
        )));
    }
    Ok(executable)
}

fn julia_setup_expression(root: &Path, display_name: &str) -> String {
    let project = root
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!(
        "using Pkg; project = \"{}\"; Pkg.activate(project); project_file = Base.active_project(); isfile(project_file) || write(project_file, \"[deps]\\n\"); Pkg.instantiate(); Pkg.resolve(); Pkg.add(\"IJulia\"); using IJulia; IJulia.installkernel(\"{}\", \"--startup-file=no\", \"--project=.\"; env=Dict(\"JULIA_PROJECT\" => project))",
        project, display_name
    )
}

fn user_jupyter_kernel_root() -> Result<PathBuf, HostError> {
    if let Some(path) = env::var_os("JUPYTER_DATA_DIR") {
        return Ok(PathBuf::from(path).join("kernels"));
    }
    if cfg!(target_os = "macos") {
        return env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join("Library/Jupyter/kernels"))
            .ok_or_else(|| {
                HostError::Integration(
                    "Could not locate the current macOS user directory for R kernel registration."
                        .to_string(),
                )
            });
    }
    if cfg!(windows) {
        return env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("jupyter/kernels"))
            .ok_or_else(|| HostError::Integration(
                "Could not locate the current Windows application-data directory for R kernel registration."
                    .to_string(),
            ));
    }
    env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME")
                .map(PathBuf::from)
                .map(|path| path.join(".local/share"))
        })
        .map(|path| path.join("jupyter/kernels"))
        .ok_or_else(|| {
            HostError::Integration(
                "Could not locate the current user data directory for R kernel registration."
                    .to_string(),
            )
        })
}

fn r_kernel_executable(rscript: &Path) -> Result<PathBuf, HostError> {
    let executable_name = if cfg!(windows) { "R.exe" } else { "R" };
    let candidate = rscript.with_file_name(executable_name);
    let executable = fs::canonicalize(&candidate).map_err(|error| {
        HostError::Integration(format!(
            "IRkernel is available, but its R executable was not found beside Rscript at {}: {error}",
            candidate.display()
        ))
    })?;
    if !executable_file(&executable) {
        return Err(HostError::Integration(format!(
            "IRkernel is available, but its R executable is not runnable: {}",
            executable.display()
        )));
    }
    Ok(executable)
}

fn write_r_kernel_spec_in(
    kernel_root: &Path,
    rscript: &Path,
    kernel_name: &str,
    display_name: &str,
) -> Result<(), HostError> {
    let executable = r_kernel_executable(rscript)?;
    let resource_dir = kernel_root.join(kernel_name);
    fs::create_dir_all(&resource_dir).map_err(|error| {
        HostError::Integration(format!(
            "IRkernel was installed, but DraftMatter could not create {}: {error}",
            resource_dir.display()
        ))
    })?;
    let spec = KernelSpec {
        argv: vec![
            executable.to_string_lossy().into_owned(),
            "--slave".to_string(),
            "-e".to_string(),
            "IRkernel::main()".to_string(),
            "--args".to_string(),
            "{connection_file}".to_string(),
        ],
        display_name: display_name.to_string(),
        language: Some("R".to_string()),
    };
    let encoded = serde_json::to_vec_pretty(&spec).map_err(|error| {
        HostError::Integration(format!("Could not encode the R kernelspec: {error}"))
    })?;
    let spec_path = resource_dir.join("kernel.json");
    fs::write(&spec_path, encoded).map_err(|error| {
        HostError::Integration(format!(
            "IRkernel was installed, but DraftMatter could not write {}: {error}",
            spec_path.display()
        ))
    })
}

fn write_r_kernel_spec(
    rscript: &Path,
    kernel_name: &str,
    display_name: &str,
) -> Result<(), HostError> {
    write_r_kernel_spec_in(
        &user_jupyter_kernel_root()?,
        rscript,
        kernel_name,
        display_name,
    )
}

pub fn setup_kernel_integration_with_progress_impl(
    raw_root: &str,
    language: RuntimeLanguage,
    selected_environment: Option<&str>,
    progress: Option<TaskProgressReporter>,
) -> Result<KernelIntegrationSetupResult, HostError> {
    let root = canonical_root(raw_root)?;
    let executable = setup_runtime_executable(language, selected_environment)?;
    let kernel_name = setup_kernel_name(language, &executable, &root);
    let display_name = format!("{} · DraftMatter", runtime_name(language));
    match language {
        RuntimeLanguage::Python => {
            run_setup_command(
                &executable,
                &[
                    OsString::from("-m"),
                    OsString::from("pip"),
                    OsString::from("install"),
                    OsString::from("ipykernel"),
                ],
                &root,
                language,
                progress.clone(),
            )?;
            run_setup_command(
                &executable,
                &[
                    OsString::from("-m"),
                    OsString::from("ipykernel"),
                    OsString::from("install"),
                    OsString::from("--user"),
                    OsString::from("--name"),
                    OsString::from(&kernel_name),
                    OsString::from("--display-name"),
                    OsString::from(&display_name),
                ],
                &root,
                language,
                progress.clone(),
            )?;
        }
        RuntimeLanguage::R => {
            let expression = "user_lib <- path.expand(Sys.getenv('R_LIBS_USER')); if (nzchar(user_lib)) { dir.create(user_lib, recursive=TRUE, showWarnings=FALSE); .libPaths(c(user_lib, .libPaths())) }; if (!requireNamespace('IRkernel', quietly=TRUE)) install.packages('IRkernel', repos='https://cloud.r-project.org', lib=if (nzchar(user_lib)) user_lib else NULL); if (!requireNamespace('IRkernel', quietly=TRUE)) stop('IRkernel could not be loaded after installation')";
            run_setup_command(
                &executable,
                &[
                    OsString::from("--vanilla"),
                    OsString::from("-e"),
                    OsString::from(expression),
                ],
                &root,
                language,
                progress.clone(),
            )?;
            if let Some(report) = &progress {
                report("status", "Registering the R kernel with DraftMatter…\n");
            }
            write_r_kernel_spec(&executable, &kernel_name, &display_name)?;
        }
        RuntimeLanguage::Julia => {
            let expression = julia_setup_expression(&root, &display_name);
            run_setup_command(
                &executable,
                &[
                    OsString::from("--startup-file=no"),
                    OsString::from("--history-file=no"),
                    OsString::from(JULIA_PROJECT_ARGUMENT),
                    OsString::from("-e"),
                    OsString::from(expression),
                ],
                &root,
                language,
                progress.clone(),
            )?;
        }
    }
    let inventory = discover_jupyter_kernels_impl();
    let installed = inventory
        .kernels
        .iter()
        .find(|kernel| {
            kernel.language == Some(language)
                && kernel.health == RuntimeHealth::Available
                && (kernel.name == kernel_name
                    || kernel.display_name.contains("DraftMatter"))
        })
        .map(|kernel| kernel.name.clone());
    if installed.is_none() {
        return Err(HostError::Integration(format!(
            "{} kernel integration was installed, but its kernelspec was not found. Detect environments again; if it remains absent, repair the selected environment.",
            runtime_name(language)
        )));
    }
    Ok(KernelIntegrationSetupResult {
        language,
        kernel_name: installed,
        inventory,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn make_executable(path: &Path) {
        fs::write(path, b"runtime fixture").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn resolves_each_runtime_without_inferring_another() {
        let temporary = tempdir().unwrap();
        let root = temporary.path();
        for name in ["python3", "Rscript", "julia"] {
            make_executable(&root.join(name));
        }
        let paths = [root.to_path_buf()];

        assert!(resolve_runtime(RuntimeLanguage::Python, &paths)
            .unwrap()
            .ends_with("python3"));
        assert!(resolve_runtime(RuntimeLanguage::R, &paths)
            .unwrap()
            .ends_with("Rscript"));
        assert!(resolve_runtime(RuntimeLanguage::Julia, &paths)
            .unwrap()
            .ends_with("julia"));
    }

    #[test]
    fn kernel_setup_rejects_an_ambiguous_relative_environment_path() {
        let error = setup_runtime_executable(RuntimeLanguage::Python, Some("env/bin/python"))
            .unwrap_err();
        assert!(matches!(error, HostError::InvalidPath(_)));
    }

    #[test]
    fn draftmatter_kernel_names_are_safe_and_environment_specific() {
        let executable = Path::new("/opt/research/python");
        let first = setup_kernel_name(RuntimeLanguage::Python, executable, Path::new("/project-a"));
        let second = setup_kernel_name(RuntimeLanguage::Python, executable, Path::new("/project-b"));
        let julia_first = setup_kernel_name(RuntimeLanguage::Julia, Path::new("/opt/julia"), Path::new("/project-a"));
        let julia_second = setup_kernel_name(RuntimeLanguage::Julia, Path::new("/opt/julia"), Path::new("/project-b"));
        assert_eq!(first, second);
        assert_ne!(julia_first, julia_second);
        assert!(first.chars().all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'));
    }

    #[test]
    fn activates_only_julia_in_the_open_project_environment() {
        let root = Path::new("project-root");
        let mut julia = Command::new("julia");
        configure_project_environment(&mut julia, RuntimeLanguage::Julia, root);
        let julia_project = julia
            .get_envs()
            .find(|(name, _)| *name == OsStr::new("JULIA_PROJECT"))
            .and_then(|(_, value)| value);
        let julia_load_path = julia
            .get_envs()
            .find(|(name, _)| *name == OsStr::new("JULIA_LOAD_PATH"))
            .and_then(|(_, value)| value);
        assert_eq!(julia_project, Some(root.as_os_str()));
        assert_eq!(
            julia_load_path,
            env::join_paths([OsStr::new("@"), OsStr::new("@stdlib")])
                .ok()
                .as_deref()
        );

        let mut python = Command::new("python");
        configure_project_environment(&mut python, RuntimeLanguage::Python, root);
        assert!(!python
            .get_envs()
            .any(|(name, _)| name == OsStr::new("JULIA_PROJECT")));
        assert!(!python
            .get_envs()
            .any(|(name, _)| name == OsStr::new("JULIA_LOAD_PATH")));
    }

    #[test]
    fn reads_kernel_specs_without_starting_their_executable() {
        let temporary = tempdir().unwrap();
        let kernels = temporary.path().join("kernels");
        let python = kernels.join("python-fixture");
        let missing = kernels.join("julia-missing");
        let bin = temporary.path().join("bin");
        fs::create_dir_all(&python).unwrap();
        fs::create_dir_all(&missing).unwrap();
        fs::create_dir_all(&bin).unwrap();
        make_executable(&bin.join("python-fixture"));
        fs::write(
            python.join("kernel.json"),
            r#"{"argv":["python-fixture","-m","ipykernel_launcher","-f","{connection_file}"],"display_name":"Fixture Python","language":"python"}"#,
        )
        .unwrap();
        fs::write(
            missing.join("kernel.json"),
            r#"{"argv":["missing-julia","-i","--startup-file=yes","{connection_file}"],"display_name":"Missing Julia","language":"julia"}"#,
        )
        .unwrap();

        let inventory = discover_jupyter_kernels_in(&[kernels], &[bin]);

        assert_eq!(inventory.health, RuntimeHealth::Available);
        assert_eq!(inventory.kernels.len(), 2);
        assert_eq!(inventory.kernels[0].language, Some(RuntimeLanguage::Python));
        assert_eq!(inventory.kernels[0].health, RuntimeHealth::Available);
        assert_eq!(inventory.kernels[1].language, Some(RuntimeLanguage::Julia));
        assert_eq!(inventory.kernels[1].health, RuntimeHealth::Missing);
    }

    #[test]
    fn reports_invalid_kernel_specs_without_hiding_them() {
        let temporary = tempdir().unwrap();
        let resource = temporary.path().join("kernels/broken");
        fs::create_dir_all(&resource).unwrap();
        fs::write(resource.join("kernel.json"), b"{").unwrap();

        let inventory = discover_jupyter_kernels_in(&[temporary.path().join("kernels")], &[]);

        assert_eq!(inventory.health, RuntimeHealth::Unhealthy);
        assert_eq!(inventory.kernels[0].name, "broken");
        assert_eq!(inventory.kernels[0].health, RuntimeHealth::Unhealthy);
    }

    #[test]
    fn setup_errors_prefer_the_runtime_diagnostic_over_a_stack_frame() {
        let error = setup_failure(
            RuntimeLanguage::Julia,
            b"ERROR: IJulia could not be installed\nStacktrace:\n [1] error(s::String)\n @ Base ./client.jl:550\n",
            b"",
        )
        .to_string();

        assert!(error.contains("IJulia could not be installed"));
        assert!(!error.contains("client.jl:550"));
    }

    #[test]
    fn setup_errors_prefer_the_r_error_over_execution_halted() {
        let error = setup_failure(
            RuntimeLanguage::R,
            "Erreur dans IRkernel::installspec() : jupyter-client has to be installed\nAppels : <Anonymous>\nExécution arrêtée\n".as_bytes(),
            b"",
        )
        .to_string();

        assert!(error.contains("jupyter-client has to be installed"));
        assert!(!error.ends_with("Exécution arrêtée"));
    }

    #[test]
    fn writes_a_discoverable_r_kernel_without_a_jupyter_launcher() {
        let temporary = tempdir().unwrap();
        let bin = temporary.path().join("bin");
        let kernels = temporary.path().join("kernels");
        fs::create_dir_all(&bin).unwrap();
        let rscript = bin.join(if cfg!(windows) {
            "Rscript.exe"
        } else {
            "Rscript"
        });
        let r = bin.join(if cfg!(windows) { "R.exe" } else { "R" });
        make_executable(&rscript);
        make_executable(&r);

        write_r_kernel_spec_in(
            &kernels,
            &rscript,
            "draftmatter-r-fixture",
            "R · DraftMatter",
        )
        .unwrap();
        let inventory = discover_jupyter_kernels_in(&[kernels.clone()], &[]);
        let kernel = inventory
            .kernels
            .iter()
            .find(|kernel| kernel.name == "draftmatter-r-fixture")
            .unwrap();
        let spec = serde_json::from_slice::<KernelSpec>(
            &fs::read(kernels.join("draftmatter-r-fixture/kernel.json")).unwrap(),
        )
        .unwrap();

        assert_eq!(kernel.language, Some(RuntimeLanguage::R));
        assert_eq!(kernel.health, RuntimeHealth::Available);
        assert_eq!(spec.argv[0], fs::canonicalize(r).unwrap().to_string_lossy());
        assert_eq!(
            spec.argv[1..],
            [
                "--slave",
                "-e",
                "IRkernel::main()",
                "--args",
                "{connection_file}"
            ]
        );
        assert_eq!(spec.display_name, "R · DraftMatter");
    }

    #[test]
    fn julia_setup_never_switches_back_to_the_global_environment() {
        let expression = julia_setup_expression(Path::new("/research/project"), "Julia · DraftMatter");

        assert!(expression.contains("Pkg.activate(project)"));
        assert!(!expression.contains("Pkg.activate();"));
        assert!(expression.contains("Pkg.add(\"IJulia\")"));
        assert!(expression.contains("installkernel(\"Julia · DraftMatter\", \"--startup-file=no\", \"--project=.\""));
    }
}

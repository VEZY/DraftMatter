use serde::{Deserialize, Serialize};
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Deserialize)]
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
}

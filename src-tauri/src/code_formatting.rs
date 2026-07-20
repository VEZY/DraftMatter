use crate::execution_trust::{require_execution_trust, ExecutionTrustStore};
use crate::runtime::{configure_project_environment, setup_runtime_executable, RuntimeLanguage};
use crate::{canonical_root, HostError, TaskProgressReporter};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const FORMAT_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const MAX_FORMAT_BYTES: usize = 4 * 1024 * 1024;
const MAX_INSTALL_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

const R_FORMAT_SCRIPT: &str = r#"
if (!requireNamespace("styler", quietly = TRUE)) stop("styler is not installed")
invisible(capture.output(styler::cache_deactivate()))
input <- paste(readLines(file("stdin"), warn = FALSE), collapse = "\n")
cat(styler::style_text(input), sep = "\n")
"#;

const R_INSTALL_SCRIPT: &str = r#"
user_lib <- path.expand(Sys.getenv("R_LIBS_USER"))
if (nzchar(user_lib)) {
  dir.create(user_lib, recursive = TRUE, showWarnings = FALSE)
  .libPaths(c(user_lib, .libPaths()))
}
install.packages("styler", repos = "https://cloud.r-project.org", lib = if (nzchar(user_lib)) user_lib else NULL)
if (!requireNamespace("styler", quietly = TRUE)) stop("styler could not be loaded after installation")
cat(as.character(packageVersion("styler")))
"#;

const R_PROBE_SCRIPT: &str = r#"
if (!requireNamespace("styler", quietly = TRUE)) quit(status = 1)
cat(as.character(packageVersion("styler")))
"#;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodeFormatterRequest {
    pub root: String,
    pub language: RuntimeLanguage,
    pub executable: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodeFormatRequest {
    pub root: String,
    pub language: RuntimeLanguage,
    pub executable: Option<String>,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodeFormatterStatus {
    pub language: RuntimeLanguage,
    pub package: String,
    pub available: bool,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodeFormatResult {
    pub code: String,
    pub changed: bool,
}

struct ProcessOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn formatter_package(language: RuntimeLanguage) -> Result<&'static str, HostError> {
    match language {
        RuntimeLanguage::Python => Ok("Ruff"),
        RuntimeLanguage::R => Ok("styler"),
        RuntimeLanguage::Julia => Err(HostError::InvalidProject(
            "Julia formatting is managed through JuliaFormatter in the Julia packages panel."
                .to_string(),
        )),
    }
}

fn trusted_root(raw_root: &str, trust: &ExecutionTrustStore) -> Result<PathBuf, HostError> {
    let root = canonical_root(raw_root)?;
    require_execution_trust(&root, trust)?;
    Ok(root)
}

fn runtime_executable(request: &CodeFormatterRequest) -> Result<PathBuf, HostError> {
    formatter_package(request.language)?;
    setup_runtime_executable(request.language, request.executable.as_deref())
}

fn drain_bounded(
    mut reader: impl Read,
    limit: usize,
    stream: &'static str,
    progress: Option<TaskProgressReporter>,
) -> Vec<u8> {
    let mut retained = Vec::new();
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
        let remaining = limit.saturating_sub(retained.len());
        retained.extend_from_slice(&buffer[..read.min(remaining)]);
    }
    retained
}

fn run_process(
    executable: &Path,
    arguments: &[OsString],
    root: &Path,
    language: RuntimeLanguage,
    input: Option<&[u8]>,
    timeout: Duration,
    output_limit: usize,
    progress: Option<TaskProgressReporter>,
) -> Result<ProcessOutput, HostError> {
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .current_dir(root)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_project_environment(&mut command, language, root);
    if let Some(report) = &progress {
        report(
            "status",
            &format!(
                "Starting {} formatter package setup…\n",
                formatter_package(language)?
            ),
        );
    }
    let mut child = command.spawn().map_err(|error| {
        HostError::Integration(format!(
            "Could not start the {} runtime: {error}",
            formatter_package(language).unwrap_or("code formatter")
        ))
    })?;
    if let Some(bytes) = input {
        let mut stdin = child.stdin.take().ok_or_else(|| {
            HostError::Integration("The formatter did not expose its input stream.".to_string())
        })?;
        stdin.write_all(bytes).map_err(|error| {
            HostError::Integration(format!(
                "Could not send source code to the formatter: {error}"
            ))
        })?;
    }
    let stdout = child.stdout.take().ok_or_else(|| {
        HostError::Integration("The formatter did not expose standard output.".to_string())
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        HostError::Integration("The formatter did not expose standard error.".to_string())
    })?;
    let stdout_progress = progress.clone();
    let stderr_progress = progress.clone();
    let stdout_reader =
        thread::spawn(move || drain_bounded(stdout, output_limit, "stdout", stdout_progress));
    let stderr_reader =
        thread::spawn(move || drain_bounded(stderr, output_limit, "stderr", stderr_progress));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(HostError::Integration(format!(
                    "The formatter did not finish within {} seconds.",
                    timeout.as_secs()
                )));
            }
            Err(error) => {
                return Err(HostError::Integration(format!(
                    "Could not read the formatter process status: {error}"
                )))
            }
        }
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    if let Some(report) = &progress {
        let message = if status.success() {
            "Formatter package setup finished successfully.\n"
        } else {
            "Formatter package setup exited with an error.\n"
        };
        report("status", message);
    }
    Ok(ProcessOutput {
        success: status.success(),
        stdout,
        stderr,
    })
}

fn command_arguments(language: RuntimeLanguage, action: &str) -> Vec<OsString> {
    let arguments: Vec<&str> = match (language, action) {
        (RuntimeLanguage::Python, "probe") => vec!["-m", "ruff", "--version"],
        (RuntimeLanguage::Python, "install") => vec!["-m", "pip", "install", "ruff"],
        (RuntimeLanguage::Python, "format") => vec![
            "-m",
            "ruff",
            "format",
            "--no-cache",
            "--stdin-filename",
            "draftmatter_cell.py",
            "-",
        ],
        (RuntimeLanguage::R, "probe") => vec!["--vanilla", "--slave", "-e", R_PROBE_SCRIPT],
        (RuntimeLanguage::R, "install") => vec!["--vanilla", "--slave", "-e", R_INSTALL_SCRIPT],
        (RuntimeLanguage::R, "format") => vec!["--vanilla", "--slave", "-e", R_FORMAT_SCRIPT],
        _ => return Vec::new(),
    };
    arguments.into_iter().map(OsString::from).collect()
}

fn diagnostic(output: &ProcessOutput) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let source = if stderr.trim().is_empty() {
        stdout.as_ref()
    } else {
        stderr.as_ref()
    };
    source
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("The formatter exited without a diagnostic.")
        .trim()
        .chars()
        .take(1_200)
        .collect()
}

fn probe_with_executable(
    root: &Path,
    executable: &Path,
    language: RuntimeLanguage,
) -> Result<CodeFormatterStatus, HostError> {
    let package = formatter_package(language)?.to_string();
    let output = run_process(
        executable,
        &command_arguments(language, "probe"),
        root,
        language,
        None,
        FORMAT_TIMEOUT,
        MAX_FORMAT_BYTES,
        None,
    )?;
    let version = output.success.then(|| {
        let raw = String::from_utf8_lossy(&output.stdout);
        let trimmed = raw.trim();
        trimmed.strip_prefix("ruff ").unwrap_or(trimmed).to_string()
    });
    Ok(CodeFormatterStatus {
        language,
        package,
        available: output.success,
        version,
    })
}

fn format_with_executable(
    root: &Path,
    executable: &Path,
    language: RuntimeLanguage,
    code: String,
) -> Result<CodeFormatResult, HostError> {
    let output = run_process(
        executable,
        &command_arguments(language, "format"),
        root,
        language,
        Some(code.as_bytes()),
        FORMAT_TIMEOUT,
        MAX_FORMAT_BYTES,
        None,
    )?;
    if !output.success {
        return Err(HostError::Integration(format!(
            "{} could not format this {} cell. Install or repair the formatter from Local runtimes, then try again. ({})",
            formatter_package(language)?,
            match language {
                RuntimeLanguage::Python => "Python",
                RuntimeLanguage::R => "R",
                RuntimeLanguage::Julia => "Julia",
            },
            diagnostic(&output)
        )));
    }
    let formatted = String::from_utf8(output.stdout).map_err(|_| {
        HostError::Integration(format!(
            "{} returned source code that is not valid UTF-8.",
            formatter_package(language).unwrap_or("The formatter")
        ))
    })?;
    Ok(CodeFormatResult {
        changed: formatted != code,
        code: formatted,
    })
}

pub fn probe_code_formatter_impl(
    request: CodeFormatterRequest,
    trust: &ExecutionTrustStore,
) -> Result<CodeFormatterStatus, HostError> {
    let root = trusted_root(&request.root, trust)?;
    let executable = runtime_executable(&request)?;
    probe_with_executable(&root, &executable, request.language)
}

pub fn install_code_formatter_with_progress_impl(
    request: CodeFormatterRequest,
    trust: &ExecutionTrustStore,
    progress: Option<TaskProgressReporter>,
) -> Result<CodeFormatterStatus, HostError> {
    let root = trusted_root(&request.root, trust)?;
    let executable = runtime_executable(&request)?;
    let output = run_process(
        &executable,
        &command_arguments(request.language, "install"),
        &root,
        request.language,
        None,
        INSTALL_TIMEOUT,
        MAX_INSTALL_OUTPUT_BYTES,
        progress,
    )?;
    if !output.success {
        return Err(HostError::Integration(format!(
            "Could not install {} in the selected runtime. {}",
            formatter_package(request.language)?,
            diagnostic(&output)
        )));
    }
    probe_with_executable(&root, &executable, request.language)
}

pub fn format_code_impl(
    request: CodeFormatRequest,
    trust: &ExecutionTrustStore,
) -> Result<CodeFormatResult, HostError> {
    let root = trusted_root(&request.root, trust)?;
    if request.code.len() > MAX_FORMAT_BYTES {
        return Err(HostError::UnsupportedFile(
            "A code cell cannot exceed 4 MB for formatting.".to_string(),
        ));
    }
    let formatter_request = CodeFormatterRequest {
        root: request.root,
        language: request.language,
        executable: request.executable,
    };
    let executable = runtime_executable(&formatter_request)?;
    format_with_executable(&root, &executable, request.language, request.code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[cfg(unix)]
    fn fake_formatter(root: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let executable = root.join("fake-runtime");
        fs::write(
            &executable,
            "#!/bin/sh\ncase \"$*\" in\n  *--version*) printf 'ruff 0.12.0\\n' ;;\n  *ruff*format*) sed 's/x=1/x = 1/' ;;\n  *styler::style_text*) sed 's/x<-1/x <- 1/' ;;\n  *) printf '0.12.0\\n' ;;\nesac\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).unwrap();
        executable
    }

    #[cfg(unix)]
    #[test]
    fn formats_python_through_ruff_without_bundling_it() {
        let temporary = tempdir().unwrap();
        let executable = fake_formatter(temporary.path());
        let result = format_with_executable(
            temporary.path(),
            &executable,
            RuntimeLanguage::Python,
            "x=1\n".to_string(),
        )
        .unwrap();
        assert!(result.changed);
        assert_eq!(result.code, "x = 1\n");
    }

    #[cfg(unix)]
    #[test]
    fn detects_the_external_ruff_package_version() {
        let temporary = tempdir().unwrap();
        let executable = fake_formatter(temporary.path());
        let status =
            probe_with_executable(temporary.path(), &executable, RuntimeLanguage::Python).unwrap();
        assert_eq!(status.package, "Ruff");
        assert_eq!(status.version.as_deref(), Some("0.12.0"));
    }

    #[cfg(unix)]
    #[test]
    fn formats_r_through_styler_without_bundling_it() {
        let temporary = tempdir().unwrap();
        let executable = fake_formatter(temporary.path());
        let result = format_with_executable(
            temporary.path(),
            &executable,
            RuntimeLanguage::R,
            "x<-1\n".to_string(),
        )
        .unwrap();
        assert!(result.changed);
        assert_eq!(result.code, "x <- 1\n");
        assert!(R_FORMAT_SCRIPT.contains("cache_deactivate"));
    }

    #[test]
    fn formatter_packages_are_runtime_scoped() {
        assert_eq!(formatter_package(RuntimeLanguage::Python).unwrap(), "Ruff");
        assert_eq!(formatter_package(RuntimeLanguage::R).unwrap(), "styler");
        assert!(formatter_package(RuntimeLanguage::Julia).is_err());
    }
}

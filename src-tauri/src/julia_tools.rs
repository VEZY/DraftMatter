use crate::execution_trust::{require_execution_trust, ExecutionTrustStore};
use crate::runtime::{configure_project_environment, resolve_runtime_executable, RuntimeLanguage};
use crate::{canonical_root, HostError};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const PACKAGE_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const FORMAT_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const MAX_PACKAGE_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_FORMAT_BYTES: usize = 4 * 1024 * 1024;
const PACKAGE_MARKER: &str = "DRAFTMATTER_PACKAGE\t";

const LIST_PACKAGES_SCRIPT: &str = r#"
# DRAFTMATTER_LIST_PACKAGES
using Pkg
Pkg.activate(ARGS[1])
for dependency in sort!(collect(values(Pkg.dependencies())); by = item -> lowercase(item.name))
    dependency.is_direct_dep || continue
    version = isnothing(dependency.version) ? "" : string(dependency.version)
    kind = dependency.is_stdlib ? "stdlib" : "package"
    println("DRAFTMATTER_PACKAGE\t", dependency.name, "\t", version, "\t", kind)
end
"#;

const ADD_PACKAGE_SCRIPT: &str = r#"
# DRAFTMATTER_ADD_PACKAGE
using Pkg
Pkg.activate(ARGS[1])
Pkg.add(PackageSpec(name = ARGS[2]))
Pkg.resolve()
for dependency in sort!(collect(values(Pkg.dependencies())); by = item -> lowercase(item.name))
    dependency.is_direct_dep || continue
    version = isnothing(dependency.version) ? "" : string(dependency.version)
    kind = dependency.is_stdlib ? "stdlib" : "package"
    println("DRAFTMATTER_PACKAGE\t", dependency.name, "\t", version, "\t", kind)
end
"#;

const REMOVE_PACKAGE_SCRIPT: &str = r#"
# DRAFTMATTER_REMOVE_PACKAGE
using Pkg
Pkg.activate(ARGS[1])
Pkg.rm(PackageSpec(name = ARGS[2]))
Pkg.resolve()
for dependency in sort!(collect(values(Pkg.dependencies())); by = item -> lowercase(item.name))
    dependency.is_direct_dep || continue
    version = isnothing(dependency.version) ? "" : string(dependency.version)
    kind = dependency.is_stdlib ? "stdlib" : "package"
    println("DRAFTMATTER_PACKAGE\t", dependency.name, "\t", version, "\t", kind)
end
"#;

const FORMAT_SCRIPT: &str = r#"
# DRAFTMATTER_FORMAT_JULIA
using JuliaFormatter
print(JuliaFormatter.format_text(read(stdin, String)))
"#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JuliaPackage {
    pub name: String,
    pub version: Option<String>,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JuliaEnvironment {
    pub packages: Vec<JuliaPackage>,
    pub project_file: bool,
    pub manifest_file: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JuliaPackageRequest {
    pub root: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JuliaFormatRequest {
    pub root: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JuliaFormatResult {
    pub code: String,
    pub changed: bool,
}

#[derive(Debug, Clone, Copy)]
enum PackageAction<'a> {
    List,
    Add(&'a str),
    Remove(&'a str),
}

struct ProcessOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn valid_package_name(name: &str) -> bool {
    let mut characters = name.chars();
    matches!(characters.next(), Some(first) if first.is_ascii_alphabetic())
        && name.len() <= 128
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn drain_bounded(mut reader: impl Read, limit: usize) -> Vec<u8> {
    let mut retained = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let Ok(read) = reader.read(&mut buffer) else {
            break;
        };
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(retained.len());
        retained.extend_from_slice(&buffer[..read.min(remaining)]);
    }
    retained
}

fn run_julia(
    executable: &Path,
    root: &Path,
    script: &str,
    arguments: &[String],
    input: Option<&[u8]>,
    timeout: Duration,
    output_limit: usize,
) -> Result<ProcessOutput, HostError> {
    let mut project_argument = OsString::from("--project=");
    project_argument.push(root.as_os_str());
    let mut command = Command::new(executable);
    command
        .arg("--startup-file=no")
        .arg("--history-file=no")
        .arg("--color=no")
        .arg(project_argument)
        .arg("-e")
        .arg(script)
        .arg(root)
        .args(arguments)
        .current_dir(root)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_project_environment(&mut command, RuntimeLanguage::Julia, root);
    let mut child = command
        .spawn()
        .map_err(|error| HostError::Integration(format!("Could not start Julia: {error}")))?;

    if let Some(bytes) = input {
        let mut stdin = child.stdin.take().ok_or_else(|| {
            HostError::Integration("Julia did not expose its formatter input stream.".to_string())
        })?;
        stdin.write_all(bytes).map_err(|error| {
            HostError::Integration(format!("Could not send code to JuliaFormatter: {error}"))
        })?;
    }

    let stdout = child.stdout.take().ok_or_else(|| {
        HostError::Integration("Julia did not expose its standard output stream.".to_string())
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        HostError::Integration("Julia did not expose its error output stream.".to_string())
    })?;
    let stdout_reader = thread::spawn(move || drain_bounded(stdout, output_limit));
    let stderr_reader = thread::spawn(move || drain_bounded(stderr, output_limit));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(HostError::Integration(format!(
                    "Julia did not finish within {} seconds.",
                    timeout.as_secs()
                )));
            }
            Err(error) => {
                return Err(HostError::Integration(format!(
                    "Could not read Julia's process status: {error}"
                )))
            }
        }
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    Ok(ProcessOutput {
        success: status.success(),
        stdout,
        stderr,
    })
}

fn process_error(output: &ProcessOutput, formatter: bool) -> HostError {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("Julia exited without an error message.")
        .chars()
        .take(800)
        .collect::<String>();
    if formatter && (stderr.contains("JuliaFormatter") || stderr.contains("Package")) {
        HostError::Integration(format!(
            "JuliaFormatter is unavailable in this project. Add JuliaFormatter in the Julia packages panel, then try again. ({detail})"
        ))
    } else {
        HostError::Integration(format!("Julia could not complete the request: {detail}"))
    }
}

fn environment_from_output(
    root: &Path,
    output: &ProcessOutput,
) -> Result<JuliaEnvironment, HostError> {
    if !output.success {
        return Err(process_error(output, false));
    }
    let mut packages = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix(PACKAGE_MARKER))
        .filter_map(|record| {
            let mut fields = record.splitn(3, '\t');
            let name = fields.next()?.to_string();
            let version = fields
                .next()
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let kind = fields.next()?.to_string();
            Some(JuliaPackage {
                name,
                version,
                kind,
            })
        })
        .collect::<Vec<_>>();
    packages.sort_by_key(|package| package.name.to_ascii_lowercase());
    Ok(JuliaEnvironment {
        packages,
        project_file: root.join("Project.toml").is_file(),
        manifest_file: root.join("Manifest.toml").is_file(),
    })
}

fn julia_environment_with_executable(
    root: &Path,
    executable: &Path,
    action: PackageAction<'_>,
) -> Result<JuliaEnvironment, HostError> {
    let (script, arguments) = match action {
        PackageAction::List => (LIST_PACKAGES_SCRIPT, Vec::new()),
        PackageAction::Add(name) => (ADD_PACKAGE_SCRIPT, vec![name.to_string()]),
        PackageAction::Remove(name) => (REMOVE_PACKAGE_SCRIPT, vec![name.to_string()]),
    };
    environment_from_output(
        root,
        &run_julia(
            executable,
            root,
            script,
            &arguments,
            None,
            PACKAGE_TIMEOUT,
            MAX_PACKAGE_OUTPUT_BYTES,
        )?,
    )
}

fn trusted_root(raw_root: &str, trust: &ExecutionTrustStore) -> Result<PathBuf, HostError> {
    let root = canonical_root(raw_root)?;
    require_execution_trust(&root, trust)?;
    Ok(root)
}

fn julia_executable() -> Result<PathBuf, HostError> {
    resolve_runtime_executable(crate::runtime::RuntimeLanguage::Julia).ok_or_else(|| {
        HostError::Integration(
            "Julia was not found on the application PATH. Configure a Julia runtime before managing packages or formatting code."
                .to_string(),
        )
    })
}

pub fn list_julia_packages_impl(
    raw_root: &str,
    trust: &ExecutionTrustStore,
) -> Result<JuliaEnvironment, HostError> {
    let root = trusted_root(raw_root, trust)?;
    julia_environment_with_executable(&root, &julia_executable()?, PackageAction::List)
}

pub fn add_julia_package_impl(
    request: JuliaPackageRequest,
    trust: &ExecutionTrustStore,
) -> Result<JuliaEnvironment, HostError> {
    let root = trusted_root(&request.root, trust)?;
    if !valid_package_name(&request.name) {
        return Err(HostError::InvalidProject(
            "Julia package names must start with a letter and contain only ASCII letters, numbers, and underscores."
                .to_string(),
        ));
    }
    julia_environment_with_executable(
        &root,
        &julia_executable()?,
        PackageAction::Add(&request.name),
    )
}

pub fn remove_julia_package_impl(
    request: JuliaPackageRequest,
    trust: &ExecutionTrustStore,
) -> Result<JuliaEnvironment, HostError> {
    let root = trusted_root(&request.root, trust)?;
    if !valid_package_name(&request.name) {
        return Err(HostError::InvalidProject(
            "Julia package names must start with a letter and contain only ASCII letters, numbers, and underscores."
                .to_string(),
        ));
    }
    julia_environment_with_executable(
        &root,
        &julia_executable()?,
        PackageAction::Remove(&request.name),
    )
}

fn format_julia_code_with_executable(
    root: &Path,
    executable: &Path,
    code: String,
) -> Result<JuliaFormatResult, HostError> {
    let output = run_julia(
        executable,
        root,
        FORMAT_SCRIPT,
        &[],
        Some(code.as_bytes()),
        FORMAT_TIMEOUT,
        MAX_FORMAT_BYTES,
    )?;
    if !output.success {
        return Err(process_error(&output, true));
    }
    let formatted = String::from_utf8(output.stdout).map_err(|_| {
        HostError::Integration("JuliaFormatter returned code that is not valid UTF-8.".to_string())
    })?;
    Ok(JuliaFormatResult {
        changed: formatted != code,
        code: formatted,
    })
}

pub fn format_julia_code_impl(
    request: JuliaFormatRequest,
    trust: &ExecutionTrustStore,
) -> Result<JuliaFormatResult, HostError> {
    let root = trusted_root(&request.root, trust)?;
    if request.code.len() > MAX_FORMAT_BYTES {
        return Err(HostError::UnsupportedFile(
            "A Julia code cell cannot exceed 4 MB for formatting.".to_string(),
        ));
    }
    format_julia_code_with_executable(&root, &julia_executable()?, request.code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[cfg(unix)]
    fn fake_julia(root: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let executable = root.join("fake-julia");
        fs::write(
            &executable,
            r#"#!/bin/sh
project=""
for argument in "$@"; do
  case "$argument" in --project=*) project="${argument#--project=}" ;; esac
done
case "$*" in
  *DRAFTMATTER_ADD_PACKAGE*)
    touch "$project/Project.toml" "$project/Manifest.toml"
    printf 'DRAFTMATTER_PACKAGE\tDataFrames\t1.7.0\tpackage\nDRAFTMATTER_PACKAGE\tJuliaFormatter\t2.2.0\tpackage\n'
    ;;
  *DRAFTMATTER_REMOVE_PACKAGE*)
    printf 'DRAFTMATTER_PACKAGE\tDataFrames\t1.7.0\tpackage\n'
    ;;
  *DRAFTMATTER_LIST_PACKAGES*)
    printf 'DRAFTMATTER_PACKAGE\tStatistics\t1.11.0\tstdlib\nDRAFTMATTER_PACKAGE\tDataFrames\t1.7.0\tpackage\n'
    ;;
  *DRAFTMATTER_FORMAT_JULIA*)
    printf 'x = 1\n'
    ;;
esac
"#,
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        executable
    }

    #[cfg(unix)]
    #[test]
    fn lists_packages_and_reports_project_files() {
        let temporary = tempdir().unwrap();
        let executable = fake_julia(temporary.path());
        let environment =
            julia_environment_with_executable(temporary.path(), &executable, PackageAction::List)
                .unwrap();

        assert_eq!(
            environment
                .packages
                .iter()
                .map(|package| package.name.as_str())
                .collect::<Vec<_>>(),
            vec!["DataFrames", "Statistics"]
        );
        assert!(!environment.project_file);
        assert!(!environment.manifest_file);
    }

    #[cfg(unix)]
    #[test]
    fn adding_a_package_can_create_a_project_and_manifest() {
        let temporary = tempdir().unwrap();
        let executable = fake_julia(temporary.path());
        let environment = julia_environment_with_executable(
            temporary.path(),
            &executable,
            PackageAction::Add("JuliaFormatter"),
        )
        .unwrap();

        assert!(environment.project_file);
        assert!(environment.manifest_file);
        assert_eq!(environment.packages.len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn formats_code_through_the_project_scoped_julia_process() {
        let temporary = tempdir().unwrap();
        let executable = fake_julia(temporary.path());
        let formatted =
            format_julia_code_with_executable(temporary.path(), &executable, "x=1".to_string())
                .unwrap();

        assert!(formatted.changed);
        assert_eq!(formatted.code, "x = 1\n");
    }

    #[test]
    fn package_names_are_passed_only_after_strict_validation() {
        assert!(valid_package_name("JuliaFormatter"));
        assert!(valid_package_name("Package2_jll"));
        assert!(!valid_package_name("Pkg.add(\"Bad\")"));
        assert!(!valid_package_name("../Bad"));
        assert!(!valid_package_name(""));
    }
}

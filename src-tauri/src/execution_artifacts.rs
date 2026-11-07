use crate::{canonical_root, now_millis, safe_relative, HostError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const MAX_INPUTS: usize = 64;
const MAX_ARTIFACTS: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionInput {
    pub path: String,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionArtifactFingerprint {
    pub path: String,
    pub hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecutionArtifactError {
    pub name: String,
    pub message: String,
    pub traceback: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionArtifact {
    pub path: String,
    pub bytes: u64,
    pub hash: String,
    pub media_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionEnvironment {
    pub identity: String,
    pub version: Option<String>,
    pub details: BTreeMap<String, String>,
}

pub(crate) struct RunDirectory(pub(crate) PathBuf);

impl Drop for RunDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) struct ArtifactBackup {
    path: PathBuf,
    backup: Option<PathBuf>,
}

fn integration(message: impl Into<String>) -> HostError {
    HostError::Integration(message.into())
}

pub(crate) fn valid_cell_id(value: &str) -> bool {
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

pub(crate) fn create_run_directory(root: &Path, cell_id: &str) -> Result<RunDirectory, HostError> {
    let parent = crate::contained_path(root, ".draftmatter/execution/tmp")?;
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
        "Could not allocate a unique kernel-execution directory.",
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

pub(crate) fn verify_inputs(root: &Path, inputs: &[ExecutionInput]) -> Result<(), HostError> {
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
) -> Result<Vec<ExecutionInput>, HostError> {
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
            Ok(ExecutionInput { path, hash })
        })
        .collect()
}

pub fn inspect_execution_artifacts_impl(
    root: &str,
    paths: Vec<String>,
) -> Result<Vec<ExecutionArtifactFingerprint>, HostError> {
    if paths.len() > MAX_ARTIFACTS {
        return Err(HostError::InvalidProject(format!(
            "A run may record at most {MAX_ARTIFACTS} artifacts."
        )));
    }
    let root = canonical_root(root)?;
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .map(|path| {
            if !seen.insert(path.clone()) {
                return Err(HostError::InvalidProject(format!(
                    "Execution artifact appears more than once: {path}"
                )));
            }
            let absolute = project_path(&root, &path, true)?;
            let hash = if absolute.is_file() {
                Some(sha256_file(&absolute)?.0)
            } else {
                None
            };
            Ok(ExecutionArtifactFingerprint { path, hash })
        })
        .collect()
}

pub(crate) fn declared_artifacts(
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

pub(crate) fn prepare_artifact_backups(
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

pub(crate) fn restore_artifacts(backups: &[ArtifactBackup]) -> Result<(), HostError> {
    for backup in backups {
        if let Some(source) = &backup.backup {
            fs::copy(source, &backup.path)?;
        } else if backup.path.exists() {
            fs::remove_file(&backup.path)?;
        }
    }
    Ok(())
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

pub(crate) fn collect_artifacts(
    artifacts: &[(String, PathBuf)],
) -> Result<Vec<ExecutionArtifact>, ExecutionArtifactError> {
    artifacts
        .iter()
        .map(|(relative, path)| {
            if !path.is_file() {
                return Err(ExecutionArtifactError {
                    name: "ArtifactMissing".to_string(),
                    message: format!("Declared artifact was not produced: {relative}"),
                    traceback: Vec::new(),
                });
            }
            let (hash, bytes) = sha256_file(path).map_err(|error| ExecutionArtifactError {
                name: "ArtifactUnreadable".to_string(),
                message: format!("Declared artifact could not be read ({relative}): {error}"),
                traceback: Vec::new(),
            })?;
            Ok(ExecutionArtifact {
                path: relative.clone(),
                bytes,
                hash,
                media_type: media_type(path),
            })
        })
        .collect()
}

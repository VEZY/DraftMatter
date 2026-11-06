use crate::{
    canonical_root, checked_path, contained_path, modified_ms, source_hash, write_atomic,
    DocumentSnapshot, HostError,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const MAX_MANIFESTS: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveExecutionManifestRequest {
    pub root: String,
    pub cell_id: String,
    pub content: String,
    pub expected_hash: Option<String>,
}

fn valid_cell_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        })
}

fn manifest_directory_name(cell_id: &str) -> String {
    let readable = cell_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let digest = Sha256::digest(cell_id.as_bytes())
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{readable}--{digest}")
}

fn manifest_path(root: &Path, cell_id: &str) -> Result<PathBuf, HostError> {
    if !valid_cell_id(cell_id) {
        return Err(HostError::InvalidProject(
            "Execution manifest cell IDs may contain only letters, numbers, dots, colons, dashes, and underscores."
                .to_string(),
        ));
    }
    contained_path(
        root,
        &format!(
            ".draftmatter/outputs/{}/manifest.json",
            manifest_directory_name(cell_id)
        ),
    )
}

fn sha256_value(value: Option<&serde_json::Value>) -> bool {
    value
        .and_then(serde_json::Value::as_str)
        .is_some_and(|hash| {
            hash.len() == 71
                && hash.starts_with("sha256:")
                && hash[7..]
                    .chars()
                    .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
        })
}

fn validate_manifest(content: &str, expected_cell_id: Option<&str>) -> Result<String, HostError> {
    if content.len() > MAX_MANIFEST_BYTES {
        return Err(HostError::UnsupportedFile(
            "Execution manifest exceeds the 1 MB safety limit.".to_string(),
        ));
    }
    let value: serde_json::Value = serde_json::from_str(content).map_err(|error| {
        HostError::InvalidProject(format!("Execution manifest is not valid JSON: {error}"))
    })?;
    let object = value.as_object().ok_or_else(|| {
        HostError::InvalidProject("Execution manifest must be a JSON object.".to_string())
    })?;
    if object
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(2)
    {
        return Err(HostError::InvalidProject(
            "Execution manifest schemaVersion must be 2.".to_string(),
        ));
    }
    let cell_id = object
        .get("cellId")
        .and_then(serde_json::Value::as_str)
        .filter(|cell_id| valid_cell_id(cell_id))
        .ok_or_else(|| {
            HostError::InvalidProject("Execution manifest cellId is invalid.".to_string())
        })?;
    if expected_cell_id.is_some_and(|expected| expected != cell_id) {
        return Err(HostError::Conflict(
            "Execution manifest content does not match the requested cell ID.".to_string(),
        ));
    }
    if !matches!(
        object.get("language").and_then(serde_json::Value::as_str),
        Some("python" | "r" | "julia")
    ) || !matches!(
        object.get("status").and_then(serde_json::Value::as_str),
        Some("succeeded" | "failed" | "interrupted")
    ) {
        return Err(HostError::InvalidProject(
            "Execution manifest language or status is invalid.".to_string(),
        ));
    }
    for name in [
        "codeHash",
        "inputsHash",
        "environmentFingerprint",
        "resultHash",
    ] {
        if !sha256_value(object.get(name)) {
            return Err(HostError::InvalidProject(format!(
                "Execution manifest {name} must be a SHA-256 fingerprint."
            )));
        }
    }
    let artifacts = object
        .get("artifacts")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            HostError::InvalidProject("Execution manifest artifacts must be an array.".to_string())
        })?;
    if artifacts.iter().any(|artifact| {
        let Some(artifact) = artifact.as_object() else {
            return true;
        };
        artifact
            .get("path")
            .and_then(serde_json::Value::as_str)
            .is_none()
            || artifact
                .get("bytes")
                .and_then(serde_json::Value::as_u64)
                .is_none()
            || !sha256_value(artifact.get("hash"))
    }) {
        return Err(HostError::InvalidProject(
            "Execution manifest artifact entries are invalid.".to_string(),
        ));
    }
    if object
        .get("sequence")
        .and_then(serde_json::Value::as_u64)
        .is_none()
        || object
            .get("sessionGeneration")
            .and_then(serde_json::Value::as_u64)
            .is_none_or(|value| value < 1)
        || object
            .get("executionSequence")
            .and_then(serde_json::Value::as_u64)
            .is_none_or(|value| value < 1)
        || object
            .get("durationMs")
            .and_then(serde_json::Value::as_u64)
            .is_none()
    {
        return Err(HostError::InvalidProject(
            "Execution manifest sequence, shared-session provenance, or duration is invalid."
                .to_string(),
        ));
    }
    Ok(cell_id.to_string())
}

fn snapshot(root: &Path, path: &Path, content: String) -> Result<DocumentSnapshot, HostError> {
    let metadata = fs::metadata(path)?;
    let relative = path.strip_prefix(root).map_err(|error| {
        HostError::InvalidPath(format!(
            "Could not make an execution manifest path relative: {error}"
        ))
    })?;
    Ok(DocumentSnapshot {
        path: relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/"),
        hash: source_hash(content.as_bytes()),
        content,
        modified_ms: modified_ms(&metadata),
    })
}

pub fn save_execution_manifest_impl(
    request: SaveExecutionManifestRequest,
) -> Result<DocumentSnapshot, HostError> {
    let root = canonical_root(&request.root)?;
    validate_manifest(&request.content, Some(&request.cell_id))?;
    let path = manifest_path(&root, &request.cell_id)?;
    if let Some(expected) = &request.expected_hash {
        let current = fs::read(&path).map_err(|_| {
            HostError::Conflict(
                "Execution manifest disappeared before it could be saved.".to_string(),
            )
        })?;
        if source_hash(&current) != *expected {
            return Err(HostError::Conflict(format!(
                "Execution manifest changed outside DraftMatter: {}",
                request.cell_id
            )));
        }
    } else if path.exists() {
        return Err(HostError::Conflict(format!(
            "Execution manifest already exists for {}.",
            request.cell_id
        )));
    }
    write_atomic(&path, request.content.as_bytes(), false)?;
    snapshot(&root, &path, request.content)
}

pub fn read_execution_manifests_impl(raw_root: &str) -> Result<Vec<DocumentSnapshot>, HostError> {
    let root = canonical_root(raw_root)?;
    let directory = contained_path(&root, ".draftmatter/outputs")?;
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut snapshots = Vec::new();
    let mut cell_ids = HashSet::new();
    let mut entries = fs::read_dir(&directory)?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if snapshots.len() >= MAX_MANIFESTS {
            return Err(HostError::UnsupportedFile(format!(
                "A project may contain at most {MAX_MANIFESTS} execution manifests."
            )));
        }
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let path = checked_path(
            &directory,
            &Path::new(&entry.file_name()).join("manifest.json"),
            false,
        )?;
        if !path.is_file() {
            continue;
        }
        let metadata = fs::metadata(&path)?;
        if metadata.len() as usize > MAX_MANIFEST_BYTES {
            return Err(HostError::UnsupportedFile(format!(
                "Execution manifest exceeds the 1 MB safety limit: {}",
                path.display()
            )));
        }
        let content = fs::read_to_string(&path).map_err(|error| {
            HostError::InvalidProject(format!(
                "Execution manifest must be UTF-8 text ({}): {error}",
                path.display()
            ))
        })?;
        let cell_id = validate_manifest(&content, None)?;
        if !cell_ids.insert(cell_id.clone()) {
            return Err(HostError::Conflict(format!(
                "More than one execution manifest targets {cell_id}."
            )));
        }
        snapshots.push(snapshot(&root, &path, content)?);
    }
    Ok(snapshots)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn content(cell_id: &str) -> String {
        let hash = format!("sha256:{}", "a".repeat(64));
        format!(
            "{}\n",
            serde_json::json!({
                "schemaVersion": 2,
                "cellId": cell_id,
                "language": "julia",
                "status": "succeeded",
                "codeHash": hash,
                "inputsHash": hash,
                "environmentFingerprint": hash,
                "resultHash": hash,
                "artifacts": [],
                "kernelRunId": "kernel:research:run-1",
                "sessionGeneration": 1,
                "executionSequence": 1,
                "startedAt": "2026-07-15T12:00:00Z",
                "finishedAt": "2026-07-15T12:00:01Z",
                "durationMs": 1000,
                "sequence": 0
            })
        )
    }

    #[test]
    fn saves_and_reopens_portable_execution_manifests_atomically() {
        let project = tempdir().unwrap();
        let first = save_execution_manifest_impl(SaveExecutionManifestRequest {
            root: project.path().to_string_lossy().into_owned(),
            cell_id: "julia:figure".to_string(),
            content: content("julia:figure"),
            expected_hash: None,
        })
        .unwrap();

        assert!(first
            .path
            .starts_with(".draftmatter/outputs/julia_figure--"));
        assert_eq!(
            read_execution_manifests_impl(project.path().to_str().unwrap()).unwrap(),
            vec![first.clone()]
        );

        let updated = save_execution_manifest_impl(SaveExecutionManifestRequest {
            root: project.path().to_string_lossy().into_owned(),
            cell_id: "julia:figure".to_string(),
            content: content("julia:figure").replace("1000", "1200"),
            expected_hash: Some(first.hash),
        })
        .unwrap();
        assert!(updated.content.contains("1200"));
    }

    #[test]
    fn rejects_stale_writes_and_invalid_manifest_identity() {
        let project = tempdir().unwrap();
        let saved = save_execution_manifest_impl(SaveExecutionManifestRequest {
            root: project.path().to_string_lossy().into_owned(),
            cell_id: "cell-safe".to_string(),
            content: content("cell-safe"),
            expected_hash: None,
        })
        .unwrap();
        assert!(matches!(
            save_execution_manifest_impl(SaveExecutionManifestRequest {
                root: project.path().to_string_lossy().into_owned(),
                cell_id: "cell-safe".to_string(),
                content: content("cell-safe"),
                expected_hash: Some("fnv1a:stale".to_string()),
            }),
            Err(HostError::Conflict(_))
        ));
        assert!(matches!(
            save_execution_manifest_impl(SaveExecutionManifestRequest {
                root: project.path().to_string_lossy().into_owned(),
                cell_id: "other-cell".to_string(),
                content: saved.content,
                expected_hash: None,
            }),
            Err(HostError::Conflict(_))
        ));
    }
}

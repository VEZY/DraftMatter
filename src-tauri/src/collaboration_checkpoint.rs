//! Owner-requested persistence of one complete collaborative manuscript revision.
use crate::{
    canonical_root, checked_path, create_recovery, manuscript_extension, project_guard,
    project_transactions, safe_relative, source_hash, HostError,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

const MAX_CHECKPOINT_BYTES: usize = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointAsset {
    pub path: String,
    pub bytes: Vec<u8>,
    pub expected_hash: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointBibliography {
    pub path: String,
    pub content: String,
    pub expected_hash: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveCollaborationCheckpointRequest {
    pub root: String,
    pub document_path: String,
    pub document_content: String,
    pub expected_document_hash: String,
    #[serde(default)]
    pub assets: Vec<CheckpointAsset>,
    #[serde(default)]
    pub bibliography: Option<CheckpointBibliography>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCollaborationCheckpointResult {
    pub document_hash: String,
    pub asset_hashes: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bibliography_hash: Option<String>,
}

fn resource_path(
    root: &Path,
    relative: &str,
    seen: &mut HashSet<String>,
) -> Result<PathBuf, HostError> {
    let safe = safe_relative(relative)?;
    if safe.components().any(|part| {
        let name = part.as_os_str().to_string_lossy();
        name.eq_ignore_ascii_case(".git") || name.eq_ignore_ascii_case(".draftmatter")
    }) || !seen.insert(relative.replace('\\', "/").to_ascii_lowercase())
    {
        return Err(HostError::InvalidPath("Checkpoint paths must be distinct ordinary project files outside Git and private metadata.".into()));
    }
    checked_path(root, &safe, false)
}
fn sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn expected_bytes(
    path: &Path,
    relative: &str,
    expected: Option<&str>,
    binary: bool,
    limit: usize,
) -> Result<Option<Vec<u8>>, HostError> {
    let previous = project_transactions::recovery_bytes(path, limit as u64)?;
    match (&previous, expected) {
        (None, None) => (),
        (Some(bytes), Some(expected)) if (if binary { sha256(bytes) } else { source_hash(bytes) }) == expected => (),
        _ => return Err(HostError::Conflict(format!("{relative} changed or appeared outside DraftMatter after collaboration started. No checkpoint files were overwritten."))),
    }
    Ok(previous)
}

fn save_impl(
    request: SaveCollaborationCheckpointRequest,
    fail_after: Option<usize>,
) -> Result<SaveCollaborationCheckpointResult, HostError> {
    if request.assets.len() > 128 {
        return Err(HostError::UnsupportedFile(
            "A collaboration checkpoint accepts at most 128 figures.".into(),
        ));
    }
    let total = request
        .assets
        .iter()
        .try_fold(request.document_content.len(), |total, asset| {
            total.checked_add(asset.bytes.len())
        })
        .and_then(|total| {
            total.checked_add(
                request
                    .bibliography
                    .as_ref()
                    .map_or(0, |bibliography| bibliography.content.len()),
            )
        })
        .ok_or_else(|| {
            HostError::UnsupportedFile("The collaboration checkpoint is too large.".into())
        })?;
    if total > MAX_CHECKPOINT_BYTES
        || request
            .assets
            .iter()
            .any(|asset| asset.bytes.len() > MAX_IMAGE_BYTES)
    {
        return Err(HostError::UnsupportedFile(
            "Collaboration checkpoints are limited to 20 MiB total and 2 MiB per figure.".into(),
        ));
    }
    let root = canonical_root(&request.root)?;
    let _guard = project_guard(&root)?;
    let mut seen = HashSet::new();
    let document_path = resource_path(&root, &request.document_path, &mut seen)?;
    if !manuscript_extension(&document_path) {
        return Err(HostError::UnsupportedFile(
            "A checkpoint manuscript must use .md or .qmd.".into(),
        ));
    }
    let previous_document = expected_bytes(
        &document_path,
        &request.document_path,
        Some(&request.expected_document_hash),
        false,
        MAX_CHECKPOINT_BYTES,
    )?
    .ok_or_else(|| {
        HostError::Conflict("The local manuscript disappeared before checkpointing.".into())
    })?;
    let mut changes = Vec::new();
    let mut asset_hashes = BTreeMap::new();
    // Every revision and path is checked before any target is modified.
    for asset in &request.assets {
        let path = resource_path(&root, &asset.path, &mut seen)?;
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !matches!(
            extension.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg"
        ) {
            return Err(HostError::UnsupportedFile(
                "Checkpoint figures must use PNG, JPEG, GIF, WebP, or SVG paths.".into(),
            ));
        }
        expected_bytes(
            &path,
            &asset.path,
            asset.expected_hash.as_deref(),
            true,
            MAX_IMAGE_BYTES,
        )?;
        changes.push((asset.path.clone(), Some(asset.bytes.clone())));
        asset_hashes.insert(asset.path.clone(), sha256(&asset.bytes));
    }
    let bibliography_hash = if let Some(bibliography) = &request.bibliography {
        let path = resource_path(&root, &bibliography.path, &mut seen)?;
        if !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
        {
            return Err(HostError::UnsupportedFile(
                "A shared checkpoint bibliography must be a CSL JSON file.".into(),
            ));
        }
        let records: serde_json::Value =
            serde_json::from_str(&bibliography.content).map_err(|_| {
                HostError::InvalidProject("The shared bibliography is not valid CSL JSON.".into())
            })?;
        let mut keys = HashSet::new();
        let valid = records.as_array().is_some_and(|records| {
            records.len() <= 2048
                && records.iter().all(|record| {
                    record.as_object().is_some()
                        && record["id"].as_str().is_some_and(|id| {
                            !id.is_empty()
                                && id.len() <= 256
                                && keys.insert(id.to_ascii_lowercase())
                        })
                })
        });
        if !valid {
            return Err(HostError::InvalidProject("The shared bibliography requires distinct non-empty CSL record IDs (at most 2048 records).".into()));
        }
        expected_bytes(
            &path,
            &bibliography.path,
            bibliography.expected_hash.as_deref(),
            false,
            MAX_CHECKPOINT_BYTES,
        )?;
        changes.push((
            bibliography.path.clone(),
            Some(bibliography.content.as_bytes().to_vec()),
        ));
        Some(source_hash(bibliography.content.as_bytes()))
    } else {
        None
    };
    changes.push((
        request.document_path.clone(),
        Some(request.document_content.as_bytes().to_vec()),
    ));
    if !previous_document.is_empty() {
        create_recovery(&root, &request.document_path, &previous_document)?;
    }
    project_transactions::apply(&root, changes, |count| {
        if fail_after == Some(count) {
            return Err(HostError::Io(
                "Injected collaboration checkpoint interruption.".into(),
            ));
        }
        Ok(())
    })?;
    Ok(SaveCollaborationCheckpointResult {
        document_hash: source_hash(request.document_content.as_bytes()),
        asset_hashes,
        bibliography_hash,
    })
}

#[tauri::command]
pub async fn save_collaboration_checkpoint(
    request: SaveCollaborationCheckpointRequest,
) -> Result<SaveCollaborationCheckpointResult, HostError> {
    tauri::async_runtime::spawn_blocking(move || save_impl(request, None))
        .await
        .map_err(|error| {
            HostError::Io(format!("The checkpoint task stopped unexpectedly: {error}"))
        })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;
    fn request(root: &Path) -> SaveCollaborationCheckpointRequest {
        SaveCollaborationCheckpointRequest {
            root: root.to_string_lossy().into_owned(),
            document_path: "paper.qmd".into(),
            document_content: "new-paper".into(),
            expected_document_hash: source_hash(b"old-paper"),
            assets: vec![CheckpointAsset {
                path: "figures/result.svg".into(),
                bytes: b"<svg/>".to_vec(),
                expected_hash: None,
            }],
            bibliography: Some(CheckpointBibliography {
                path: "references.json".into(),
                content: "[{\"id\":\"citation1\",\"title\":\"Verified work\"}]".into(),
                expected_hash: None,
            }),
        }
    }
    #[test]
    fn complete_checkpoint_persists_source_images_and_references_together() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("paper.qmd"), "old-paper").unwrap();
        let result = save_impl(request(root.path()), None).unwrap();
        assert_eq!(
            fs::read(root.path().join("figures/result.svg")).unwrap(),
            b"<svg/>"
        );
        assert_eq!(result.asset_hashes["figures/result.svg"], sha256(b"<svg/>"));
        assert!(fs::read_to_string(root.path().join("references.json"))
            .unwrap()
            .contains("citation1"));
        assert_eq!(
            fs::read_to_string(root.path().join("paper.qmd")).unwrap(),
            "new-paper"
        );
        assert_eq!(result.document_hash, source_hash(b"new-paper"));
    }
    #[test]
    fn every_interruption_rolls_back_the_entire_checkpoint() {
        for count in 1..=3 {
            let root = tempdir().unwrap();
            fs::write(root.path().join("paper.qmd"), "old-paper").unwrap();
            assert!(save_impl(request(root.path()), Some(count)).is_err());
            assert_eq!(
                fs::read_to_string(root.path().join("paper.qmd")).unwrap(),
                "old-paper"
            );
            assert!(!root.path().join("figures/result.svg").exists());
            assert!(!root.path().join("references.json").exists());
        }
    }
    #[test]
    fn an_external_asset_or_bibliography_edit_blocks_all_checkpoint_targets() {
        for name in ["figures/result.svg", "references.json"] {
            let root = tempdir().unwrap();
            fs::write(root.path().join("paper.qmd"), "old-paper").unwrap();
            fs::create_dir_all(root.path().join("figures")).unwrap();
            fs::write(root.path().join(name), "external-content").unwrap();
            assert!(matches!(
                save_impl(request(root.path()), None),
                Err(HostError::Conflict(_))
            ));
            assert_eq!(
                fs::read_to_string(root.path().join(name)).unwrap(),
                "external-content"
            );
            assert_eq!(
                fs::read_to_string(root.path().join("paper.qmd")).unwrap(),
                "old-paper"
            );
        }
    }
    #[test]
    fn existing_resources_require_their_exact_baseline_hash() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("paper.qmd"), "old-paper").unwrap();
        fs::create_dir_all(root.path().join("figures")).unwrap();
        fs::write(root.path().join("figures/result.svg"), "old-image").unwrap();
        fs::write(root.path().join("references.json"), "[]").unwrap();
        let mut request = request(root.path());
        request.assets[0].expected_hash = Some(sha256(b"old-image"));
        request.bibliography.as_mut().unwrap().expected_hash = Some(source_hash(b"[]"));
        assert!(save_impl(request, None).is_ok());
    }
    #[test]
    fn metadata_collisions_and_nonimage_resources_are_refused_before_writes() {
        for path in [
            ".git/config.png",
            ".draftmatter/payload.svg",
            "../outside.svg",
            "paper.qmd",
            "payload.html",
        ] {
            let root = tempdir().unwrap();
            fs::write(root.path().join("paper.qmd"), "old-paper").unwrap();
            let mut request = request(root.path());
            request.assets[0].path = path.into();
            assert!(save_impl(request, None).is_err());
            assert_eq!(
                fs::read_to_string(root.path().join("paper.qmd")).unwrap(),
                "old-paper"
            );
        }
    }
}

//! Selective file synchronization: durable baselines and no-clobber local writes.
//! File contents are inert bytes; these commands never start a runtime or Git.
use crate::{
    canonical_root, checked_path, is_link, modified_ms, project_guard, project_transactions,
    safe_relative, slash_path, write_atomic, HostError,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const MAX_SYNC_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_STATE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PATHS: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSyncScope {
    pub service_url: String,
    pub workspace_id: String,
    pub project_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSyncBaseline {
    pub local_hash: Option<String>,
    pub remote_version_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSyncState {
    pub schema_version: u8,
    pub scope: ProjectSyncScope,
    pub tracked_paths: Vec<String>,
    #[serde(default)]
    pub excluded_paths: Vec<String>,
    #[serde(default)]
    pub paused: bool,
    pub baselines: BTreeMap<String, ProjectSyncBaseline>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSyncStateSnapshot {
    pub state: ProjectSyncState,
    pub revision: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveProjectSyncStateRequest {
    root: String,
    scope: ProjectSyncScope,
    state: ProjectSyncState,
    expected_revision: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSyncFileSnapshot {
    pub path: String,
    pub exists: bool,
    pub bytes: u64,
    pub hash: Option<String>,
    pub modified_ms: Option<u64>,
    pub too_large: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSyncFileBytes {
    pub path: String,
    pub bytes: Vec<u8>,
    pub hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyProjectSyncFileRequest {
    root: String,
    path: String,
    bytes: Vec<u8>,
    expected_hash: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProjectSyncFileResult {
    pub path: String,
    pub bytes: u64,
    pub hash: String,
    pub recovery_path: Option<String>,
}

fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn valid_hash(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn validate_hash(value: Option<&str>) -> Result<(), HostError> {
    if value.is_some_and(|value| !valid_hash(value)) {
        return Err(HostError::InvalidProject(
            "Synchronization requires a valid SHA-256 fingerprint.".into(),
        ));
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphabetic()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
}

fn validate_scope(scope: &ProjectSyncScope) -> Result<(), HostError> {
    let url = &scope.service_url;
    if !(url.starts_with("https://") || url.starts_with("http://"))
        || url.len() > 2048
        || url.ends_with('/')
        || url
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || url.contains(['?', '#', '@', '\\'])
        || url
            .split("://")
            .nth(1)
            .is_none_or(|host| host.is_empty() || host.starts_with('/'))
        || !valid_id(&scope.workspace_id)
        || !valid_id(&scope.project_id)
    {
        return Err(HostError::InvalidProject(
            "Synchronization requires a normalized service URL, workspace, and project identity."
                .into(),
        ));
    }
    Ok(())
}

fn reserved_windows_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0'
}

fn sync_relative(relative: &str) -> Result<PathBuf, HostError> {
    if relative.len() > 1024
        || relative.contains('\\')
        || relative.chars().any(|character| {
            character.is_control() || matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*')
        })
    {
        return Err(HostError::InvalidPath(
            "Choose an ordinary project-relative file path for synchronization.".into(),
        ));
    }
    let parts = relative.split('/').collect::<Vec<_>>();
    let lower = parts
        .iter()
        .map(|part| part.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let blocked = [
        ".git",
        ".draftmatter",
        ".ssh",
        ".aws",
        ".gnupg",
        ".codex",
        ".agents",
        ".venv",
        "venv",
        "node_modules",
        "target",
        "__pycache__",
        ".rproj.user",
    ];
    if parts.iter().any(|part| {
        part.is_empty()
            || *part == "."
            || *part == ".."
            || part.ends_with(['.', ' '])
            || reserved_windows_name(part)
    }) || lower
        .iter()
        .any(|part| blocked.contains(&part.as_str()) || part == ".env" || part.starts_with(".env."))
        || lower.windows(2).any(|pair| {
            pair[0] == "renv" && matches!(pair[1].as_str(), "library" | "cache" | "staging")
        })
    {
        return Err(HostError::InvalidPath("Private metadata, credentials, dependency folders, and path escapes cannot be synchronized.".into()));
    }
    let safe = safe_relative(relative)?;
    if slash_path(&safe) != relative {
        return Err(HostError::InvalidPath(
            "Synchronization paths must use normalized forward slashes.".into(),
        ));
    }
    Ok(safe)
}

fn validate_state(state: &ProjectSyncState, scope: &ProjectSyncScope) -> Result<(), HostError> {
    validate_scope(scope)?;
    if state.schema_version != 1
        || &state.scope != scope
        || state.tracked_paths.len() > MAX_PATHS
        || state.excluded_paths.len() > MAX_PATHS
        || state.baselines.len() > MAX_PATHS
    {
        return Err(HostError::InvalidProject(
            "Invalid or mismatched selective synchronization state; it was preserved.".into(),
        ));
    }
    let mut seen = HashSet::new();
    for path in state.tracked_paths.iter().chain(&state.excluded_paths) {
        sync_relative(path)?;
        if !seen.insert(path.to_ascii_lowercase()) {
            return Err(HostError::InvalidProject(
                "Tracked and excluded paths must be distinct.".into(),
            ));
        }
    }
    let mut baselines = HashSet::new();
    for (path, baseline) in &state.baselines {
        sync_relative(path)?;
        validate_hash(baseline.local_hash.as_deref())?;
        if !baselines.insert(path.to_ascii_lowercase())
            || baseline.remote_version_id.as_ref().is_some_and(|id| {
                id.is_empty() || id.len() > 256 || id.chars().any(char::is_control)
            })
        {
            return Err(HostError::InvalidProject(
                "Invalid synchronization baseline; it was preserved.".into(),
            ));
        }
    }
    Ok(())
}

fn state_relative(scope: &ProjectSyncScope) -> Result<String, HostError> {
    validate_scope(scope)?;
    let encoded =
        serde_json::to_vec(scope).map_err(|error| HostError::InvalidProject(error.to_string()))?;
    Ok(format!(
        ".draftmatter/sync/{}.json",
        hash(&encoded).trim_start_matches("sha256:")
    ))
}

fn read_bounded(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, HostError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(metadata) if is_link(&metadata) || !metadata.is_file() => {
            return Err(HostError::InvalidPath(
                "Synchronization only reads ordinary files, never links or directories.".into(),
            ))
        }
        Ok(_) => (),
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    if file.metadata()?.len() > limit {
        return Err(HostError::UnsupportedFile(
            "This file exceeds the 32 MiB selective synchronization transfer limit.".into(),
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(HostError::UnsupportedFile(
            "This file grew beyond the synchronization size limit; no data was replaced.".into(),
        ));
    }
    Ok(Some(bytes))
}

fn read_state_locked(
    root: &Path,
    scope: &ProjectSyncScope,
) -> Result<ProjectSyncStateSnapshot, HostError> {
    let path = checked_path(root, &safe_relative(&state_relative(scope)?)?, false)?;
    let bytes = read_bounded(&path, MAX_STATE_BYTES)?;
    let state = if let Some(bytes) = &bytes {
        let state: ProjectSyncState = serde_json::from_slice(bytes).map_err(|_| HostError::InvalidProject("Saved synchronization state is invalid. It was preserved; restore its state before synchronizing.".into()))?;
        validate_state(&state, scope)?;
        state
    } else {
        ProjectSyncState {
            schema_version: 1,
            scope: scope.clone(),
            tracked_paths: vec![],
            excluded_paths: vec![],
            paused: false,
            baselines: BTreeMap::new(),
        }
    };
    Ok(ProjectSyncStateSnapshot {
        state,
        revision: bytes.as_ref().map(|bytes| hash(bytes)),
    })
}

fn read_state_impl(
    raw_root: &str,
    scope: &ProjectSyncScope,
) -> Result<ProjectSyncStateSnapshot, HostError> {
    let root = canonical_root(raw_root)?;
    let _guard = project_guard(&root)?;
    read_state_locked(&root, scope)
}

fn save_state_impl(
    request: SaveProjectSyncStateRequest,
) -> Result<ProjectSyncStateSnapshot, HostError> {
    validate_state(&request.state, &request.scope)?;
    validate_hash(request.expected_revision.as_deref())?;
    let root = canonical_root(&request.root)?;
    let _guard = project_guard(&root)?;
    if read_state_locked(&root, &request.scope)?.revision != request.expected_revision {
        return Err(HostError::Conflict("The synchronization selection or baseline changed in another DraftMatter window. Refresh before continuing; no state was overwritten.".into()));
    }
    let path = checked_path(
        &root,
        &safe_relative(&state_relative(&request.scope)?)?,
        false,
    )?;
    let mut bytes = serde_json::to_vec_pretty(&request.state)
        .map_err(|error| HostError::InvalidProject(error.to_string()))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(HostError::UnsupportedFile(
            "Selective synchronization state exceeds the 2 MiB limit.".into(),
        ));
    }
    write_atomic(&path, &bytes, false)?;
    Ok(ProjectSyncStateSnapshot {
        state: request.state,
        revision: Some(hash(&bytes)),
    })
}

fn inspect_files_impl(
    raw_root: &str,
    paths: &[String],
) -> Result<Vec<ProjectSyncFileSnapshot>, HostError> {
    if paths.len() > MAX_PATHS {
        return Err(HostError::UnsupportedFile(
            "Inspect at most 1,000 selected files at a time.".into(),
        ));
    }
    let root = canonical_root(raw_root)?;
    let _guard = project_guard(&root)?;
    let mut result = Vec::with_capacity(paths.len());
    for relative in paths {
        let path = checked_path(&root, &sync_relative(relative)?, false)?;
        let metadata = match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                result.push(ProjectSyncFileSnapshot {
                    path: relative.clone(),
                    exists: false,
                    bytes: 0,
                    hash: None,
                    modified_ms: None,
                    too_large: false,
                });
                continue;
            }
            Err(error) => return Err(error.into()),
            Ok(metadata) => metadata,
        };
        if !metadata.is_file() || is_link(&metadata) {
            return Err(HostError::InvalidPath(format!(
                "{relative} is not an ordinary project file."
            )));
        }
        let too_large = metadata.len() > MAX_SYNC_FILE_BYTES;
        let bytes = if too_large {
            None
        } else {
            read_bounded(&path, MAX_SYNC_FILE_BYTES)?
        };
        if !too_large && bytes.is_none() {
            result.push(ProjectSyncFileSnapshot {
                path: relative.clone(),
                exists: false,
                bytes: 0,
                hash: None,
                modified_ms: None,
                too_large: false,
            });
            continue;
        }
        result.push(ProjectSyncFileSnapshot {
            path: relative.clone(),
            exists: true,
            bytes: bytes
                .as_ref()
                .map_or(metadata.len(), |bytes| bytes.len() as u64),
            hash: bytes.as_ref().map(|bytes| hash(bytes)),
            modified_ms: Some(modified_ms(&metadata)),
            too_large,
        });
    }
    Ok(result)
}

fn read_file_impl(
    raw_root: &str,
    relative: &str,
    expected_hash: &str,
) -> Result<ProjectSyncFileBytes, HostError> {
    validate_hash(Some(expected_hash))?;
    let root = canonical_root(raw_root)?;
    let _guard = project_guard(&root)?;
    let path = checked_path(&root, &sync_relative(relative)?, false)?;
    let bytes = read_bounded(&path, MAX_SYNC_FILE_BYTES)?.ok_or_else(|| {
        HostError::Conflict(format!(
            "{relative} disappeared before upload. Refresh before synchronizing."
        ))
    })?;
    let actual = hash(&bytes);
    if actual != expected_hash {
        return Err(HostError::Conflict(format!("{relative} changed before upload. Refresh before synchronizing; no server version was replaced.")));
    }
    Ok(ProjectSyncFileBytes {
        path: relative.to_string(),
        bytes,
        hash: actual,
    })
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyJournal {
    schema_version: u8,
    target: String,
    expected_hash: Option<String>,
    incoming_hash: String,
    original: Option<String>,
    staged: String,
}

fn write_journal(path: &Path, journal: &ApplyJournal) -> Result<(), HostError> {
    write_atomic(
        path,
        &serde_json::to_vec(journal)
            .map_err(|error| HostError::InvalidProject(error.to_string()))?,
        false,
    )
}

fn conflict_message(relative: &str, recovery: Option<&str>) -> HostError {
    HostError::Conflict(format!("{relative} changed while synchronization was applying. No concurrent file was overwritten.{}", recovery.map(|path| format!(" The previous local version is retained at {path}. ")).unwrap_or_default()))
}

fn restore_absent(original: &Path, target: &Path) -> Result<(), HostError> {
    let bytes = read_bounded(original, MAX_SYNC_FILE_BYTES)?.ok_or_else(|| {
        HostError::InvalidProject("The preserved synchronization original is missing.".into())
    })?;
    // A restored working file must have its own inode: an IDE's later in-place
    // save must not mutate the retained recovery version through a hard link.
    let staged = original
        .parent()
        .unwrap()
        .join(format!("restore-{}.bin", Uuid::new_v4()));
    write_atomic(&staged, &bytes, false)?;
    let result = match fs::hard_link(&staged, target) {
        Ok(()) => project_transactions::sync_directory(target.parent().unwrap()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.into()),
    };
    fs::remove_file(&staged)?;
    result
}

/// Called while the ordinary project lock is held, before any new project mutation.
/// Recovery only fills a missing path. It never replaces a concurrent writer's file.
pub(crate) fn recover(root: &Path) -> Result<(), HostError> {
    let directory = checked_path(root, Path::new(".draftmatter/sync-journal"), false)?;
    if !directory.exists() {
        return Ok(());
    }
    for (count, entry) in fs::read_dir(&directory)?.enumerate() {
        if count >= 1000 {
            return Err(HostError::UnsupportedFile(
                "Too many synchronization recovery journals; they were preserved.".into(),
            ));
        }
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name
            .strip_suffix(".json")
            .is_some_and(|name| Uuid::parse_str(name).is_ok())
        {
            continue;
        }
        let journal_path = checked_path(&directory, Path::new(&name), false)?;
        let bytes = read_bounded(&journal_path, MAX_STATE_BYTES)?.ok_or_else(|| {
            HostError::InvalidProject("A synchronization journal disappeared.".into())
        })?;
        let journal: ApplyJournal = serde_json::from_slice(&bytes).map_err(|_| {
            HostError::InvalidProject(
                "Invalid synchronization recovery journal was preserved.".into(),
            )
        })?;
        validate_hash(journal.expected_hash.as_deref())?;
        if journal.schema_version != 1
            || !valid_hash(&journal.incoming_hash)
            || journal.staged
                != format!(
                    ".draftmatter/sync-staging/{}.bin",
                    name.trim_end_matches(".json")
                )
            || journal.original.as_ref().is_some_and(|path| {
                path != &format!(
                    ".draftmatter/sync-recovery/{}.original",
                    name.trim_end_matches(".json")
                )
            })
        {
            return Err(HostError::InvalidProject(
                "Unsupported synchronization recovery journal was preserved.".into(),
            ));
        }
        let target = checked_path(root, &sync_relative(&journal.target)?, false)?;
        if let Some(relative) = &journal.original {
            let original = checked_path(root, &safe_relative(relative)?, false)?;
            if original.exists() && !target.exists() {
                restore_absent(&original, &target)?;
            }
        }
        let staged = checked_path(root, &safe_relative(&journal.staged)?, false)?;
        if staged.exists() {
            fs::remove_file(staged)?;
        }
        fs::remove_file(journal_path)?;
    }
    project_transactions::sync_directory(&directory)
}

fn apply_file_impl(
    request: ApplyProjectSyncFileRequest,
    fail_after_move: bool,
    before_install: impl FnOnce(&Path),
) -> Result<ApplyProjectSyncFileResult, HostError> {
    apply_file_with_hooks(request, fail_after_move, |_| {}, before_install)
}

fn apply_file_with_hooks(
    request: ApplyProjectSyncFileRequest,
    fail_after_move: bool,
    before_move: impl FnOnce(&Path),
    before_install: impl FnOnce(&Path),
) -> Result<ApplyProjectSyncFileResult, HostError> {
    if request.bytes.len() as u64 > MAX_SYNC_FILE_BYTES {
        return Err(HostError::UnsupportedFile("Selective synchronization currently transfers files up to 32 MiB. Use a separate download for larger files.".into()));
    }
    validate_hash(request.expected_hash.as_deref())?;
    let root = canonical_root(&request.root)?;
    let _guard = project_guard(&root)?;
    let relative = slash_path(&sync_relative(&request.path)?);
    let target = checked_path(&root, &sync_relative(&relative)?, false)?;
    let previous = read_bounded(&target, MAX_SYNC_FILE_BYTES)?;
    if previous.as_ref().map(|bytes| hash(bytes)) != request.expected_hash {
        return Err(conflict_message(&relative, None));
    }
    let incoming_hash = hash(&request.bytes);
    if request.expected_hash.as_ref() == Some(&incoming_hash) {
        return Ok(ApplyProjectSyncFileResult {
            path: relative,
            bytes: request.bytes.len() as u64,
            hash: incoming_hash,
            recovery_path: None,
        });
    }
    let id = Uuid::new_v4().to_string();
    let staged_relative = format!(".draftmatter/sync-staging/{id}.bin");
    let recovery_relative = previous
        .as_ref()
        .map(|_| format!(".draftmatter/sync-recovery/{id}.original"));
    let journal_relative = format!(".draftmatter/sync-journal/{id}.json");
    let staged = checked_path(&root, &safe_relative(&staged_relative)?, false)?;
    let journal_path = checked_path(&root, &safe_relative(&journal_relative)?, false)?;
    write_atomic(&staged, &request.bytes, false)?;
    let journal = ApplyJournal {
        schema_version: 1,
        target: relative.clone(),
        expected_hash: request.expected_hash.clone(),
        incoming_hash: incoming_hash.clone(),
        original: recovery_relative.clone(),
        staged: staged_relative,
    };
    write_journal(&journal_path, &journal)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    // Recheck ancestors after creating the target folder. Never follow project links.
    checked_path(&root, &sync_relative(&relative)?, false)?;
    before_move(&target);
    if let Some(recovery_relative) = &recovery_relative {
        let original = checked_path(&root, &safe_relative(recovery_relative)?, false)?;
        fs::create_dir_all(original.parent().unwrap())?;
        fs::rename(&target, &original)?;
        project_transactions::sync_directory(target.parent().unwrap())?;
        project_transactions::sync_directory(original.parent().unwrap())?;
        let moved = read_bounded(&original, MAX_SYNC_FILE_BYTES)?;
        if let Some(bytes) = &moved {
            let receipt = serde_json::json!({
                "schemaVersion": 1,
                "path": relative,
                "originalPath": recovery_relative,
                "originalHash": hash(bytes),
                "incomingHash": incoming_hash,
                "bytes": bytes.len(),
                "createdAtMs": crate::now_millis(),
            });
            write_atomic(
                &original.with_extension("json"),
                &serde_json::to_vec_pretty(&receipt)
                    .map_err(|error| HostError::InvalidProject(error.to_string()))?,
                false,
            )?;
        }
        if moved.as_ref().map(|bytes| hash(bytes)) != request.expected_hash {
            restore_absent(&original, &target)?;
            return Err(conflict_message(&relative, Some(recovery_relative)));
        }
        if fail_after_move {
            return Err(HostError::Io(
                "Injected synchronization interruption after preserving the original.".into(),
            ));
        }
    }
    before_install(&target);
    // Hard-link publication is atomic and refuses an existing destination. This
    // closes the ordinary precheck/replace race with an external editor.
    if let Err(error) = fs::hard_link(&staged, &target) {
        if let Some(recovery_relative) = &recovery_relative {
            let original = checked_path(&root, &safe_relative(recovery_relative)?, false)?;
            restore_absent(&original, &target)?;
        }
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            return Err(conflict_message(&relative, recovery_relative.as_deref()));
        }
        return Err(HostError::Io(format!("The synchronized file could not be installed without overwriting another file: {error}. Its recovery journal was preserved.")));
    }
    project_transactions::sync_directory(target.parent().unwrap())?;
    fs::remove_file(&staged)?;
    fs::remove_file(&journal_path)?;
    project_transactions::sync_directory(journal_path.parent().unwrap())?;
    Ok(ApplyProjectSyncFileResult {
        path: relative,
        bytes: request.bytes.len() as u64,
        hash: incoming_hash,
        recovery_path: recovery_relative,
    })
}

#[tauri::command]
pub async fn read_project_sync_state(
    root: String,
    scope: ProjectSyncScope,
) -> Result<ProjectSyncStateSnapshot, HostError> {
    tauri::async_runtime::spawn_blocking(move || read_state_impl(&root, &scope))
        .await
        .map_err(|error| HostError::Io(error.to_string()))?
}
#[tauri::command]
pub async fn save_project_sync_state(
    request: SaveProjectSyncStateRequest,
) -> Result<ProjectSyncStateSnapshot, HostError> {
    tauri::async_runtime::spawn_blocking(move || save_state_impl(request))
        .await
        .map_err(|error| HostError::Io(error.to_string()))?
}
#[tauri::command]
pub async fn inspect_project_sync_files(
    root: String,
    paths: Vec<String>,
) -> Result<Vec<ProjectSyncFileSnapshot>, HostError> {
    tauri::async_runtime::spawn_blocking(move || inspect_files_impl(&root, &paths))
        .await
        .map_err(|error| HostError::Io(error.to_string()))?
}
#[tauri::command]
pub async fn read_project_sync_file(
    root: String,
    path: String,
    expected_hash: String,
) -> Result<ProjectSyncFileBytes, HostError> {
    tauri::async_runtime::spawn_blocking(move || read_file_impl(&root, &path, &expected_hash))
        .await
        .map_err(|error| HostError::Io(error.to_string()))?
}
#[tauri::command]
pub async fn apply_project_sync_file(
    request: ApplyProjectSyncFileRequest,
) -> Result<ApplyProjectSyncFileResult, HostError> {
    tauri::async_runtime::spawn_blocking(move || apply_file_impl(request, false, |_| {}))
        .await
        .map_err(|error| HostError::Io(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    fn scope() -> ProjectSyncScope {
        ProjectSyncScope {
            service_url: "https://collab.example.org".into(),
            workspace_id: "lab".into(),
            project_id: "paper".into(),
        }
    }
    fn request(
        root: &Path,
        expected: Option<&[u8]>,
        incoming: &[u8],
    ) -> ApplyProjectSyncFileRequest {
        ApplyProjectSyncFileRequest {
            root: root.to_string_lossy().into(),
            path: "data/observations.csv".into(),
            bytes: incoming.to_vec(),
            expected_hash: expected.map(hash),
        }
    }

    #[test]
    fn persists_scoped_selection_and_baselines_with_compare_and_swap() {
        let root = tempdir().unwrap();
        let initial = read_state_impl(root.path().to_str().unwrap(), &scope()).unwrap();
        assert!(initial.revision.is_none());
        let mut state = initial.state;
        assert!(!state.paused);
        state.paused = true;
        state.tracked_paths = vec!["paper.qmd".into(), "figures/result.svg".into()];
        state.excluded_paths = vec!["figures/private.svg".into()];
        state.baselines.insert(
            "paper.qmd".into(),
            ProjectSyncBaseline {
                local_hash: Some(hash(b"paper")),
                remote_version_id: Some("file-version-1".into()),
            },
        );
        let saved = save_state_impl(SaveProjectSyncStateRequest {
            root: root.path().to_string_lossy().into(),
            scope: scope(),
            state: state.clone(),
            expected_revision: None,
        })
        .unwrap();
        assert!(saved.revision.is_some());
        assert!(matches!(
            save_state_impl(SaveProjectSyncStateRequest {
                root: root.path().to_string_lossy().into(),
                scope: scope(),
                state,
                expected_revision: None
            }),
            Err(HostError::Conflict(_))
        ));
        let read = read_state_impl(root.path().to_str().unwrap(), &scope()).unwrap();
        assert_eq!(read.revision, saved.revision);
        assert!(read.state.paused);
        assert_eq!(read.state.excluded_paths, ["figures/private.svg"]);
        let mut other = scope();
        other.project_id = "other".into();
        assert!(read_state_impl(root.path().to_str().unwrap(), &other)
            .unwrap()
            .revision
            .is_none());
    }

    #[test]
    fn hashes_files_and_refuses_upload_after_an_external_edit() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("data")).unwrap();
        fs::write(root.path().join("data/observations.csv"), b"old").unwrap();
        let files = inspect_files_impl(
            root.path().to_str().unwrap(),
            &["data/observations.csv".into(), "data/missing.csv".into()],
        )
        .unwrap();
        assert_eq!(files[0].hash, Some(hash(b"old")));
        assert!(!files[1].exists);
        fs::write(root.path().join("data/observations.csv"), b"external").unwrap();
        assert!(matches!(
            read_file_impl(
                root.path().to_str().unwrap(),
                "data/observations.csv",
                &hash(b"old")
            ),
            Err(HostError::Conflict(_))
        ));
    }

    #[test]
    fn concurrent_selection_updates_accept_only_one_shared_baseline() {
        let root = tempdir().unwrap();
        let root_path = root.path().to_string_lossy().into_owned();
        let state = read_state_impl(&root_path, &scope()).unwrap().state;
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles = (0..2)
            .map(|index| {
                let root = root_path.clone();
                let mut state = state.clone();
                state
                    .tracked_paths
                    .push(format!("data/selection-{index}.csv"));
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    save_state_impl(SaveProjectSyncStateRequest {
                        root,
                        scope: scope(),
                        state,
                        expected_revision: None,
                    })
                    .is_ok()
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .filter(|saved| *saved)
                .count(),
            1
        );
    }

    #[test]
    fn changed_moved_original_is_restored_without_overwriting_a_concurrent_file() {
        let root = tempdir().unwrap();
        apply_file_impl(request(root.path(), None, b"old"), false, |_| {}).unwrap();
        let result = apply_file_with_hooks(
            request(root.path(), Some(b"old"), b"remote"),
            false,
            |target| {
                fs::write(target, b"newer local edit").unwrap();
            },
            |_| {},
        );
        assert!(matches!(result, Err(HostError::Conflict(_))));
        assert_eq!(
            fs::read(root.path().join("data/observations.csv")).unwrap(),
            b"newer local edit"
        );
        let original = fs::read_dir(root.path().join(".draftmatter/sync-recovery"))
            .unwrap()
            .map(Result::unwrap)
            .map(|entry| entry.path())
            .find(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "original")
            })
            .unwrap();
        fs::write(
            root.path().join("data/observations.csv"),
            b"yet another edit",
        )
        .unwrap();
        assert_eq!(fs::read(original).unwrap(), b"newer local edit");
    }

    #[test]
    fn updates_only_the_expected_version_and_keeps_the_original() {
        let root = tempdir().unwrap();
        let created = apply_file_impl(request(root.path(), None, b"old"), false, |_| {}).unwrap();
        assert_eq!(created.hash, hash(b"old"));
        let updated =
            apply_file_impl(request(root.path(), Some(b"old"), b"new"), false, |_| {}).unwrap();
        assert_eq!(
            fs::read(root.path().join("data/observations.csv")).unwrap(),
            b"new"
        );
        let original = root.path().join(updated.recovery_path.unwrap());
        assert_eq!(fs::read(&original).unwrap(), b"old");
        let receipt: serde_json::Value =
            serde_json::from_slice(&fs::read(original.with_extension("json")).unwrap()).unwrap();
        assert_eq!(receipt["path"], "data/observations.csv");
        assert_eq!(receipt["originalHash"], hash(b"old"));
        assert!(matches!(
            apply_file_impl(request(root.path(), Some(b"old"), b"stale"), false, |_| {}),
            Err(HostError::Conflict(_))
        ));
        assert_eq!(
            fs::read(root.path().join("data/observations.csv")).unwrap(),
            b"new"
        );
    }

    #[test]
    fn never_clobbers_a_file_recreated_by_an_ide_during_install() {
        let root = tempdir().unwrap();
        apply_file_impl(request(root.path(), None, b"old"), false, |_| {}).unwrap();
        let result = apply_file_impl(
            request(root.path(), Some(b"old"), b"remote"),
            false,
            |target| {
                fs::write(target, b"external IDE save").unwrap();
            },
        );
        assert!(matches!(result, Err(HostError::Conflict(_))));
        assert_eq!(
            fs::read(root.path().join("data/observations.csv")).unwrap(),
            b"external IDE save"
        );
        let recovery = fs::read_dir(root.path().join(".draftmatter/sync-recovery"))
            .unwrap()
            .map(Result::unwrap)
            .map(|entry| entry.path())
            .find(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "original")
            })
            .unwrap();
        assert_eq!(fs::read(recovery).unwrap(), b"old");
        // Next open recovers only missing paths, so it also preserves the IDE edit.
        read_state_impl(root.path().to_str().unwrap(), &scope()).unwrap();
        assert_eq!(
            fs::read(root.path().join("data/observations.csv")).unwrap(),
            b"external IDE save"
        );
    }

    #[test]
    fn restores_a_moved_original_after_interruption_without_losing_newer_edits() {
        let root = tempdir().unwrap();
        apply_file_impl(request(root.path(), None, b"old"), false, |_| {}).unwrap();
        assert!(
            apply_file_impl(request(root.path(), Some(b"old"), b"remote"), true, |_| {}).is_err()
        );
        assert!(!root.path().join("data/observations.csv").exists());
        read_state_impl(root.path().to_str().unwrap(), &scope()).unwrap();
        assert_eq!(
            fs::read(root.path().join("data/observations.csv")).unwrap(),
            b"old"
        );
        let original = fs::read_dir(root.path().join(".draftmatter/sync-recovery"))
            .unwrap()
            .map(Result::unwrap)
            .map(|entry| entry.path())
            .find(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "original")
            })
            .unwrap();
        fs::write(root.path().join("data/observations.csv"), b"after recovery").unwrap();
        assert_eq!(fs::read(original).unwrap(), b"old");
    }

    #[test]
    fn handles_empty_files_and_refuses_an_appearing_keep_both_destination() {
        let root = tempdir().unwrap();
        apply_file_impl(request(root.path(), None, b""), false, |_| {}).unwrap();
        let files = inspect_files_impl(
            root.path().to_str().unwrap(),
            &["data/observations.csv".into()],
        )
        .unwrap();
        assert_eq!(files[0].hash, Some(hash(b"")));
        assert!(apply_file_impl(request(root.path(), None, b"other"), false, |_| {}).is_err());
        assert_eq!(
            fs::read(root.path().join("data/observations.csv")).unwrap(),
            b""
        );
    }

    #[test]
    fn reports_large_files_without_transferring_or_hashing_them() {
        let root = tempdir().unwrap();
        let file = fs::File::create(root.path().join("large.bin")).unwrap();
        file.set_len(MAX_SYNC_FILE_BYTES + 1).unwrap();
        let files =
            inspect_files_impl(root.path().to_str().unwrap(), &["large.bin".into()]).unwrap();
        assert!(files[0].too_large);
        assert_eq!(files[0].hash, None);
        assert_eq!(files[0].bytes, MAX_SYNC_FILE_BYTES + 1);
    }

    #[test]
    fn rejects_private_paths_and_preserves_corrupt_state() {
        for path in [
            "../paper.qmd",
            "/paper.qmd",
            "data\\paper.csv",
            ".git/config",
            ".draftmatter/project.json",
            ".env",
            "data/.env.production",
            "node_modules/pkg/index.js",
            "renv/library/pkg.r",
            "folder/CON.txt",
            "data/file.",
        ] {
            assert!(sync_relative(path).is_err(), "{path}");
        }
        for path in [
            "paper.qmd",
            "figures/result.svg",
            "references.bib",
            "analysis.py",
            "scripts/process.R",
            "uv.lock",
        ] {
            assert!(sync_relative(path).is_ok(), "{path}");
        }
        let root = tempdir().unwrap();
        let path = root.path().join(state_relative(&scope()).unwrap());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{corrupt").unwrap();
        assert!(read_state_impl(root.path().to_str().unwrap(), &scope()).is_err());
        assert_eq!(fs::read(path).unwrap(), b"{corrupt");
    }

    #[cfg(unix)]
    #[test]
    fn never_reads_or_writes_through_a_project_symlink() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("private.csv"), b"secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("data")).unwrap();
        assert!(
            inspect_files_impl(root.path().to_str().unwrap(), &["data/private.csv".into()])
                .is_err()
        );
        assert!(apply_file_impl(request(root.path(), None, b"remote"), false, |_| {}).is_err());
        assert_eq!(
            fs::read(outside.path().join("private.csv")).unwrap(),
            b"secret"
        );
    }
}

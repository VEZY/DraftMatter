//! Resumable binary downloads. IPC carries one bounded part; cache and final
//! assembly are disk-backed and isolated by a hashed service/account/file scope.
use crate::{checked_path, project_transactions::ProjectLock, write_atomic, HostError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const MAX_FILE_BYTES: u64 = 1_000_000_000;
const CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const BUFFER_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadPart {
    pub part_number: u32,
    pub size: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadSpec {
    pub cache_key: String,
    pub filename: String,
    pub size: u64,
    pub chunk_size: u64,
    pub parts: Vec<DownloadPart>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadWrite {
    pub cache_key: String,
    pub operation_id: String,
    pub part_number: u32,
    pub bytes: Vec<u8>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadOperation {
    pub cache_key: String,
    pub operation_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub completed_parts: Vec<u32>,
    pub completed_bytes: u64,
    pub total_bytes: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStarted {
    pub operation_id: String,
    #[serde(flatten)]
    pub progress: DownloadProgress,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSaved {
    pub path: String,
    pub bytes: u64,
}

#[derive(Clone, Default)]
pub struct DownloadRegistry {
    operations: Arc<Mutex<HashMap<String, (String, Arc<AtomicBool>)>>>,
}
impl DownloadRegistry {
    fn register(&self, key: &str) -> Result<String, HostError> {
        let id = Uuid::new_v4().to_string();
        let mut operations = self.operations.lock().map_err(|_| {
            HostError::Integration("The download operation registry is unavailable.".into())
        })?;
        if operations.len() >= 256 {
            return Err(HostError::Integration(
                "Too many active downloads. Cancel an earlier download and retry.".into(),
            ));
        }
        operations.insert(id.clone(), (key.into(), Arc::new(AtomicBool::new(false))));
        Ok(id)
    }
    fn active(&self, operation: &DownloadOperation) -> Result<Arc<AtomicBool>, HostError> {
        let operations = self.operations.lock().map_err(|_| {
            HostError::Integration("The download operation registry is unavailable.".into())
        })?;
        let (key, cancelled) = operations
            .get(&operation.operation_id)
            .filter(|(key, _)| key == &operation.cache_key)
            .ok_or_else(|| {
                HostError::Integration(
                    "This download operation ended; start it again to resume its cached parts."
                        .into(),
                )
            })?;
        let _ = key;
        check_cancelled(cancelled)?;
        Ok(cancelled.clone())
    }
    fn finish(&self, id: &str, cancel: bool) {
        if let Ok(mut operations) = self.operations.lock() {
            if let Some((_, flag)) = operations.remove(id) {
                if cancel {
                    flag.store(true, Ordering::SeqCst);
                }
            }
        }
    }
}
fn check_cancelled(flag: &AtomicBool) -> Result<(), HostError> {
    if flag.load(Ordering::SeqCst) {
        Err(HostError::Integration(
            "The file download was cancelled; its cached parts remain available for resume.".into(),
        ))
    } else {
        Ok(())
    }
}
fn valid_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn valid_filename(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 240
        && !matches!(name, "." | "..")
        && !name.chars().any(|ch| {
            ch.is_control() || matches!(ch, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
        })
}
fn validate_spec(spec: &DownloadSpec) -> Result<(), HostError> {
    let expected = spec.size.div_ceil(CHUNK_BYTES) as usize;
    if !valid_key(&spec.cache_key)
        || !valid_filename(&spec.filename)
        || spec.size > MAX_FILE_BYTES
        || spec.chunk_size != CHUNK_BYTES
        || spec.parts.len() != expected
    {
        return Err(HostError::InvalidProject(
            "The download specification is invalid or exceeds the 1 GB file limit.".into(),
        ));
    }
    for (index, part) in spec.parts.iter().enumerate() {
        let remaining = spec.size - index as u64 * CHUNK_BYTES;
        if part.part_number != index as u32 + 1
            || part.size != remaining.min(CHUNK_BYTES)
            || !valid_key(&part.sha256)
        {
            return Err(HostError::InvalidProject(
                "The download part manifest is invalid.".into(),
            ));
        }
    }
    Ok(())
}
fn private_directory(path: &Path) -> Result<(), HostError> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if crate::is_link(&metadata) || !metadata.is_dir() {
            return Err(HostError::InvalidPath(
                "Download cache directories cannot be links or files.".into(),
            ));
        }
    }
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn cache_root(app_cache: &Path) -> Result<PathBuf, HostError> {
    private_directory(app_cache)?;
    let root = checked_path(app_cache, Path::new("project-downloads"), false)?;
    private_directory(&root)?;
    Ok(root)
}
fn session(root: &Path, key: &str, create: bool) -> Result<PathBuf, HostError> {
    if !valid_key(key) {
        return Err(HostError::InvalidPath(
            "A download cache key must be an opaque SHA-256 identifier.".into(),
        ));
    }
    let path = checked_path(root, Path::new(key), false)?;
    if create {
        private_directory(&path)?;
    }
    if !path.is_dir() {
        return Err(HostError::NotFound(
            "The cached download was not found. Start it again to resume.".into(),
        ));
    }
    Ok(path)
}
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), HostError> {
    write_atomic(path, bytes, false)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
fn manifest_path(session: &Path) -> Result<PathBuf, HostError> {
    checked_path(session, Path::new("manifest.json"), false)
}
fn read_spec(session: &Path) -> Result<DownloadSpec, HostError> {
    let bytes = crate::project_transactions::recovery_bytes(&manifest_path(session)?, 64 * 1024)?
        .ok_or_else(|| {
        HostError::NotFound("The cached download manifest is missing.".into())
    })?;
    let spec: DownloadSpec = serde_json::from_slice(&bytes).map_err(|_| {
        HostError::InvalidProject("The cached download manifest is invalid.".into())
    })?;
    validate_spec(&spec)?;
    Ok(spec)
}
fn part_path(session: &Path, number: u32) -> Result<PathBuf, HostError> {
    checked_path(session, Path::new(&format!("part-{number:06}.bin")), false)
}
fn digest_file(path: &Path, maximum: u64, cancel: &AtomicBool) -> Result<(String, u64), HostError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || crate::is_link(&metadata) || metadata.len() > maximum {
        return Err(HostError::InvalidPath(
            "A download part or destination is not a bounded regular file.".into(),
        ));
    }
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut size = 0;
    let mut buffer = [0_u8; BUFFER_BYTES];
    loop {
        check_cancelled(cancel)?;
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > maximum {
            return Err(HostError::UnsupportedFile(
                "A cached download part exceeds its size limit.".into(),
            ));
        }
        digest.update(&buffer[..count]);
    }
    Ok((format!("{:x}", digest.finalize()), size))
}
fn progress(
    session: &Path,
    spec: &DownloadSpec,
    cancel: &AtomicBool,
) -> Result<DownloadProgress, HostError> {
    let mut completed_parts = Vec::new();
    let mut completed_bytes = 0;
    for part in &spec.parts {
        check_cancelled(cancel)?;
        let path = part_path(session, part.part_number)?;
        if !path.exists() {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)?;
        if crate::is_link(&metadata) || !metadata.is_file() {
            return Err(HostError::InvalidPath(
                "Cached download parts cannot be links or special files.".into(),
            ));
        }
        let valid = if metadata.len() != part.size {
            false
        } else {
            digest_file(&path, part.size, cancel)?.0 == part.sha256
        };
        if valid {
            completed_parts.push(part.part_number);
            completed_bytes += part.size;
        } else {
            fs::remove_file(&path)?;
        }
    }
    Ok(DownloadProgress {
        completed_parts,
        completed_bytes,
        total_bytes: spec.size,
    })
}
fn begin(app_cache: &Path, spec: &DownloadSpec) -> Result<DownloadProgress, HostError> {
    validate_spec(spec)?;
    let root = cache_root(app_cache)?;
    let session = session(&root, &spec.cache_key, true)?;
    let _guard = ProjectLock::acquire(&session)?;
    let manifest = manifest_path(&session)?;
    if manifest.exists() {
        if read_spec(&session)? != *spec {
            return Err(HostError::Conflict(
                "The cached file belongs to a different download version or account scope.".into(),
            ));
        }
    } else {
        write_private(
            &manifest,
            &serde_json::to_vec(spec).map_err(|_| {
                HostError::InvalidProject("The download manifest could not be serialized.".into())
            })?,
        )?;
    }
    progress(&session, spec, &AtomicBool::new(false))
}
fn write_part(
    app_cache: &Path,
    request: &DownloadWrite,
    cancel: &AtomicBool,
) -> Result<(), HostError> {
    if request.bytes.len() as u64 > CHUNK_BYTES {
        return Err(HostError::UnsupportedFile(
            "A download part cannot exceed 8 MiB.".into(),
        ));
    }
    check_cancelled(cancel)?;
    let root = cache_root(app_cache)?;
    let session = session(&root, &request.cache_key, false)?;
    let _guard = ProjectLock::acquire(&session)?;
    let spec = read_spec(&session)?;
    let part = spec
        .parts
        .iter()
        .find(|part| part.part_number == request.part_number)
        .ok_or_else(|| HostError::InvalidProject("Unknown download part number.".into()))?;
    if request.bytes.len() as u64 != part.size
        || format!("{:x}", Sha256::digest(&request.bytes)) != part.sha256
    {
        return Err(HostError::InvalidProject("Downloaded file part failed its size or SHA-256 integrity check; no cached part was replaced.".into()));
    }
    check_cancelled(cancel)?;
    write_private(&part_path(&session, part.part_number)?, &request.bytes)
}
fn destination_hash(path: &Path, cancel: &AtomicBool) -> Result<Option<String>, HostError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(Some(digest_file(path, u64::MAX, cancel)?.0)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
fn save_to_path(
    app_cache: &Path,
    key: &str,
    selected: &Path,
    cancel: &AtomicBool,
) -> Result<DownloadSaved, HostError> {
    check_cancelled(cancel)?;
    if !selected.is_absolute() {
        return Err(HostError::InvalidPath(
            "Choose an absolute local download destination.".into(),
        ));
    }
    let parent = fs::canonicalize(selected.parent().ok_or_else(|| {
        HostError::InvalidPath("The download destination needs a parent folder.".into())
    })?)?;
    let filename = selected.file_name().ok_or_else(|| {
        HostError::InvalidPath("The download destination needs a filename.".into())
    })?;
    let destination = parent.join(filename);
    let expected = destination_hash(&destination, cancel)?;
    let root = cache_root(app_cache)?;
    let session = session(&root, key, false)?;
    let _guard = ProjectLock::acquire(&session)?;
    let spec = read_spec(&session)?;
    let temporary = parent.join(format!(".draftmatter-download-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&temporary)?;
        let mut total = 0;
        let mut buffer = [0_u8; BUFFER_BYTES];
        for part in &spec.parts {
            check_cancelled(cancel)?;
            let path = part_path(&session, part.part_number)?;
            let metadata = fs::symlink_metadata(&path)?;
            if !metadata.is_file() || crate::is_link(&metadata) || metadata.len() != part.size {
                return Err(HostError::InvalidProject(
                    "A cached file part is missing or changed; resume the download before saving."
                        .into(),
                ));
            }
            let mut input = File::open(&path)?;
            let mut digest = Sha256::new();
            let mut size = 0;
            loop {
                check_cancelled(cancel)?;
                let count = input.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                size += count as u64;
                if size > part.size {
                    return Err(HostError::InvalidProject(
                        "A cached file part grew during assembly.".into(),
                    ));
                }
                digest.update(&buffer[..count]);
                output.write_all(&buffer[..count])?;
            }
            if size != part.size || format!("{:x}", digest.finalize()) != part.sha256 {
                return Err(HostError::InvalidProject("A cached file part failed its SHA-256 integrity check; the selected destination was not changed.".into()));
            }
            total += size;
        }
        if total != spec.size {
            return Err(HostError::InvalidProject(
                "The assembled file size did not match its manifest.".into(),
            ));
        }
        output.sync_all()?;
        drop(output);
        check_cancelled(cancel)?;
        if destination_hash(&destination, cancel)? != expected {
            return Err(HostError::Conflict("The selected destination changed while the file was being saved. Choose it again explicitly.".into()));
        }
        if expected.is_none() {
            // Exclusive publication refuses a file created since the save dialog;
            // the temporary file lives on the same filesystem as the destination.
            fs::hard_link(&temporary, &destination).map_err(|error| HostError::Io(format!("The download could not be published without overwriting another file. Choose a different destination: {error}")))?;
            fs::remove_file(&temporary)?;
        } else {
            crate::replace_file(&temporary, &destination)?;
        }
        crate::project_transactions::sync_directory(&parent)?;
        Ok(DownloadSaved {
            path: destination.to_string_lossy().into_owned(),
            bytes: total,
        })
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
fn app_cache(app: &tauri::AppHandle) -> Result<PathBuf, HostError> {
    app.path().app_cache_dir().map_err(|error| {
        HostError::Io(format!(
            "The private download cache is unavailable: {error}"
        ))
    })
}

#[tauri::command]
pub async fn begin_project_file_download(
    app: tauri::AppHandle,
    registry: tauri::State<'_, DownloadRegistry>,
    request: DownloadSpec,
) -> Result<DownloadStarted, HostError> {
    let cache = app_cache(&app)?;
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let progress = begin(&cache, &request)?;
        let operation_id = registry.register(&request.cache_key)?;
        Ok(DownloadStarted {
            operation_id,
            progress,
        })
    })
    .await
    .map_err(|error| HostError::Io(error.to_string()))?
}
#[tauri::command]
pub async fn write_project_file_download_part(
    app: tauri::AppHandle,
    registry: tauri::State<'_, DownloadRegistry>,
    request: DownloadWrite,
) -> Result<(), HostError> {
    let cache = app_cache(&app)?;
    let cancel = registry.active(&DownloadOperation {
        cache_key: request.cache_key.clone(),
        operation_id: request.operation_id.clone(),
    })?;
    tauri::async_runtime::spawn_blocking(move || write_part(&cache, &request, &cancel))
        .await
        .map_err(|error| HostError::Io(error.to_string()))?
}
#[tauri::command]
pub async fn project_file_download_status(
    app: tauri::AppHandle,
    registry: tauri::State<'_, DownloadRegistry>,
    request: DownloadOperation,
) -> Result<DownloadProgress, HostError> {
    let cache = app_cache(&app)?;
    let cancel = registry.active(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = cache_root(&cache)?;
        let session = session(&root, &request.cache_key, false)?;
        let _guard = ProjectLock::acquire(&session)?;
        progress(&session, &read_spec(&session)?, &cancel)
    })
    .await
    .map_err(|error| HostError::Io(error.to_string()))?
}
#[tauri::command]
pub fn cancel_project_file_download(
    registry: tauri::State<'_, DownloadRegistry>,
    operation_id: String,
) {
    registry.finish(&operation_id, true);
}
#[tauri::command]
pub async fn save_project_file_download(
    app: tauri::AppHandle,
    registry: tauri::State<'_, DownloadRegistry>,
    request: DownloadOperation,
) -> Result<Option<DownloadSaved>, HostError> {
    let cache = app_cache(&app)?;
    let cancel = registry.active(&request)?;
    let registry = registry.inner().clone();
    let operation_id = request.operation_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let root = cache_root(&cache)?;
        let session = session(&root, &request.cache_key, false)?;
        let spec = read_spec(&session)?;
        check_cancelled(&cancel)?;
        let selected = app
            .dialog()
            .file()
            .set_title("Save project data file")
            .set_file_name(&spec.filename)
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|_| {
            HostError::InvalidPath("The selected download destination is not a local file.".into())
        })?;
        save_to_path(&cache, &request.cache_key, &path, &cancel).map(Some)
    })
    .await
    .map_err(|error| HostError::Io(error.to_string()))
    .and_then(|result| result);
    registry.finish(&operation_id, false);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    fn spec(bytes: &[u8]) -> DownloadSpec {
        DownloadSpec {
            cache_key: "a".repeat(64),
            filename: "measurements.csv".into(),
            size: bytes.len() as u64,
            chunk_size: CHUNK_BYTES,
            parts: if bytes.is_empty() {
                vec![]
            } else {
                vec![DownloadPart {
                    part_number: 1,
                    size: bytes.len() as u64,
                    sha256: format!("{:x}", Sha256::digest(bytes)),
                }]
            },
        }
    }
    fn put(cache: &Path, spec: &DownloadSpec, bytes: &[u8]) {
        write_part(
            cache,
            &DownloadWrite {
                cache_key: spec.cache_key.clone(),
                operation_id: "test-only".into(),
                part_number: 1,
                bytes: bytes.to_vec(),
            },
            &AtomicBool::new(false),
        )
        .unwrap();
    }
    #[test]
    fn reopening_rehashes_disk_parts_and_refetches_same_size_corruption() {
        let cache = tempdir().unwrap();
        let spec = spec(b"abc");
        assert!(begin(cache.path(), &spec)
            .unwrap()
            .completed_parts
            .is_empty());
        put(cache.path(), &spec, b"abc");
        assert_eq!(begin(cache.path(), &spec).unwrap().completed_parts, vec![1]);
        let root = cache_root(cache.path()).unwrap();
        let session = session(&root, &spec.cache_key, false).unwrap();
        fs::write(part_path(&session, 1).unwrap(), b"bad").unwrap();
        assert!(begin(cache.path(), &spec)
            .unwrap()
            .completed_parts
            .is_empty());
        assert!(!part_path(&session, 1).unwrap().exists());
    }
    #[test]
    fn cache_keys_are_isolated_and_existing_specs_cannot_be_rebound() {
        let cache = tempdir().unwrap();
        let first = spec(b"abc");
        begin(cache.path(), &first).unwrap();
        put(cache.path(), &first, b"abc");
        let mut other = first.clone();
        other.cache_key = "b".repeat(64);
        assert!(begin(cache.path(), &other)
            .unwrap()
            .completed_parts
            .is_empty());
        other = first.clone();
        other.filename = "different.csv".into();
        assert!(matches!(
            begin(cache.path(), &other),
            Err(HostError::Conflict(_))
        ));
        other.cache_key = "../outside".into();
        assert!(begin(cache.path(), &other).is_err());
    }
    #[test]
    fn invalid_incoming_checksums_never_replace_a_valid_cached_part() {
        let cache = tempdir().unwrap();
        let spec = spec(b"abc");
        begin(cache.path(), &spec).unwrap();
        put(cache.path(), &spec, b"abc");
        let corrupt = DownloadWrite {
            cache_key: spec.cache_key.clone(),
            operation_id: "test-only".into(),
            part_number: 1,
            bytes: b"bad".to_vec(),
        };
        assert!(write_part(cache.path(), &corrupt, &AtomicBool::new(false)).is_err());
        assert_eq!(begin(cache.path(), &spec).unwrap().completed_parts, vec![1]);
    }
    #[test]
    fn final_save_streams_in_part_order_and_checks_each_part_before_publication() {
        let cache = tempdir().unwrap();
        let output = tempdir().unwrap();
        let first = vec![7_u8; CHUNK_BYTES as usize];
        let second = b"end";
        let spec = DownloadSpec {
            cache_key: "a".repeat(64),
            filename: "data.csv".into(),
            size: CHUNK_BYTES + 3,
            chunk_size: CHUNK_BYTES,
            parts: vec![
                DownloadPart {
                    part_number: 1,
                    size: CHUNK_BYTES,
                    sha256: format!("{:x}", Sha256::digest(&first)),
                },
                DownloadPart {
                    part_number: 2,
                    size: 3,
                    sha256: format!("{:x}", Sha256::digest(second)),
                },
            ],
        };
        begin(cache.path(), &spec).unwrap();
        put(cache.path(), &spec, &first);
        write_part(
            cache.path(),
            &DownloadWrite {
                cache_key: spec.cache_key.clone(),
                operation_id: "test-only".into(),
                part_number: 2,
                bytes: second.to_vec(),
            },
            &AtomicBool::new(false),
        )
        .unwrap();
        let destination = output.path().join("chosen.csv");
        let result = save_to_path(
            cache.path(),
            &spec.cache_key,
            &destination,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(result.bytes, spec.size);
        assert_eq!(fs::metadata(&destination).unwrap().len(), spec.size);
        let mut expected = Sha256::new();
        expected.update(&first);
        expected.update(second);
        assert_eq!(
            digest_file(&destination, spec.size, &AtomicBool::new(false))
                .unwrap()
                .0,
            format!("{:x}", expected.finalize())
        );
        assert_eq!(fs::read_dir(output.path()).unwrap().count(), 1);
    }
    #[test]
    fn corrupt_or_cancelled_downloads_leave_the_selected_existing_file_untouched() {
        let cache = tempdir().unwrap();
        let output = tempdir().unwrap();
        let spec = spec(b"abc");
        begin(cache.path(), &spec).unwrap();
        put(cache.path(), &spec, b"abc");
        let destination = output.path().join("chosen.csv");
        fs::write(&destination, b"existing user data").unwrap();
        assert!(save_to_path(
            cache.path(),
            &spec.cache_key,
            &destination,
            &AtomicBool::new(true)
        )
        .is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"existing user data");
        let root = cache_root(cache.path()).unwrap();
        let session = session(&root, &spec.cache_key, false).unwrap();
        fs::write(part_path(&session, 1).unwrap(), b"bad").unwrap();
        assert!(save_to_path(
            cache.path(),
            &spec.cache_key,
            &destination,
            &AtomicBool::new(false)
        )
        .is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"existing user data");
        assert_eq!(fs::read_dir(output.path()).unwrap().count(), 1);
        assert!(manifest_path(&session).unwrap().exists());
    }
    #[test]
    fn supports_one_gigabyte_metadata_without_allocating_a_file_sized_buffer_and_refuses_more() {
        let cache = tempdir().unwrap();
        let mut spec = spec(b"");
        spec.size = MAX_FILE_BYTES;
        spec.parts = (0..spec.size.div_ceil(CHUNK_BYTES))
            .map(|index| DownloadPart {
                part_number: index as u32 + 1,
                size: (spec.size - index * CHUNK_BYTES).min(CHUNK_BYTES),
                sha256: "0".repeat(64),
            })
            .collect();
        let result = begin(cache.path(), &spec).unwrap();
        assert_eq!(result.total_bytes, MAX_FILE_BYTES);
        assert!(result.completed_parts.is_empty());
        spec.size += 1;
        assert!(begin(cache.path(), &spec).is_err());
    }
    #[test]
    fn operation_cancellation_is_opaque_scoped_and_does_not_cancel_a_later_resume() {
        let registry = DownloadRegistry::default();
        let key = "a".repeat(64);
        let id = registry.register(&key).unwrap();
        let flag = registry
            .active(&DownloadOperation {
                cache_key: key.clone(),
                operation_id: id.clone(),
            })
            .unwrap();
        assert!(registry
            .active(&DownloadOperation {
                cache_key: "b".repeat(64),
                operation_id: id.clone()
            })
            .is_err());
        registry.finish(&id, true);
        assert!(flag.load(Ordering::SeqCst));
        let next = registry.register(&key).unwrap();
        assert_ne!(next, id);
        assert!(!registry
            .active(&DownloadOperation {
                cache_key: key,
                operation_id: next
            })
            .unwrap()
            .load(Ordering::SeqCst));
    }
    #[cfg(unix)]
    #[test]
    fn cache_is_private_and_rejects_symlink_sessions_parts_and_destinations() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let cache = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let spec = spec(b"abc");
        begin(cache.path(), &spec).unwrap();
        put(cache.path(), &spec, b"abc");
        let root = cache_root(cache.path()).unwrap();
        let session = session(&root, &spec.cache_key, false).unwrap();
        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(part_path(&session, 1).unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        fs::write(outside.path().join("secret"), b"outside").unwrap();
        let path = part_path(&session, 1).unwrap();
        fs::remove_file(&path).unwrap();
        symlink(outside.path().join("secret"), &path).unwrap();
        assert!(begin(cache.path(), &spec).is_err());
        assert_eq!(fs::read(outside.path().join("secret")).unwrap(), b"outside");
        fs::remove_file(path).unwrap();
        put(cache.path(), &spec, b"abc");
        let destination = outside.path().join("chosen.csv");
        symlink(outside.path().join("secret"), &destination).unwrap();
        assert!(save_to_path(
            cache.path(),
            &spec.cache_key,
            &destination,
            &AtomicBool::new(false)
        )
        .is_err());
        assert_eq!(fs::read(outside.path().join("secret")).unwrap(), b"outside");
        let linked_key = "b".repeat(64);
        symlink(outside.path(), root.join(&linked_key)).unwrap();
        let mut linked = spec.clone();
        linked.cache_key = linked_key;
        assert!(begin(cache.path(), &linked).is_err());
    }
    #[test]
    fn an_empty_file_can_be_saved_without_fetching_or_buffering_parts() {
        let cache = tempdir().unwrap();
        let output = tempdir().unwrap();
        let spec = spec(b"");
        begin(cache.path(), &spec).unwrap();
        let result = save_to_path(
            cache.path(),
            &spec.cache_key,
            &output.path().join("empty.csv"),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(result.bytes, 0);
    }
    #[test]
    #[ignore = "Manual 1 GB disk-stream smoke test; run explicitly when validating the download size limit"]
    fn one_gigabyte_assembly_uses_bounded_streams() {
        use std::io::{Seek, SeekFrom};
        let cache = tempdir().unwrap();
        let output = tempdir().unwrap();
        let zeros = vec![0_u8; CHUNK_BYTES as usize];
        let full_hash = format!("{:x}", Sha256::digest(&zeros));
        let mut spec = spec(b"");
        spec.size = MAX_FILE_BYTES;
        spec.parts = (0..spec.size.div_ceil(CHUNK_BYTES))
            .map(|index| {
                let size = (spec.size - index * CHUNK_BYTES).min(CHUNK_BYTES);
                DownloadPart {
                    part_number: index as u32 + 1,
                    size,
                    sha256: if size == CHUNK_BYTES {
                        full_hash.clone()
                    } else {
                        format!("{:x}", Sha256::digest(&zeros[..size as usize]))
                    },
                }
            })
            .collect();
        begin(cache.path(), &spec).unwrap();
        let root = cache_root(cache.path()).unwrap();
        let session = session(&root, &spec.cache_key, false).unwrap();
        for part in &spec.parts {
            let file = File::create(part_path(&session, part.part_number).unwrap()).unwrap();
            file.set_len(part.size).unwrap();
        }
        drop(zeros);
        let destination = output.path().join("one-gigabyte.bin");
        assert_eq!(
            save_to_path(
                cache.path(),
                &spec.cache_key,
                &destination,
                &AtomicBool::new(false)
            )
            .unwrap()
            .bytes,
            MAX_FILE_BYTES
        );
        let mut saved = File::open(destination).unwrap();
        assert_eq!(saved.metadata().unwrap().len(), MAX_FILE_BYTES);
        saved.seek(SeekFrom::End(-1)).unwrap();
        let mut last = [1_u8];
        saved.read_exact(&mut last).unwrap();
        assert_eq!(last, [0]);
    }
}

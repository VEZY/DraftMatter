//! Shared local-filesystem transaction/lock protocol with src/projectTransactions.ts.
//! Bakery claims have unique names: reclaiming a dead claim cannot unlink a new
//! owner's lock. Never use a timeout to steal a lock from a living process.
use crate::{checked_path, safe_relative, write_atomic, HostError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::rc::{Rc, Weak};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const MAX_BYTES: u64 = 128 * 1024 * 1024;
const OWNER: &[u8] = br#"{"engine":"draftmatter","schemaVersion":2}"#;

pub(crate) fn sync_directory(path: &Path) -> Result<(), HostError> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    Ok(())
}

fn directory(root: &Path, relative: &str) -> Result<PathBuf, HostError> {
    let path = checked_path(root, &safe_relative(relative)?, false)?;
    let existed = path.exists();
    fs::create_dir_all(&path)?;
    let path = checked_path(root, &safe_relative(relative)?, false)?;
    if !existed {
        let mut current = path.as_path();
        while current != root {
            let parent = current.parent().ok_or_else(|| {
                HostError::InvalidPath("A transaction directory left its root.".into())
            })?;
            sync_directory(parent)?;
            current = parent;
        }
    }
    Ok(path)
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    unsafe {
        libc::kill(pid as i32, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
}
#[cfg(windows)]
fn alive(pid: u32) -> bool {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn GetExitCodeProcess(process: *mut c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetLastError() -> u32;
    }
    unsafe {
        let handle = OpenProcess(0x1000, 0, pid);
        if handle.is_null() {
            return GetLastError() != 87;
        }
        let mut code = 0;
        let result = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        result == 0 || code == 259
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Claim {
    schema_version: u8,
    pid: u32,
    nonce: String,
    choosing: bool,
    ticket: u64,
}

fn claims(root: &Path, locks: &Path) -> Result<Vec<Claim>, HostError> {
    let mut claims = Vec::new();
    for (count, entry) in fs::read_dir(locks)?.enumerate() {
        if count >= 4096 {
            return Err(HostError::UnsupportedFile(
                "The project has too many lock records; coordination files were preserved.".into(),
            ));
        }
        let name = entry?.file_name().to_string_lossy().into_owned();
        let Some((pid, nonce)) = name
            .strip_suffix(".json")
            .and_then(|name| name.split_once('-'))
        else {
            continue;
        };
        let (Ok(pid), Ok(_)) = (pid.parse::<u32>(), Uuid::parse_str(nonce)) else {
            continue;
        };
        let path = checked_path(
            root,
            &Path::new(".draftmatter/write-locks").join(&name),
            false,
        )?;
        if !alive(pid) {
            match fs::remove_file(&path) {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.into()),
            }
            continue;
        }
        let Some(bytes) = recovery_bytes(&path, 4096)? else {
            continue;
        };
        let claim: Claim = serde_json::from_slice(&bytes).map_err(|_| {
            HostError::Conflict(
                "A live project lock is invalid; close other DraftMatter clients and retry.".into(),
            )
        })?;
        if claim.schema_version != 1
            || claim.pid != pid
            || claim.nonce != nonce
            || claim.ticket > 9_007_199_254_740_991
        {
            return Err(HostError::Conflict(
                "Invalid project lock metadata was preserved for inspection.".into(),
            ));
        }
        claims.push(claim);
    }
    Ok(claims)
}

struct LockOwner {
    root: PathBuf,
    path: PathBuf,
}
impl Drop for LockOwner {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        if let Some(parent) = self.path.parent() {
            let _ = sync_directory(parent);
        }
        let _ = HELD.try_with(|held| {
            held.borrow_mut().remove(&self.root);
        });
    }
}
thread_local! { static HELD: RefCell<HashMap<PathBuf, Weak<LockOwner>>> = RefCell::new(HashMap::new()); }
pub(crate) struct ProjectLock {
    _owner: Rc<LockOwner>,
}
impl ProjectLock {
    pub(crate) fn acquire(root: &Path) -> Result<Self, HostError> {
        if let Some(owner) = HELD.with(|held| held.borrow().get(root).and_then(Weak::upgrade)) {
            return Ok(Self { _owner: owner });
        }
        let locks = directory(root, ".draftmatter/write-locks")?;
        let nonce = Uuid::new_v4().to_string();
        let path = locks.join(format!("{}-{nonce}.json", std::process::id()));
        let owner = Rc::new(LockOwner {
            root: root.to_path_buf(),
            path,
        });
        let mut claim = Claim {
            schema_version: 1,
            pid: std::process::id(),
            nonce,
            choosing: true,
            ticket: 0,
        };
        write_atomic(&owner.path, &serde_json::to_vec(&claim).unwrap(), false)?;
        let maximum = claims(root, &locks)?
            .iter()
            .map(|claim| claim.ticket)
            .max()
            .unwrap_or(0);
        if maximum >= 9_007_199_254_740_991 {
            return Err(HostError::Conflict(
                "The project lock ticket range is exhausted.".into(),
            ));
        }
        claim.ticket = maximum + 1;
        claim.choosing = false;
        write_atomic(&owner.path, &serde_json::to_vec(&claim).unwrap(), false)?;
        let started = Instant::now();
        loop {
            let blocked = claims(root, &locks)?.iter().any(|other| {
                other.nonce != claim.nonce
                    && (other.choosing
                        || (other.ticket > 0
                            && (other.ticket, &other.nonce) < (claim.ticket, &claim.nonce)))
            });
            if !blocked {
                break;
            }
            if started.elapsed() > Duration::from_secs(15) {
                return Err(HostError::Conflict("Another DraftMatter client is writing this project. Wait for it to finish, or close that client and retry. No files were overwritten.".into()));
            }
            thread::sleep(Duration::from_millis(20));
        }
        HELD.with(|held| {
            held.borrow_mut()
                .insert(root.to_path_buf(), Rc::downgrade(&owner));
        });
        Ok(Self { _owner: owner })
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransactionFile {
    target: String,
    backup: Option<String>,
    before_hash: Option<String>,
    after_hash: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u8,
    engine: String,
    state: String,
    files: Vec<TransactionFile>,
}
fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
pub(crate) fn recovery_bytes(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, HostError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if file.metadata()?.len() > limit {
        return Err(HostError::UnsupportedFile(
            "Project coordination or recovery data exceeds its size limit; it was preserved."
                .into(),
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(HostError::UnsupportedFile(
            "Project coordination or recovery data exceeds its size limit; it was preserved."
                .into(),
        ));
    }
    Ok(Some(bytes))
}
fn target(root: &Path, relative: &str) -> Result<PathBuf, HostError> {
    let path = safe_relative(relative)?;
    let lower = relative.to_ascii_lowercase();
    if path.components().any(|part| {
        part.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(".git")
    }) || [".draftmatter/write-locks", ".draftmatter/transactions"]
        .iter()
        .any(|reserved| lower == *reserved || lower.starts_with(&format!("{reserved}/")))
    {
        return Err(HostError::InvalidPath(
            "Transactions cannot replace Git, lock, or recovery metadata.".into(),
        ));
    }
    checked_path(root, &path, false)
}
fn rollback(root: &Path, directory: &Path, manifest: &Manifest) -> Result<(), HostError> {
    if manifest.schema_version != 2
        || manifest.engine != "draftmatter"
        || manifest.files.len() > 512
    {
        return Err(HostError::InvalidProject(
            "Unsupported project recovery journal; no files were changed.".into(),
        ));
    }
    let mut seen = HashSet::new();
    let mut total = 0;
    let mut replacements = Vec::new();
    for (index, file) in manifest.files.iter().enumerate() {
        let path = target(root, &file.target)?;
        let valid_hash = |value: &Option<String>| {
            value.as_ref().is_none_or(|hash| {
                hash.len() == 71
                    && hash.starts_with("sha256:")
                    && hash[7..]
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        };
        if !valid_hash(&file.before_hash) || !valid_hash(&file.after_hash) {
            return Err(HostError::InvalidProject(
                "Invalid recovery fingerprint; the journal was preserved.".into(),
            ));
        }
        let expected_backup = file
            .before_hash
            .as_ref()
            .map(|_| format!("backup-{index}.bin"));
        if !seen.insert(file.target.to_ascii_lowercase()) || file.backup != expected_backup {
            return Err(HostError::InvalidProject(
                "Invalid project recovery target or backup; the journal was preserved.".into(),
            ));
        }
        let backup = match &file.backup {
            Some(name) => {
                let backup = checked_path(directory, Path::new(name), false)?;
                let bytes = recovery_bytes(&backup, MAX_BYTES - total)?.ok_or_else(|| {
                    HostError::InvalidProject("A project recovery backup is missing.".into())
                })?;
                total += bytes.len() as u64;
                Some(bytes)
            }
            None => None,
        };
        if backup.as_ref().map(|bytes| hash(bytes)) != file.before_hash {
            return Err(HostError::InvalidProject(
                "A project recovery backup is invalid; the journal was preserved.".into(),
            ));
        }
        let current_hash = recovery_bytes(&path, MAX_BYTES)?
            .as_ref()
            .map(|bytes| hash(bytes));
        if current_hash != file.before_hash && current_hash != file.after_hash {
            return Err(HostError::Conflict(format!("{} changed after an interrupted transaction. Its current file and recovery backup were preserved; resolve this conflict before reopening the project.", file.target)));
        }
        replacements.push((path, backup));
    }
    for (path, backup) in replacements.into_iter().rev() {
        if let Some(bytes) = backup {
            write_atomic(&path, &bytes, false)?;
        } else if path.exists() {
            fs::remove_file(&path)?;
            sync_directory(path.parent().unwrap())?;
        }
    }
    Ok(())
}

/// The caller must hold ProjectLock. Unknown/legacy journals are left to their
/// owning recovery implementation, never discarded just for lacking our file.
pub(crate) fn recover(root: &Path) -> Result<(), HostError> {
    let transactions = checked_path(root, Path::new(".draftmatter/transactions"), false)?;
    if !transactions.exists() {
        return Ok(());
    }
    let mut entries = fs::read_dir(&transactions)?
        .take(4097)
        .collect::<Result<Vec<_>, _>>()?;
    if entries.len() > 4096 {
        return Err(HostError::UnsupportedFile(
            "The project has too many recovery records; recovery files were preserved.".into(),
        ));
    }
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = checked_path(&transactions, Path::new(&name), false)?;
        if !path.is_dir() {
            continue;
        }
        if !name
            .strip_prefix("v2-")
            .is_some_and(|suffix| Uuid::parse_str(suffix).is_ok())
        {
            let legacy_path = checked_path(&path, Path::new("journal.json"), false)?;
            if let Some(bytes) = recovery_bytes(&legacy_path, 1024 * 1024)? {
                let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
                    HostError::InvalidProject(
                        "Invalid legacy AI recovery journal was preserved.".into(),
                    )
                })?;
                if matches!(
                    value["state"].as_str(),
                    Some("staged" | "recovery-required")
                ) {
                    return Err(HostError::Conflict(format!("An older interrupted AI transaction needs recovery at {}. Close old clients and recover its backup before continuing; no recovery files were removed.", path.display())));
                }
            }
            continue;
        }
        let manifest_path = checked_path(&path, Path::new("manifest.json"), false)?;
        let Some(bytes) = recovery_bytes(&manifest_path, 1024 * 1024)? else {
            let owner = recovery_bytes(&checked_path(&path, Path::new("owner.json"), false)?, 128)?;
            if owner.as_deref() == Some(OWNER) {
                fs::remove_dir_all(&path)?;
            }
            continue;
        };
        if bytes.len() > 1024 * 1024 {
            return Err(HostError::UnsupportedFile(
                "Project recovery journal exceeds the 1 MB limit.".into(),
            ));
        }
        let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| {
            HostError::InvalidProject("Invalid project recovery journal was preserved.".into())
        })?;
        if manifest.schema_version != 2 || manifest.engine != "draftmatter" {
            return Err(HostError::InvalidProject(
                "Unknown project recovery journal was preserved.".into(),
            ));
        }
        match manifest.state.as_str() {
            "prepared" => rollback(root, &path, &manifest)?,
            "committed" => (),
            _ => {
                return Err(HostError::InvalidProject(
                    "Unknown project recovery state was preserved.".into(),
                ))
            }
        }
        fs::remove_dir_all(&path)?;
    }
    sync_directory(&transactions)
}

pub(crate) fn apply(
    root: &Path,
    changes: Vec<(String, Option<Vec<u8>>)>,
    mut after_replacement: impl FnMut(usize) -> Result<(), HostError>,
) -> Result<(), HostError> {
    let mut seen = HashSet::new();
    if changes.is_empty()
        || changes.len() > 512
        || changes
            .iter()
            .any(|(path, _)| !seen.insert(path.to_ascii_lowercase()))
    {
        return Err(HostError::InvalidProject(
            "A transaction requires 1–512 distinct paths.".into(),
        ));
    }
    for (path, _) in &changes {
        target(root, path)?;
    }
    let directory = directory(
        root,
        &format!(".draftmatter/transactions/v2-{}", Uuid::new_v4()),
    )?;
    write_atomic(&directory.join("owner.json"), OWNER, false)?;
    let mut manifest = Manifest {
        schema_version: 2,
        engine: "draftmatter".into(),
        state: "prepared".into(),
        files: Vec::new(),
    };
    let mut total = 0_u64;
    for (index, (relative, content)) in changes.iter().enumerate() {
        let before = recovery_bytes(&target(root, relative)?, MAX_BYTES)?;
        total += before.as_ref().map_or(0, |bytes| bytes.len() as u64)
            + content.as_ref().map_or(0, |bytes| bytes.len() as u64);
        if total > MAX_BYTES {
            return Err(HostError::UnsupportedFile(
                "The project transaction exceeds the 128 MB limit.".into(),
            ));
        }
        let backup = before.as_ref().map(|_| format!("backup-{index}.bin"));
        if let Some(bytes) = &before {
            write_atomic(&directory.join(backup.as_ref().unwrap()), bytes, false)?;
        }
        if let Some(bytes) = content {
            write_atomic(&directory.join(format!("staged-{index}.bin")), bytes, false)?;
        }
        manifest.files.push(TransactionFile {
            target: relative.clone(),
            backup,
            before_hash: before.as_ref().map(|bytes| hash(bytes)),
            after_hash: content.as_ref().map(|bytes| hash(bytes)),
        });
    }
    let manifest_path = directory.join("manifest.json");
    write_atomic(
        &manifest_path,
        &serde_json::to_vec(&manifest).unwrap(),
        false,
    )?;
    let result: Result<(), HostError> = (|| {
        for (index, (relative, content)) in changes.iter().enumerate() {
            let path = target(root, relative)?;
            if let Some(bytes) = content {
                write_atomic(&path, bytes, false)?;
            } else if path.exists() {
                fs::remove_file(&path)?;
                sync_directory(path.parent().unwrap())?;
            }
            after_replacement(index + 1)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        rollback(root, &directory, &manifest)?;
        fs::remove_dir_all(&directory)?;
        return Err(HostError::Io(format!(
            "{error} The project transaction was rolled back."
        )));
    }
    // Publishing a commit marker may succeed before its directory flush fails.
    // Never roll targets back once marker publication begins: recovery decides
    // from the marker actually on disk, preserving a complete old/new revision.
    manifest.state = "committed".into();
    write_atomic(&manifest_path, &serde_json::to_vec(&manifest).unwrap(), false)
        .map_err(|error| HostError::Io(format!("All transaction files were written, but commit finalization could not be confirmed: {error}. Reopen the project for recovery; the journal was preserved.")))?;
    // Cleanup cannot change the outcome of a durably committed operation.
    let _ = fs::remove_dir_all(&directory);
    let _ = sync_directory(directory.parent().unwrap());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{save_document_impl, source_hash, SaveDocumentRequest};
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Child, Command, Stdio};
    use std::sync::{mpsc, Arc, Barrier};
    use tempfile::tempdir;

    struct ChildGuard(Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    fn project() -> tempfile::TempDir {
        let project = tempdir().unwrap();
        fs::write(project.path().join("paper.qmd"), "old-paper").unwrap();
        fs::write(project.path().join("references.json"), "old-references").unwrap();
        project
    }
    fn node(root: &Path, mode: &str) -> ChildGuard {
        ChildGuard(
            Command::new("node")
                .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
                .args([
                    "src/fixtures/transactions/process.mjs",
                    root.to_str().unwrap(),
                    mode,
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        )
    }
    fn wait_for_held(child: &mut ChildGuard) {
        let mut output = BufReader::new(child.0.stdout.take().unwrap());
        let mut line = String::new();
        loop {
            assert_ne!(
                output.read_line(&mut line).unwrap(),
                0,
                "writer exited before holding the lock"
            );
            if line.contains("\"kind\":\"held\"") {
                return;
            }
            line.clear();
        }
    }

    // Spawned as a separate test executable so SIGKILL exercises the actual
    // native transaction writer, not a recoverable error injected in its stack.
    #[test]
    fn native_process_fixture() {
        let Ok(root) = std::env::var("DRAFTMATTER_TRANSACTION_TEST_ROOT") else {
            return;
        };
        let root = Path::new(&root);
        let _guard = crate::project_guard(root).unwrap();
        apply(
            root,
            vec![
                ("paper.qmd".into(), Some(b"new-paper".to_vec())),
                ("references.json".into(), Some(b"new-references".to_vec())),
            ],
            |count| {
                if count == 1 {
                    println!("{{\"kind\":\"held\"}}");
                    std::io::stdout().flush().unwrap();
                    loop {
                        thread::sleep(Duration::from_secs(1));
                    }
                }
                Ok(())
            },
        )
        .unwrap();
    }

    #[test]
    fn native_writer_waits_for_node_then_recovers_all_files_after_its_abrupt_death() {
        let project = project();
        let mut writer = node(project.path(), "hold");
        wait_for_held(&mut writer);
        let root = project.path().to_path_buf();
        let (sent, received) = mpsc::channel();
        let native = thread::spawn(move || {
            let result = save_document_impl(SaveDocumentRequest {
                root: root.to_string_lossy().into_owned(),
                path: "paper.qmd".into(),
                content: "native-paper".into(),
                expected_hash: Some(source_hash(b"old-paper")),
            });
            sent.send(result).unwrap();
        });
        assert!(
            received.recv_timeout(Duration::from_millis(100)).is_err(),
            "native writer must not enter the Node transaction"
        );
        writer.0.kill().unwrap();
        writer.0.wait().unwrap();
        received
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .unwrap();
        native.join().unwrap();
        assert_eq!(
            fs::read_to_string(project.path().join("paper.qmd")).unwrap(),
            "native-paper"
        );
        assert_eq!(
            fs::read_to_string(project.path().join("references.json")).unwrap(),
            "old-references"
        );
        assert_eq!(
            fs::read_dir(project.path().join(".draftmatter/transactions"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn node_recovers_all_files_after_native_process_is_killed_between_replacements() {
        let project = project();
        let mut writer = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "project_transactions::tests::native_process_fixture",
                    "--nocapture",
                ])
                .env("DRAFTMATTER_TRANSACTION_TEST_ROOT", project.path())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        wait_for_held(&mut writer);
        assert_eq!(
            fs::read_to_string(project.path().join("paper.qmd")).unwrap(),
            "new-paper"
        );
        writer.0.kill().unwrap();
        writer.0.wait().unwrap();
        let mut recovery = node(project.path(), "recover");
        let output = recovery.0.stdout.take().unwrap();
        let lines = BufReader::new(output)
            .lines()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(recovery.0.wait().unwrap().success());
        let snapshot = lines
            .iter()
            .find_map(|line| {
                serde_json::from_str::<serde_json::Value>(line)
                    .ok()
                    .filter(|value| value["kind"] == "snapshot")
            })
            .unwrap();
        assert_eq!(snapshot["paper"], "old-paper");
        assert_eq!(snapshot["references"], "old-references");
        assert_eq!(
            fs::read_dir(project.path().join(".draftmatter/transactions"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn native_expected_hash_is_revalidated_inside_the_shared_lock() {
        let project = project();
        let barrier = Arc::new(Barrier::new(2));
        let threads = (0..2)
            .map(|index| {
                let root = project.path().to_string_lossy().into_owned();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    let expected_hash =
                        source_hash(&fs::read(Path::new(&root).join("paper.qmd")).unwrap());
                    barrier.wait();
                    save_document_impl(SaveDocumentRequest {
                        root,
                        path: "paper.qmd".into(),
                        content: format!("writer-{index}"),
                        expected_hash: Some(expected_hash),
                    })
                })
            })
            .collect::<Vec<_>>();
        let results = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(HostError::Conflict(_))))
                .count(),
            1
        );
    }
}

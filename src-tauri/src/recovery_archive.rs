//! Immutable user savepoints. Rolling autosaves never traverse or prune this archive.
use crate::{canonical_root, contained_path, manuscript_extension, now_millis, project_guard, recovery_document_directory, recovery_regular_bytes, safe_relative, slash_path, write_atomic, DocumentRecoverySnapshot, HostError, MAX_RECOVERY_DIRECTORY_ENTRIES, MAX_RECOVERY_SOURCE_BYTES};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const MAX_SAVED_VERSIONS: usize = 1000;
const MAX_METADATA_BYTES: u64 = 32 * 1024;
const MAX_DATE_MILLIS: u64 = 8_640_000_000_000_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEventOptions {
    pub kind: String,
    pub label: Option<String>,
    pub restored_from_id: Option<String>,
    pub original_saved_at_millis: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedDocumentVersionMetadata {
    pub id: String,
    pub document_path: String,
    pub saved_at_millis: u64,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restored_from_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_saved_at_millis: Option<u64>,
    pub source_hash: String,
    pub bytes: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedEvent {
    schema_version: u8,
    #[serde(flatten)]
    metadata: SavedDocumentVersionMetadata,
}

fn text_valid(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.chars().count() <= limit && !value.chars().any(char::is_control)
}

fn saved_kind(kind: &str) -> bool {
    matches!(kind, "manual" | "before-restore" | "restored" | "origin")
}

fn options_valid(options: &RecoveryEventOptions) -> bool {
    saved_kind(&options.kind)
        && options.label.as_deref().is_none_or(|label| text_valid(label, 160))
        && options.restored_from_id.as_deref().is_none_or(|id| text_valid(id, 8192))
        && options.original_saved_at_millis.is_none_or(|date| date > 0 && date <= MAX_DATE_MILLIS)
}

fn digest(source: &[u8]) -> String { format!("sha256:{:x}", Sha256::digest(source)) }

fn paths(raw_root: &str, relative: &str) -> Result<(PathBuf, String, PathBuf), HostError> {
    let root = canonical_root(raw_root)?;
    let manuscript = contained_path(&root, relative)?;
    if !manuscript_extension(&manuscript) { return Err(HostError::UnsupportedFile("Saved versions are available only for Markdown and Quarto manuscripts.".into())); }
    let (directory, document_path) = recovery_document_directory(&root, relative)?;
    let archive = contained_path(&root, &format!("{}/versions", slash_path(directory.strip_prefix(&root).map_err(|_| HostError::InvalidPath("The version archive escaped its project.".into()))?)))?;
    Ok((root, document_path, archive))
}

fn valid_event_name(name: &str) -> bool {
    let Some((date, uuid)) = name.split_once('-') else { return false; };
    date.parse::<u64>().is_ok_and(|date| date > 0 && date <= MAX_DATE_MILLIS) && Uuid::parse_str(uuid).is_ok()
}

fn metadata_at(root: &Path, document_path: &str, directory: &Path) -> Result<Option<SavedDocumentVersionMetadata>, HostError> {
    let metadata_path = directory.join("event.json");
    let Some(bytes) = recovery_regular_bytes(&metadata_path, MAX_METADATA_BYTES)? else { return Ok(None); };
    let event: SavedEvent = serde_json::from_slice(&bytes).map_err(|_| HostError::InvalidProject("A saved version has invalid metadata; its files were preserved.".into()))?;
    let metadata = event.metadata;
    let id = slash_path(directory.strip_prefix(root).map_err(|_| HostError::InvalidPath("The saved version escaped its project.".into()))?);
    if event.schema_version != 1 || metadata.id != id || metadata.document_path != document_path
        || metadata.saved_at_millis == 0 || metadata.saved_at_millis > MAX_DATE_MILLIS
        || metadata.bytes > MAX_RECOVERY_SOURCE_BYTES || !saved_kind(&metadata.kind)
        || metadata.title.as_deref().is_some_and(|value| !text_valid(value, 160))
        || !options_valid(&RecoveryEventOptions { kind: metadata.kind.clone(), label: metadata.label.clone(), restored_from_id: metadata.restored_from_id.clone(), original_saved_at_millis: metadata.original_saved_at_millis })
        || metadata.source_hash.len() != 71 || !metadata.source_hash.starts_with("sha256:") || !metadata.source_hash[7..].bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(HostError::InvalidProject("A saved version belongs to another document or has invalid metadata; its files were preserved.".into()));
    }
    Ok(Some(metadata))
}

pub fn list_saved_versions(raw_root: &str, relative: &str) -> Result<Vec<SavedDocumentVersionMetadata>, HostError> {
    let (root, document_path, archive) = paths(raw_root, relative)?;
    let entries = match fs::read_dir(&archive) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut versions = Vec::new();
    for (index, entry) in entries.enumerate() {
        if index >= MAX_RECOVERY_DIRECTORY_ENTRIES { return Err(HostError::UnsupportedFile("The saved-version archive exceeds its directory limit; every existing file was preserved.".into())); }
        let entry = entry?;
        if !entry.file_type()?.is_dir() { continue; }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue; };
        if !valid_event_name(&name) { continue; }
        let directory = contained_path(&root, &slash_path(entry.path().strip_prefix(&root).map_err(|_| HostError::InvalidPath("A saved version escaped its project.".into()))?))?;
        if let Some(metadata) = metadata_at(&root, &document_path, &directory)? { versions.push(metadata); }
        if versions.len() > MAX_SAVED_VERSIONS { return Err(HostError::UnsupportedFile("This document has more than 1,000 saved versions. Its archive was preserved; export or organize it before adding more.".into())); }
    }
    versions.sort_by(|left, right| right.saved_at_millis.cmp(&left.saved_at_millis).then_with(|| right.id.cmp(&left.id)));
    Ok(versions)
}

pub fn read_saved_version(raw_root: &str, relative: &str, id: &str) -> Result<DocumentRecoverySnapshot, HostError> {
    let (root, document_path, archive) = paths(raw_root, relative)?;
    let id_path = safe_relative(id)?;
    let directory = contained_path(&root, &slash_path(&id_path))?;
    if directory.parent() != Some(archive.as_path()) || !directory.file_name().and_then(|name| name.to_str()).is_some_and(valid_event_name) {
        return Err(HostError::InvalidPath("The selected saved version does not belong to this manuscript.".into()));
    }
    let metadata = metadata_at(&root, &document_path, &directory)?.ok_or_else(|| HostError::NotFound("The selected saved version is incomplete or no longer present; its files were preserved.".into()))?;
    let source_path = contained_path(&root, &format!("{id}/source.md"))?;
    let bytes = recovery_regular_bytes(&source_path, MAX_RECOVERY_SOURCE_BYTES)?.ok_or_else(|| HostError::NotFound("The saved manuscript source is missing.".into()))?;
    if bytes.len() as u64 != metadata.bytes || digest(&bytes) != metadata.source_hash { return Err(HostError::Conflict("The saved version source differs from its recorded fingerprint; it was preserved and was not restored.".into())); }
    let source = String::from_utf8(bytes).map_err(|_| HostError::UnsupportedFile("The saved version is not valid UTF-8; its source was preserved.".into()))?;
    Ok(DocumentRecoverySnapshot { id: metadata.id, document_path, source, saved_at_millis: metadata.saved_at_millis,
        kind: Some(metadata.kind), label: metadata.label, restored_from_id: metadata.restored_from_id, original_saved_at_millis: metadata.original_saved_at_millis,
        source_hash: Some(metadata.source_hash), bytes: Some(metadata.bytes) })
}

pub fn create_saved_version(raw_root: &str, relative: &str, content: &str, preserve_recovery_id: Option<&str>, options: &RecoveryEventOptions) -> Result<DocumentRecoverySnapshot, HostError> {
    create_saved_version_with_fault(raw_root, relative, content, preserve_recovery_id, options, false)
}

fn create_saved_version_with_fault(raw_root: &str, relative: &str, content: &str, preserve_recovery_id: Option<&str>, options: &RecoveryEventOptions, fail_before_publish: bool) -> Result<DocumentRecoverySnapshot, HostError> {
    if !options_valid(options) { return Err(HostError::InvalidProject("A saved version needs a supported kind, a name of at most 160 characters, and valid origin metadata.".into())); }
    if content.len() as u64 > MAX_RECOVERY_SOURCE_BYTES { return Err(HostError::UnsupportedFile("This saved version exceeds the 5 MiB manuscript limit; the current manuscript was not changed.".into())); }
    let (root, document_path, archive) = paths(raw_root, relative)?;
    if !contained_path(&root, &document_path)?.is_file() { return Err(HostError::NotFound("The active manuscript is no longer present in this project; keep or export the current editor copy before saving a version.".into())); }
    let _guard = project_guard(&root)?;
    let existing = list_saved_versions(raw_root, &document_path)?;
    if existing.len() >= MAX_SAVED_VERSIONS { return Err(HostError::UnsupportedFile("This document already has 1,000 saved versions. No version was deleted. Export or organize its archive before adding another.".into())); }
    if let Some(id) = preserve_recovery_id {
        let known_saved = existing.iter().any(|entry| entry.id == id);
        let known_auto = !known_saved && crate::list_document_recoveries_impl(raw_root, &document_path)?.iter().any(|entry| entry.id == id);
        if !known_saved && !known_auto { return Err(HostError::Conflict("The selected original version does not belong to this manuscript's readable history; no manuscript was changed.".into())); }
        if known_saved { read_saved_version(raw_root, &document_path, id)?; }
    }
    let timestamp = now_millis().max(existing.iter().map(|version| version.saved_at_millis).max().unwrap_or(0).saturating_add(1));
    if timestamp > MAX_DATE_MILLIS { return Err(HostError::UnsupportedFile("The saved-version timestamp exceeds its supported range; earlier versions were preserved.".into())); }
    let directory = archive.join(format!("{timestamp}-{}", Uuid::new_v4()));
    let id = slash_path(directory.strip_prefix(&root).map_err(|_| HostError::InvalidPath("The saved version escaped its project.".into()))?);
    let title = content.lines().find_map(|line| line.strip_prefix("# ")).map(|title| title.chars().filter(|character| !character.is_control()).take(160).collect::<String>()).filter(|title| !title.is_empty());
    let metadata = SavedDocumentVersionMetadata { id: id.clone(), document_path: document_path.clone(), saved_at_millis: timestamp, kind: options.kind.clone(), title,
        label: options.label.clone(), restored_from_id: options.restored_from_id.clone(), original_saved_at_millis: options.original_saved_at_millis,
        source_hash: digest(content.as_bytes()), bytes: content.len() as u64 };
    let bytes = serde_json::to_vec(&SavedEvent { schema_version: 1, metadata }).map_err(|error| HostError::Io(error.to_string()))?;
    if bytes.len() as u64 > MAX_METADATA_BYTES { return Err(HostError::UnsupportedFile("The saved-version metadata exceeds its size limit; earlier versions were preserved.".into())); }
    fs::create_dir_all(&archive)?;
    fs::create_dir(&directory)?;
    write_atomic(&directory.join("source.md"), content.as_bytes(), false)?;
    if fail_before_publish { return Err(HostError::Io("Injected failure before publishing the saved-version metadata; older versions and the active manuscript were preserved.".into())); }
    write_atomic(&directory.join("event.json"), &bytes, false)?;
    // Return success only after reading the committed metadata and exact source fingerprint back.
    read_saved_version(raw_root, &document_path, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn options(kind: &str, label: &str) -> RecoveryEventOptions {
        RecoveryEventOptions { kind: kind.into(), label: Some(label.into()), restored_from_id: None, original_saved_at_millis: None }
    }
    fn project() -> tempfile::TempDir {
        let root = tempdir().unwrap();
        fs::write(root.path().join("paper.md"), b"# Current saved manuscript\n").unwrap();
        fs::write(root.path().join("README.md"), b"# Readme\n").unwrap();
        root
    }

    #[test]
    fn archive_listing_is_metadata_only_and_missing_history_does_not_create_files() {
        let temporary = project();
        let root = temporary.path();
        assert!(list_saved_versions(root.to_str().unwrap(), "paper.md").unwrap().is_empty());
        assert!(!root.join(".draftmatter").exists());
        let saved = create_saved_version(root.to_str().unwrap(), "paper.md", "# Saved paper\r\n\r\nRésumé αβ.\r\n", None, &options("manual", "Before submission")).unwrap();
        let first = list_saved_versions(root.to_str().unwrap(), "paper.md").unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].id, saved.id);
        assert_eq!(first[0].label.as_deref(), Some("Before submission"));
        assert!(!serde_json::to_string(&first).unwrap().contains("Résumé"));
        fs::write(root.join(&saved.id).join("source.md"), b"Corrupt source").unwrap();
        assert_eq!(list_saved_versions(root.to_str().unwrap(), "paper.md").unwrap(), first, "Listing must not load complete manuscript files");
        assert!(matches!(read_saved_version(root.to_str().unwrap(), "paper.md", &saved.id), Err(HostError::Conflict(_))));
        assert_eq!(fs::read(root.join(&saved.id).join("source.md")).unwrap(), b"Corrupt source");
        assert_eq!(fs::read(root.join("paper.md")).unwrap(), b"# Current saved manuscript\n");
    }

    #[test]
    fn identical_manual_savepoints_are_distinct_immutable_events_and_survive_autosave_rotation() {
        let temporary = project();
        let root = temporary.path();
        let source = "---\r\ntitle: Archive\r\n---\r\n\r\n# Archive\r\n\r\nExact αβ source.\r\n";
        let mut saved = Vec::new();
        for index in 0..12 { saved.push(create_saved_version(root.to_str().unwrap(), "paper.md", source, None, &options("manual", &format!("Save {index}"))).unwrap()); }
        assert!(saved.windows(2).all(|pair| pair[0].saved_at_millis < pair[1].saved_at_millis));
        let original_metadata = saved.iter().map(|saved| fs::read(root.join(&saved.id).join("event.json")).unwrap()).collect::<Vec<_>>();
        for index in 0..20 { crate::create_recovery(root, "paper.md", format!("# Rolling {index}\n").as_bytes()).unwrap(); }
        let listed = list_saved_versions(root.to_str().unwrap(), "paper.md").unwrap();
        assert_eq!(listed.len(), 12);
        assert_eq!(listed.iter().map(|entry| &entry.id).collect::<std::collections::HashSet<_>>().len(), 12);
        for (index, saved) in saved.iter().enumerate() {
            assert_eq!(read_saved_version(root.to_str().unwrap(), "paper.md", &saved.id).unwrap(), *saved);
            assert_eq!(saved.source, source);
            assert_eq!(fs::read(root.join(&saved.id).join("event.json")).unwrap(), original_metadata[index]);
        }
        assert_eq!(crate::list_document_recoveries_impl(root.to_str().unwrap(), "paper.md").unwrap().len(), 20);
    }

    #[test]
    fn origin_and_restored_events_keep_the_original_identity_time_and_exact_source() {
        let temporary = project();
        let root = temporary.path();
        let original = create_saved_version(root.to_str().unwrap(), "paper.md", "# Original\n", None, &options("manual", "Original save")).unwrap();
        let mut origin_options = options("origin", "Original version");
        origin_options.restored_from_id = Some(format!("disk:{}", original.id));
        origin_options.original_saved_at_millis = Some(1234);
        let origin = create_saved_version(root.to_str().unwrap(), "paper.md", &original.source, Some(&original.id), &origin_options).unwrap();
        let safety = create_saved_version(root.to_str().unwrap(), "paper.md", "# Current editor\n", Some(&original.id), &options("before-restore", "Before restoring")).unwrap();
        let mut restored_options = options("restored", "Restored copy");
        restored_options.restored_from_id = Some(format!("disk:{}", original.id));
        let restored = create_saved_version(root.to_str().unwrap(), "paper.md", &original.source, Some(&original.id), &restored_options).unwrap();
        assert_eq!(list_saved_versions(root.to_str().unwrap(), "paper.md").unwrap().len(), 4);
        assert_ne!(original.id, restored.id);
        assert_ne!(original.id, origin.id);
        assert_eq!(origin.original_saved_at_millis, Some(1234));
        assert_eq!(origin.restored_from_id, origin_options.restored_from_id);
        assert_eq!(read_saved_version(root.to_str().unwrap(), "paper.md", &original.id).unwrap(), original);
        assert_eq!(read_saved_version(root.to_str().unwrap(), "paper.md", &safety.id).unwrap(), safety);
        assert_eq!(read_saved_version(root.to_str().unwrap(), "paper.md", &restored.id).unwrap(), restored);
    }

    #[test]
    fn naming_a_historical_automatic_version_keeps_its_source_time_and_protects_it_from_rotation() {
        let temporary = project();
        let root = fs::canonicalize(temporary.path()).unwrap();
        let original = crate::create_document_recovery_impl(root.to_str().unwrap(), "paper.md", "# Earlier working text\r\n", None).unwrap();
        let mut named = options("manual", "Before changing the hypothesis");
        named.restored_from_id = Some(format!("disk:{}", original.id));
        named.original_saved_at_millis = Some(original.saved_at_millis);
        let tagged = create_saved_version(root.to_str().unwrap(), "paper.md", &original.source, None, &named).unwrap();
        assert_eq!(tagged.source, original.source);
        assert_ne!(tagged.id, original.id);
        let (times, protected) = crate::recovery_archive_retention(&root, "paper.md").unwrap();
        assert_eq!(times, vec![original.saved_at_millis]);
        assert!(protected.contains(&original.id));
        for index in 0..120 { crate::create_recovery(&root, "paper.md", format!("# Later edit {index}\n").as_bytes()).unwrap(); }
        let automatic = crate::list_document_recoveries_impl(root.to_str().unwrap(), "paper.md").unwrap();
        assert!(automatic.iter().any(|entry| entry.id == original.id && entry.source == original.source));
        assert_eq!(automatic.len(), crate::MAX_RECOVERY_FILES + 1, "The tagged original is outside the automatic budget");
        assert_eq!(read_saved_version(root.to_str().unwrap(), "paper.md", &tagged.id).unwrap(), tagged);
        assert_eq!(fs::read(root.join("paper.md")).unwrap(), b"# Current saved manuscript\n");
    }

    #[test]
    fn invalid_saved_metadata_prevents_automatic_pruning_without_changing_prior_files() {
        let temporary = project();
        let root = fs::canonicalize(temporary.path()).unwrap();
        for index in 0..crate::MAX_RECOVERY_FILES { crate::create_recovery(&root, "paper.md", format!("# Automatic edit {index}\n").as_bytes()).unwrap(); }
        let saved = create_saved_version(root.to_str().unwrap(), "paper.md", "# Manual\n", None, &options("manual", "Manual")).unwrap();
        fs::write(root.join(&saved.id).join("event.json"), b"{invalid archive metadata").unwrap();
        let before = crate::list_document_recoveries_impl(root.to_str().unwrap(), "paper.md").unwrap();
        assert!(matches!(crate::create_recovery(&root, "paper.md", b"# Must not prune old text\n"), Err(HostError::InvalidProject(_))));
        assert_eq!(crate::list_document_recoveries_impl(root.to_str().unwrap(), "paper.md").unwrap(), before);
        assert!(before.iter().all(|entry| root.join(&entry.id).is_file()));
        assert_eq!(fs::read(root.join("paper.md")).unwrap(), b"# Current saved manuscript\n");
    }

    #[test]
    fn partial_publication_failure_preserves_every_existing_version_and_active_file() {
        let temporary = project();
        let root = temporary.path();
        let previous = create_saved_version(root.to_str().unwrap(), "paper.md", "# Previous\n", None, &options("manual", "Previous")).unwrap();
        let before = fs::read(root.join(&previous.id).join("event.json")).unwrap();
        assert!(matches!(create_saved_version_with_fault(root.to_str().unwrap(), "paper.md", "# New editor copy\n", None, &options("manual", "Interrupted"), true), Err(HostError::Io(_))));
        assert_eq!(list_saved_versions(root.to_str().unwrap(), "paper.md").unwrap().len(), 1);
        assert_eq!(read_saved_version(root.to_str().unwrap(), "paper.md", &previous.id).unwrap(), previous);
        assert_eq!(fs::read(root.join(&previous.id).join("event.json")).unwrap(), before);
        assert_eq!(fs::read(root.join("paper.md")).unwrap(), b"# Current saved manuscript\n");
    }

    #[test]
    fn capacity_failure_keeps_all_one_thousand_saved_versions_accessible() {
        let temporary = project();
        let canonical = fs::canonicalize(temporary.path()).unwrap();
        let root = canonical.as_path();
        let (_, document_path, archive) = paths(root.to_str().unwrap(), "paper.md").unwrap();
        fs::create_dir_all(&archive).unwrap();
        let content = b"# Preserved\n";
        for index in 1..=MAX_SAVED_VERSIONS {
            let directory = archive.join(format!("{index}-{}", Uuid::new_v4()));
            fs::create_dir(&directory).unwrap();
            let metadata = SavedDocumentVersionMetadata { id: slash_path(directory.strip_prefix(root).unwrap()), document_path: document_path.clone(), saved_at_millis: index as u64,
                kind: "manual".into(), title: None, label: Some(format!("Save {index}")), restored_from_id: None, original_saved_at_millis: None, source_hash: digest(content), bytes: content.len() as u64 };
            fs::write(directory.join("source.md"), content).unwrap();
            fs::write(directory.join("event.json"), serde_json::to_vec(&SavedEvent { schema_version: 1, metadata }).unwrap()).unwrap();
        }
        let before = list_saved_versions(root.to_str().unwrap(), "paper.md").unwrap();
        assert_eq!(before.len(), MAX_SAVED_VERSIONS);
        assert!(matches!(create_saved_version(root.to_str().unwrap(), "paper.md", "# Cannot fit\n", None, &options("manual", "At capacity")), Err(HostError::UnsupportedFile(message)) if message.contains("No version was deleted")));
        assert_eq!(list_saved_versions(root.to_str().unwrap(), "paper.md").unwrap(), before);
        assert_eq!(read_saved_version(root.to_str().unwrap(), "paper.md", &before.last().unwrap().id).unwrap().source, "# Preserved\n");
        assert_eq!(fs::read(root.join("paper.md")).unwrap(), b"# Current saved manuscript\n");
    }

    #[test]
    fn archive_read_and_restore_protection_refuse_other_documents_and_projects() {
        let first = project();
        let second = project();
        let saved = create_saved_version(first.path().to_str().unwrap(), "README.md", "# Readme version\n", None, &options("manual", "Readme")).unwrap();
        assert!(matches!(read_saved_version(first.path().to_str().unwrap(), "paper.md", &saved.id), Err(HostError::InvalidPath(_))));
        assert!(matches!(read_saved_version(second.path().to_str().unwrap(), "README.md", &saved.id), Err(HostError::NotFound(_))));
        assert!(matches!(create_saved_version(first.path().to_str().unwrap(), "paper.md", "# Current editor\n", Some(&saved.id), &options("before-restore", "Wrong document")), Err(HostError::Conflict(_))));
        assert!(list_saved_versions(first.path().to_str().unwrap(), "paper.md").unwrap().is_empty());
    }

    #[test]
    fn invalid_options_fail_before_publishing_a_version() {
        let temporary = project();
        let root = temporary.path();
        for invalid in [options("unknown", "Invalid kind"), options("manual", "line\nbreak"), options("manual", &"x".repeat(161)), RecoveryEventOptions { original_saved_at_millis: Some(MAX_DATE_MILLIS + 1), ..options("origin", "Invalid date") }] {
            assert!(matches!(create_saved_version(root.to_str().unwrap(), "paper.md", "# Unpublished\n", None, &invalid), Err(HostError::InvalidProject(_))));
        }
        assert!(!root.join(".draftmatter").exists());
    }

    #[cfg(unix)]
    #[test]
    fn saved_version_reads_never_follow_symlinked_sources_or_archive_directories() {
        use std::os::unix::fs::symlink;
        let temporary = project();
        let outside = tempdir().unwrap();
        let root = temporary.path();
        let saved = create_saved_version(root.to_str().unwrap(), "paper.md", "# Secret\n", None, &options("manual", "Saved")).unwrap();
        let source_path = root.join(&saved.id).join("source.md");
        fs::write(outside.path().join("private.md"), b"# Secret\n").unwrap();
        fs::remove_file(&source_path).unwrap();
        symlink(outside.path().join("private.md"), &source_path).unwrap();
        assert!(read_saved_version(root.to_str().unwrap(), "paper.md", &saved.id).is_err());
        assert_eq!(fs::read(outside.path().join("private.md")).unwrap(), b"# Secret\n");
        let empty = project();
        let (_, _, archive) = paths(empty.path().to_str().unwrap(), "paper.md").unwrap();
        fs::create_dir_all(archive.parent().unwrap()).unwrap();
        symlink(outside.path(), &archive).unwrap();
        assert!(matches!(list_saved_versions(empty.path().to_str().unwrap(), "paper.md"), Err(HostError::InvalidPath(_))));
    }
}

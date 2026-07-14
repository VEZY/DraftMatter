use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fmt::{Display, Formatter};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const PROJECT_SCHEMA: u32 = 1;
const MAX_RECOVERY_FILES: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    pub schema_version: u32,
    pub name: String,
    pub main_document: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    pub path: String,
    pub kind: ProjectEntryKind,
    pub bytes: u64,
    pub modified_ms: u64,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProjectEntryKind {
    Manuscript,
    Bibliography,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub root: String,
    pub config: ProjectConfig,
    pub documents: Vec<ProjectEntry>,
    pub bibliographies: Vec<ProjectEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    pub path: String,
    pub content: String,
    pub hash: String,
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveDocumentRequest {
    pub root: String,
    pub path: String,
    pub content: String,
    pub expected_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveDocumentResult {
    pub path: String,
    pub hash: String,
    pub bytes: u64,
    pub recovery_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum HostError {
    InvalidPath(String),
    NotFound(String),
    UnsupportedFile(String),
    Conflict(String),
    Io(String),
    InvalidProject(String),
}

impl Display for HostError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPath(message)
            | Self::NotFound(message)
            | Self::UnsupportedFile(message)
            | Self::Conflict(message)
            | Self::Io(message)
            | Self::InvalidProject(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for HostError {}

impl From<std::io::Error> for HostError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn source_hash(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a:{hash:016x}")
}

fn safe_relative(raw: &str) -> Result<PathBuf, HostError> {
    let path = Path::new(raw);
    if raw.is_empty() || path.is_absolute() {
        return Err(HostError::InvalidPath(format!(
            "Expected a relative project path, received {raw:?}."
        )));
    }
    let mut safe = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => safe.push(part),
            _ => {
                return Err(HostError::InvalidPath(format!(
                    "Project paths cannot contain traversal or platform prefixes: {raw:?}."
                )))
            }
        }
    }
    Ok(safe)
}

fn canonical_root(raw: &str) -> Result<PathBuf, HostError> {
    let root = fs::canonicalize(raw)
        .map_err(|_| HostError::NotFound(format!("The project folder does not exist: {raw}")))?;
    if !root.is_dir() {
        return Err(HostError::InvalidProject(format!(
            "The project root is not a folder: {}",
            root.display()
        )));
    }
    Ok(root)
}

fn contained_path(root: &Path, relative: &str) -> Result<PathBuf, HostError> {
    Ok(root.join(safe_relative(relative)?))
}

fn slash_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
}

fn read_entry(root: &Path, path: &Path, kind: ProjectEntryKind) -> Result<ProjectEntry, HostError> {
    let metadata = fs::metadata(path)?;
    let mut file = File::open(path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let relative = path.strip_prefix(root).map_err(|error| {
        HostError::InvalidPath(format!("Could not make a project-relative path: {error}"))
    })?;
    Ok(ProjectEntry {
        path: slash_path(relative),
        kind,
        bytes: metadata.len(),
        modified_ms: modified_ms(&metadata),
        hash: source_hash(&bytes),
    })
}

fn discover_entries(
    root: &Path,
    directory: &Path,
    depth: usize,
    documents: &mut Vec<ProjectEntry>,
    bibliographies: &mut Vec<ProjectEntry>,
) -> Result<(), HostError> {
    if depth > 6 {
        return Ok(());
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        if path.is_dir() {
            if name != OsStr::new(".git") && name != OsStr::new(".draftmatter") {
                discover_entries(root, &path, depth + 1, documents, bibliographies)?;
            }
            continue;
        }
        let extension = path
            .extension()
            .and_then(OsStr::to_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        match extension.as_str() {
            "md" | "qmd" => documents.push(read_entry(root, &path, ProjectEntryKind::Manuscript)?),
            "bib" | "bibtex" | "json" => {
                bibliographies.push(read_entry(root, &path, ProjectEntryKind::Bibliography)?)
            }
            _ => {}
        }
    }
    Ok(())
}

fn default_config(root: &Path, documents: &[ProjectEntry]) -> ProjectConfig {
    let name = root
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("Research project")
        .replace(['-', '_'], " ");
    ProjectConfig {
        schema_version: PROJECT_SCHEMA,
        name,
        main_document: documents
            .first()
            .map(|entry| entry.path.clone())
            .unwrap_or_else(|| "paper.qmd".to_string()),
    }
}

fn config_path(root: &Path) -> PathBuf {
    root.join(".draftmatter").join("project.json")
}

fn load_config(root: &Path, documents: &[ProjectEntry]) -> Result<ProjectConfig, HostError> {
    let path = config_path(root);
    if !path.exists() {
        return Ok(default_config(root, documents));
    }
    let source = fs::read_to_string(&path)?;
    let config: ProjectConfig = serde_json::from_str(&source).map_err(|error| {
        HostError::InvalidProject(format!("Invalid {}: {error}", path.display()))
    })?;
    if config.schema_version != PROJECT_SCHEMA {
        return Err(HostError::InvalidProject(format!(
            "Unsupported project schema {} in {}.",
            config.schema_version,
            path.display()
        )));
    }
    Ok(config)
}

fn persist_config(root: &Path, config: &ProjectConfig) -> Result<(), HostError> {
    let path = config_path(root);
    let content = serde_json::to_vec_pretty(config)
        .map_err(|error| HostError::InvalidProject(error.to_string()))?;
    write_atomic(&path, &content, false)
}

fn open_project_impl(raw_root: &str) -> Result<ProjectSnapshot, HostError> {
    let root = canonical_root(raw_root)?;
    let mut documents = Vec::new();
    let mut bibliographies = Vec::new();
    discover_entries(&root, &root, 0, &mut documents, &mut bibliographies)?;
    documents.sort_by(|left, right| left.path.cmp(&right.path));
    bibliographies.sort_by(|left, right| left.path.cmp(&right.path));
    let config = load_config(&root, &documents)?;
    Ok(ProjectSnapshot {
        root: root.to_string_lossy().into_owned(),
        config,
        documents,
        bibliographies,
    })
}

fn manuscript_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(OsStr::to_str)
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "md" | "qmd"
    )
}

fn read_document_impl(raw_root: &str, relative: &str) -> Result<DocumentSnapshot, HostError> {
    let root = canonical_root(raw_root)?;
    let path = contained_path(&root, relative)?;
    if !manuscript_extension(&path) {
        return Err(HostError::UnsupportedFile(format!(
            "Only .md and .qmd manuscripts can be read: {relative}"
        )));
    }
    let content = fs::read_to_string(&path)
        .map_err(|_| HostError::NotFound(format!("The manuscript was not found: {relative}")))?;
    let metadata = fs::metadata(&path)?;
    Ok(DocumentSnapshot {
        path: relative.to_string(),
        hash: source_hash(content.as_bytes()),
        content,
        modified_ms: modified_ms(&metadata),
    })
}

fn temporary_path(path: &Path) -> Result<PathBuf, HostError> {
    let parent = path.parent().ok_or_else(|| {
        HostError::InvalidPath(format!(
            "Cannot write a file without a parent: {}",
            path.display()
        ))
    })?;
    let filename = path
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("document");
    Ok(parent.join(format!(
        ".{filename}.draftmatter-tmp-{}-{}",
        std::process::id(),
        now_millis()
    )))
}

fn replace_file(temp: &Path, destination: &Path) -> Result<(), HostError> {
    #[cfg(not(target_os = "windows"))]
    {
        fs::rename(temp, destination)?;
    }
    #[cfg(target_os = "windows")]
    {
        let fallback = destination.with_extension("draftmatter-old");
        if destination.exists() {
            if fallback.exists() {
                fs::remove_file(&fallback)?;
            }
            fs::rename(destination, &fallback)?;
        }
        if let Err(error) = fs::rename(temp, destination) {
            if fallback.exists() {
                let _ = fs::rename(&fallback, destination);
            }
            return Err(error.into());
        }
        if fallback.exists() {
            fs::remove_file(fallback)?;
        }
    }
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8], fail_before_replace: bool) -> Result<(), HostError> {
    let parent = path.parent().ok_or_else(|| {
        HostError::InvalidPath(format!(
            "Cannot write a file without a parent: {}",
            path.display()
        ))
    })?;
    fs::create_dir_all(parent)?;
    let temp = temporary_path(path)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        if fail_before_replace {
            return Err(HostError::Io(
                "Injected failure before atomic replace.".to_string(),
            ));
        }
        replace_file(&temp, path)?;
        #[cfg(unix)]
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() && temp.exists() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn recovery_filename(relative: &str, hash: &str) -> String {
    let safe = relative.replace(['/', '\\'], "__");
    format!(
        "{}-{}-{}.bak",
        now_millis(),
        hash.trim_start_matches("fnv1a:"),
        safe
    )
}

fn create_recovery(root: &Path, relative: &str, previous: &[u8]) -> Result<String, HostError> {
    let directory = root.join(".draftmatter").join("recovery");
    fs::create_dir_all(&directory)?;
    let filename = recovery_filename(relative, &source_hash(previous));
    let path = directory.join(filename);
    write_atomic(&path, previous, false)?;

    let suffix = relative.replace(['/', '\\'], "__");
    let mut matching = fs::read_dir(&directory)?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .ends_with(&format!("-{suffix}.bak"))
        })
        .collect::<Vec<_>>();
    matching.sort_by_key(|entry| std::cmp::Reverse(entry.file_name()));
    for old in matching.into_iter().skip(MAX_RECOVERY_FILES) {
        let _ = fs::remove_file(old.path());
    }
    Ok(path
        .strip_prefix(root)
        .map(slash_path)
        .unwrap_or_else(|_| path.to_string_lossy().into_owned()))
}

fn save_document_impl(request: SaveDocumentRequest) -> Result<SaveDocumentResult, HostError> {
    let root = canonical_root(&request.root)?;
    let path = contained_path(&root, &request.path)?;
    if !manuscript_extension(&path) {
        return Err(HostError::UnsupportedFile(format!(
            "Only .md and .qmd manuscripts can be saved: {}",
            request.path
        )));
    }

    let previous = if path.exists() {
        fs::read(&path)?
    } else {
        Vec::new()
    };
    if let Some(expected) = request.expected_hash.as_deref() {
        let actual = source_hash(&previous);
        if actual != expected {
            return Err(HostError::Conflict(format!(
                "{} changed outside DraftMatter (expected {expected}, found {actual}).",
                request.path
            )));
        }
    }

    let recovery_path = if previous.is_empty() {
        None
    } else {
        Some(create_recovery(&root, &request.path, &previous)?)
    };
    write_atomic(&path, request.content.as_bytes(), false)?;
    Ok(SaveDocumentResult {
        path: request.path,
        hash: source_hash(request.content.as_bytes()),
        bytes: request.content.len() as u64,
        recovery_path,
    })
}

#[tauri::command]
fn open_project(root: String) -> Result<ProjectSnapshot, HostError> {
    open_project_impl(&root)
}

#[tauri::command]
fn create_project(root: String, name: String) -> Result<ProjectSnapshot, HostError> {
    let root_path = PathBuf::from(&root);
    fs::create_dir_all(&root_path)?;
    let canonical = canonical_root(&root)?;
    let main_document = "paper.qmd".to_string();
    let config = ProjectConfig {
        schema_version: PROJECT_SCHEMA,
        name,
        main_document: main_document.clone(),
    };
    persist_config(&canonical, &config)?;
    let document = canonical.join(&main_document);
    if !document.exists() {
        let title = config.name.replace('"', "\\\"");
        let source = format!(
            "---\ntitle: \"{title}\"\nformat: html\n---\n\n## Abstract\n\n\n\n## Introduction\n\n\n\n## Methods\n\n\n\n## Results\n\n\n\n## Conclusion\n"
        );
        write_atomic(&document, source.as_bytes(), false)?;
    }
    open_project_impl(&root)
}

#[tauri::command]
fn read_document(root: String, path: String) -> Result<DocumentSnapshot, HostError> {
    read_document_impl(&root, &path)
}

#[tauri::command]
fn save_document(request: SaveDocumentRequest) -> Result<SaveDocumentResult, HostError> {
    save_document_impl(request)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_project,
            create_project,
            read_document,
            save_document
        ])
        .run(tauri::generate_context!())
        .expect("error while running DraftMatter");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_paths_outside_the_project() {
        assert!(matches!(
            safe_relative("../paper.qmd"),
            Err(HostError::InvalidPath(_))
        ));
        assert!(matches!(
            safe_relative("/tmp/paper.qmd"),
            Err(HostError::InvalidPath(_))
        ));
        assert_eq!(
            safe_relative("chapters/paper.qmd").unwrap(),
            PathBuf::from("chapters/paper.qmd")
        );
    }

    #[test]
    fn creates_and_discovers_a_project_without_running_content() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join("canopy-study");
        let snapshot =
            create_project(root.to_string_lossy().into_owned(), "Canopy study".into()).unwrap();
        assert_eq!(snapshot.config.main_document, "paper.qmd");
        assert_eq!(snapshot.documents.len(), 1);
        assert_eq!(snapshot.documents[0].path, "paper.qmd");
        assert!(root.join(".draftmatter/project.json").is_file());
    }

    #[test]
    fn saves_with_expected_hash_and_preserves_a_recovery() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join("project");
        create_project(root.to_string_lossy().into_owned(), "Test".into()).unwrap();
        let before = read_document_impl(root.to_str().unwrap(), "paper.qmd").unwrap();
        let result = save_document_impl(SaveDocumentRequest {
            root: root.to_string_lossy().into_owned(),
            path: "paper.qmd".into(),
            content: "# Updated\n".into(),
            expected_hash: Some(before.hash),
        })
        .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("paper.qmd")).unwrap(),
            "# Updated\n"
        );
        assert!(result.recovery_path.is_some());
        assert!(root.join(result.recovery_path.unwrap()).is_file());
    }

    #[test]
    fn rejects_a_save_after_an_external_change() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join("project");
        create_project(root.to_string_lossy().into_owned(), "Test".into()).unwrap();
        let before = read_document_impl(root.to_str().unwrap(), "paper.qmd").unwrap();
        fs::write(root.join("paper.qmd"), "external edit").unwrap();
        let error = save_document_impl(SaveDocumentRequest {
            root: root.to_string_lossy().into_owned(),
            path: "paper.qmd".into(),
            content: "editor edit".into(),
            expected_hash: Some(before.hash),
        })
        .unwrap_err();
        assert!(matches!(error, HostError::Conflict(_)));
        assert_eq!(
            fs::read_to_string(root.join("paper.qmd")).unwrap(),
            "external edit"
        );
    }

    #[test]
    fn interrupted_atomic_write_keeps_the_previous_document() {
        let temporary = tempdir().unwrap();
        let path = temporary.path().join("paper.qmd");
        fs::write(&path, "valid old source").unwrap();
        let error = write_atomic(&path, b"partial new source", true).unwrap_err();
        assert!(matches!(error, HostError::Io(_)));
        assert_eq!(fs::read_to_string(&path).unwrap(), "valid old source");
        assert_eq!(fs::read_dir(temporary.path()).unwrap().count(), 1);
    }
}

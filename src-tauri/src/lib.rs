use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fmt::{Display, Formatter};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

const PROJECT_SCHEMA: u32 = 1;
const MAX_RECOVERY_FILES: usize = 8;
const MAX_BIBLIOGRAPHY_BYTES: u64 = 10 * 1024 * 1024;
const MAX_ZOTERO_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
const ZOTERO_PORT: u16 = 23119;

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
#[serde(rename_all = "camelCase")]
pub struct ZoteroStatus {
    pub available: bool,
    pub zotero_version: Option<String>,
    pub api_version: Option<String>,
    pub schema_version: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroCreator {
    pub creator_type: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroItem {
    pub item_key: String,
    pub version: u64,
    pub item_type: String,
    pub title: String,
    pub creators: Vec<ZoteroCreator>,
    pub date: Option<String>,
    pub publication_title: Option<String>,
    pub doi: Option<String>,
    pub url: Option<String>,
    pub extra: Option<String>,
    pub citation_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroSearchResult {
    pub items: Vec<ZoteroItem>,
    pub library_version: Option<String>,
    pub api_version: Option<String>,
    pub schema_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DocumentStatus {
    Current {
        hash: String,
        modified_ms: u64,
    },
    Modified {
        hash: String,
        modified_ms: u64,
    },
    Renamed {
        path: String,
        hash: String,
        modified_ms: u64,
    },
    Deleted,
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
    Integration(String),
}

impl Display for HostError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPath(message)
            | Self::NotFound(message)
            | Self::UnsupportedFile(message)
            | Self::Conflict(message)
            | Self::Io(message)
            | Self::InvalidProject(message)
            | Self::Integration(message) => formatter.write_str(message),
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

fn bibliography_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(OsStr::to_str)
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "bib" | "bibtex" | "json"
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

fn read_bibliography_impl(raw_root: &str, relative: &str) -> Result<DocumentSnapshot, HostError> {
    let root = canonical_root(raw_root)?;
    let path = contained_path(&root, relative)?;
    if !bibliography_extension(&path) {
        return Err(HostError::UnsupportedFile(format!(
            "Only .bib, .bibtex, and .json bibliography files can be read: {relative}"
        )));
    }
    let metadata = fs::metadata(&path)
        .map_err(|_| HostError::NotFound(format!("The bibliography was not found: {relative}")))?;
    if metadata.len() > MAX_BIBLIOGRAPHY_BYTES {
        return Err(HostError::UnsupportedFile(format!(
            "The bibliography exceeds the 10 MB project limit: {relative}"
        )));
    }
    let content = fs::read_to_string(&path).map_err(|error| {
        HostError::UnsupportedFile(format!(
            "The bibliography must be valid UTF-8 text ({relative}): {error}"
        ))
    })?;
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
    save_document_impl_with_fault(request, false)
}

fn save_document_impl_with_fault(
    request: SaveDocumentRequest,
    fail_before_replace: bool,
) -> Result<SaveDocumentResult, HostError> {
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
    write_atomic(&path, request.content.as_bytes(), fail_before_replace)?;
    Ok(SaveDocumentResult {
        path: request.path,
        hash: source_hash(request.content.as_bytes()),
        bytes: request.content.len() as u64,
        recovery_path,
    })
}

fn document_status_impl(
    raw_root: &str,
    relative: &str,
    expected_hash: &str,
) -> Result<DocumentStatus, HostError> {
    let root = canonical_root(raw_root)?;
    let path = contained_path(&root, relative)?;
    if path.exists() {
        let document = read_document_impl(raw_root, relative)?;
        return if document.hash == expected_hash {
            Ok(DocumentStatus::Current {
                hash: document.hash,
                modified_ms: document.modified_ms,
            })
        } else {
            Ok(DocumentStatus::Modified {
                hash: document.hash,
                modified_ms: document.modified_ms,
            })
        };
    }

    let mut documents = Vec::new();
    let mut bibliographies = Vec::new();
    discover_entries(&root, &root, 0, &mut documents, &mut bibliographies)?;
    if let Some(entry) = documents
        .into_iter()
        .find(|entry| entry.hash == expected_hash)
    {
        return Ok(DocumentStatus::Renamed {
            path: entry.path,
            hash: entry.hash,
            modified_ms: entry.modified_ms,
        });
    }
    Ok(DocumentStatus::Deleted)
}

fn set_main_document_impl(raw_root: &str, relative: &str) -> Result<ProjectSnapshot, HostError> {
    let root = canonical_root(raw_root)?;
    let path = contained_path(&root, relative)?;
    if !path.is_file() || !manuscript_extension(&path) {
        return Err(HostError::NotFound(format!(
            "The main manuscript was not found: {relative}"
        )));
    }
    let snapshot = open_project_impl(raw_root)?;
    let mut config = snapshot.config;
    config.main_document = relative.to_string();
    persist_config(&root, &config)?;
    open_project_impl(raw_root)
}

#[derive(Debug)]
struct ZoteroHttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl ZoteroHttpResponse {
    fn header(&self, name: &str) -> Option<String> {
        self.headers
            .iter()
            .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.clone())
    }
}

#[derive(Debug, Deserialize)]
struct RawZoteroItem {
    key: String,
    #[serde(default)]
    version: u64,
    data: RawZoteroData,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawZoteroData {
    #[serde(default)]
    item_type: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    creators: Vec<ZoteroCreator>,
    date: Option<String>,
    publication_title: Option<String>,
    #[serde(rename = "DOI")]
    doi: Option<String>,
    url: Option<String>,
    extra: Option<String>,
    citation_key: Option<String>,
}

fn integration_error(message: impl Into<String>) -> HostError {
    HostError::Integration(message.into())
}

fn decode_chunked(body: &[u8]) -> Result<Vec<u8>, HostError> {
    let mut decoded = Vec::new();
    let mut cursor = 0;
    loop {
        let line_end = body[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .map(|offset| cursor + offset)
            .ok_or_else(|| integration_error("Zotero returned malformed chunked data."))?;
        let size_source = std::str::from_utf8(&body[cursor..line_end])
            .map_err(|_| integration_error("Zotero returned an invalid chunk size."))?;
        let size = usize::from_str_radix(size_source.split(';').next().unwrap_or_default(), 16)
            .map_err(|_| integration_error("Zotero returned an invalid chunk size."))?;
        cursor = line_end + 2;
        if size == 0 {
            break;
        }
        if cursor + size + 2 > body.len() {
            return Err(integration_error(
                "Zotero closed an incomplete chunked response.",
            ));
        }
        decoded.extend_from_slice(&body[cursor..cursor + size]);
        cursor += size;
        if &body[cursor..cursor + 2] != b"\r\n" {
            return Err(integration_error(
                "Zotero returned malformed chunk delimiters.",
            ));
        }
        cursor += 2;
        if decoded.len() as u64 > MAX_ZOTERO_RESPONSE_BYTES {
            return Err(integration_error(
                "Zotero search results exceeded the 4 MB safety limit.",
            ));
        }
    }
    Ok(decoded)
}

fn zotero_request_at(address: SocketAddr, path: &str) -> Result<ZoteroHttpResponse, HostError> {
    if !path.starts_with("/api/") && path != "/api/" {
        return Err(integration_error(
            "Only Zotero's read-only local API routes are allowed.",
        ));
    }
    let mut stream =
        TcpStream::connect_timeout(&address, Duration::from_millis(350)).map_err(|_| {
            integration_error(
                "Zotero local API is unavailable. Open Zotero and enable its local API.",
            )
        })?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(HostError::from)?;
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .map_err(HostError::from)?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAccept: application/json\r\nZotero-API-Version: 3\r\nConnection: close\r\n\r\n",
        address.port()
    );
    stream.write_all(request.as_bytes())?;
    stream.flush()?;

    let mut bytes = Vec::new();
    stream
        .take(MAX_ZOTERO_RESPONSE_BYTES + 64 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_ZOTERO_RESPONSE_BYTES + 64 * 1024 {
        return Err(integration_error(
            "Zotero response exceeded the 4 MB safety limit.",
        ));
    }
    let header_end = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| integration_error("Zotero returned a malformed HTTP response."))?;
    let header_source = std::str::from_utf8(&bytes[..header_end])
        .map_err(|_| integration_error("Zotero returned invalid HTTP headers."))?;
    let mut lines = header_source.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| integration_error("Zotero returned an invalid HTTP status."))?;
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
        .collect::<Vec<_>>();
    let raw_body = &bytes[header_end + 4..];
    let chunked = headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("transfer-encoding")
            && value.to_ascii_lowercase().contains("chunked")
    });
    let body = if chunked {
        decode_chunked(raw_body)?
    } else {
        raw_body.to_vec()
    };
    if body.len() as u64 > MAX_ZOTERO_RESPONSE_BYTES {
        return Err(integration_error(
            "Zotero response exceeded the 4 MB safety limit.",
        ));
    }
    Ok(ZoteroHttpResponse {
        status,
        headers,
        body,
    })
}

fn zotero_address() -> SocketAddr {
    SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, ZOTERO_PORT))
}

fn percent_encode_query(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                char::from(*byte).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

fn zotero_status_impl() -> ZoteroStatus {
    zotero_status_at(zotero_address())
}

fn zotero_status_at(address: SocketAddr) -> ZoteroStatus {
    match zotero_request_at(address, "/api/") {
        Ok(response) if (200..300).contains(&response.status) => {
            let value = serde_json::from_slice::<serde_json::Value>(&response.body).ok();
            ZoteroStatus {
                available: true,
                zotero_version: value
                    .as_ref()
                    .and_then(|candidate| candidate.get("version"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                api_version: response.header("Zotero-API-Version"),
                schema_version: response.header("Zotero-Schema-Version"),
                message: None,
            }
        }
        Ok(response) => ZoteroStatus {
            available: false,
            zotero_version: None,
            api_version: response.header("Zotero-API-Version"),
            schema_version: response.header("Zotero-Schema-Version"),
            message: Some(format!(
                "Zotero local API returned HTTP {}.",
                response.status
            )),
        },
        Err(error) => ZoteroStatus {
            available: false,
            zotero_version: None,
            api_version: None,
            schema_version: None,
            message: Some(error.to_string()),
        },
    }
}

fn zotero_search_impl(query: &str, limit: u8) -> Result<ZoteroSearchResult, HostError> {
    zotero_search_at(zotero_address(), query, limit)
}

fn zotero_search_at(
    address: SocketAddr,
    query: &str,
    limit: u8,
) -> Result<ZoteroSearchResult, HostError> {
    let limit = limit.clamp(1, 50);
    let query = percent_encode_query(query.trim());
    let path = if query.is_empty() {
        format!("/api/users/0/items/top?limit={limit}&sort=dateModified&direction=desc")
    } else {
        format!("/api/users/0/items/top?q={query}&limit={limit}")
    };
    let response = zotero_request_at(address, &path)?;
    if !(200..300).contains(&response.status) {
        return Err(integration_error(format!(
            "Zotero search returned HTTP {}.",
            response.status
        )));
    }
    let raw = serde_json::from_slice::<Vec<RawZoteroItem>>(&response.body).map_err(|error| {
        integration_error(format!("Zotero returned unreadable item data: {error}"))
    })?;
    let items = raw
        .into_iter()
        .filter(|item| {
            !matches!(
                item.data.item_type.as_str(),
                "attachment" | "note" | "annotation"
            )
        })
        .map(|item| ZoteroItem {
            item_key: item.key,
            version: item.version,
            item_type: item.data.item_type,
            title: item.data.title,
            creators: item.data.creators,
            date: item.data.date,
            publication_title: item.data.publication_title,
            doi: item.data.doi,
            url: item.data.url,
            extra: item.data.extra,
            citation_key: item.data.citation_key,
        })
        .collect();
    Ok(ZoteroSearchResult {
        items,
        library_version: response.header("Last-Modified-Version"),
        api_version: response.header("Zotero-API-Version"),
        schema_version: response.header("Zotero-Schema-Version"),
    })
}

#[tauri::command]
fn open_project(root: String) -> Result<ProjectSnapshot, HostError> {
    open_project_impl(&root)
}

#[tauri::command]
fn create_project(root: String, name: String) -> Result<ProjectSnapshot, HostError> {
    let root_path = PathBuf::from(&root);
    if root_path.exists() && fs::read_dir(&root_path)?.next().is_some() {
        return Err(HostError::InvalidProject(format!(
            "Choose an empty folder for a new DraftMatter project: {}",
            root_path.display()
        )));
    }
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
fn read_bibliography(root: String, path: String) -> Result<DocumentSnapshot, HostError> {
    read_bibliography_impl(&root, &path)
}

#[tauri::command]
fn save_document(request: SaveDocumentRequest) -> Result<SaveDocumentResult, HostError> {
    save_document_impl(request)
}

#[tauri::command]
fn document_status(
    root: String,
    path: String,
    expected_hash: String,
) -> Result<DocumentStatus, HostError> {
    document_status_impl(&root, &path, &expected_hash)
}

#[tauri::command]
fn set_main_document(root: String, path: String) -> Result<ProjectSnapshot, HostError> {
    set_main_document_impl(&root, &path)
}

#[tauri::command]
fn zotero_status() -> ZoteroStatus {
    zotero_status_impl()
}

#[tauri::command]
fn zotero_search(query: String, limit: Option<u8>) -> Result<ZoteroSearchResult, HostError> {
    zotero_search_impl(&query, limit.unwrap_or(25))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_project,
            create_project,
            read_document,
            read_bibliography,
            save_document,
            document_status,
            set_main_document,
            zotero_status,
            zotero_search
        ])
        .run(tauri::generate_context!())
        .expect("error while running DraftMatter");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;
    use tempfile::tempdir;

    fn serve_zotero_once(
        body: &'static str,
        headers: &'static str,
    ) -> (SocketAddr, thread::JoinHandle<String>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).unwrap();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{headers}\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&request[..count]).into_owned()
        });
        (address, handle)
    }

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
    fn refuses_to_create_a_project_over_existing_files() {
        let temporary = tempdir().unwrap();
        fs::write(temporary.path().join("notes.txt"), "keep me").unwrap();
        let error = create_project(
            temporary.path().to_string_lossy().into_owned(),
            "Unsafe".into(),
        )
        .unwrap_err();
        assert!(matches!(error, HostError::InvalidProject(_)));
        assert_eq!(
            fs::read_to_string(temporary.path().join("notes.txt")).unwrap(),
            "keep me"
        );
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
    fn reads_only_bibliography_text_inside_the_project() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join("project");
        create_project(root.to_string_lossy().into_owned(), "Test".into()).unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{vezy2024, title={Portable research}}",
        )
        .unwrap();

        let bibliography =
            read_bibliography_impl(root.to_str().unwrap(), "references.bib").unwrap();
        assert!(bibliography.content.contains("vezy2024"));
        assert!(matches!(
            read_bibliography_impl(root.to_str().unwrap(), "paper.qmd"),
            Err(HostError::UnsupportedFile(_))
        ));
        assert!(matches!(
            read_bibliography_impl(root.to_str().unwrap(), "../references.bib"),
            Err(HostError::InvalidPath(_))
        ));
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
    fn reports_external_edits_renames_and_deletions() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join("project");
        create_project(root.to_string_lossy().into_owned(), "Test".into()).unwrap();
        let before = read_document_impl(root.to_str().unwrap(), "paper.qmd").unwrap();

        fs::write(root.join("paper.qmd"), "external edit").unwrap();
        assert!(matches!(
            document_status_impl(root.to_str().unwrap(), "paper.qmd", &before.hash).unwrap(),
            DocumentStatus::Modified { .. }
        ));

        fs::write(root.join("paper.qmd"), &before.content).unwrap();
        fs::rename(root.join("paper.qmd"), root.join("renamed.qmd")).unwrap();
        assert!(matches!(
            document_status_impl(root.to_str().unwrap(), "paper.qmd", &before.hash).unwrap(),
            DocumentStatus::Renamed { path, .. } if path == "renamed.qmd"
        ));
        let updated = set_main_document_impl(root.to_str().unwrap(), "renamed.qmd").unwrap();
        assert_eq!(updated.config.main_document, "renamed.qmd");

        fs::remove_file(root.join("renamed.qmd")).unwrap();
        assert_eq!(
            document_status_impl(root.to_str().unwrap(), "paper.qmd", &before.hash).unwrap(),
            DocumentStatus::Deleted
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

    #[test]
    fn interrupted_save_keeps_the_document_and_a_valid_recovery() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join("project");
        create_project(root.to_string_lossy().into_owned(), "Test".into()).unwrap();
        let before = read_document_impl(root.to_str().unwrap(), "paper.qmd").unwrap();

        let error = save_document_impl_with_fault(
            SaveDocumentRequest {
                root: root.to_string_lossy().into_owned(),
                path: "paper.qmd".into(),
                content: "# New source that must not be partial\n".into(),
                expected_hash: Some(before.hash.clone()),
            },
            true,
        )
        .unwrap_err();

        assert!(matches!(error, HostError::Io(_)));
        assert_eq!(
            fs::read_to_string(root.join("paper.qmd")).unwrap(),
            before.content
        );
        let recovery_directory = root.join(".draftmatter/recovery");
        let recoveries = fs::read_dir(&recovery_directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(recoveries.len(), 1);
        assert_eq!(fs::read_to_string(&recoveries[0]).unwrap(), before.content);
        assert!(!fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .contains("draftmatter-tmp")));
    }

    #[test]
    fn disk_recovery_history_is_bounded_and_every_entry_is_valid() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join("project");
        create_project(root.to_string_lossy().into_owned(), "Test".into()).unwrap();

        for revision in 0..12 {
            let before = read_document_impl(root.to_str().unwrap(), "paper.qmd").unwrap();
            save_document_impl(SaveDocumentRequest {
                root: root.to_string_lossy().into_owned(),
                path: "paper.qmd".into(),
                content: format!("---\ntitle: \"Revision {revision}\"\n---\n"),
                expected_hash: Some(before.hash),
            })
            .unwrap();
        }

        let recovery_directory = root.join(".draftmatter/recovery");
        let recoveries = fs::read_dir(recovery_directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(recoveries.len(), MAX_RECOVERY_FILES);
        for recovery in recoveries {
            let content = fs::read_to_string(recovery).unwrap();
            assert!(!content.is_empty());
            assert!(content.contains("title:"));
        }
    }

    #[test]
    fn probes_zotero_versions_through_the_fixed_read_only_route() {
        let (address, server) = serve_zotero_once(
            r#"{"version":"7.0.15"}"#,
            "Zotero-API-Version: 3\r\nZotero-Schema-Version: 31\r\n",
        );
        let status = zotero_status_at(address);
        let request = server.join().unwrap();

        assert_eq!(
            status,
            ZoteroStatus {
                available: true,
                zotero_version: Some("7.0.15".into()),
                api_version: Some("3".into()),
                schema_version: Some("31".into()),
                message: None,
            }
        );
        assert!(request.starts_with("GET /api/ HTTP/1.1\r\n"));
        assert!(request.contains("Zotero-API-Version: 3"));
    }

    #[test]
    fn searches_zotero_items_and_retains_durable_identity() {
        let body = r#"[
          {"key":"PXW99EKT","version":42,"data":{"itemType":"journalArticle","title":"Canopy responses","creators":[{"creatorType":"author","firstName":"Alice","lastName":"Martin"}],"date":"2025-04-01","publicationTitle":"Plant Methods","DOI":"10.1000/canopy","url":"https://example.org/canopy","extra":"Citation Key: martinCanopy2025","citationKey":"martinCanopy2025"}},
          {"key":"ATTACH01","version":5,"data":{"itemType":"attachment","title":"PDF","creators":[]}}
        ]"#;
        let (address, server) = serve_zotero_once(
            body,
            "Last-Modified-Version: 902\r\nZotero-API-Version: 3\r\nZotero-Schema-Version: 31\r\n",
        );
        let result = zotero_search_at(address, "canopy water", 25).unwrap();
        let request = server.join().unwrap();

        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].item_key, "PXW99EKT");
        assert_eq!(result.items[0].version, 42);
        assert_eq!(
            result.items[0].citation_key.as_deref(),
            Some("martinCanopy2025")
        );
        assert_eq!(result.library_version.as_deref(), Some("902"));
        assert!(request
            .starts_with("GET /api/users/0/items/top?q=canopy%20water&limit=25 HTTP/1.1\r\n"));
        assert!(!request.contains("/connector/"));
    }

    #[test]
    fn degrades_zotero_probe_cleanly_when_the_port_is_closed() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);

        let status = zotero_status_at(address);
        assert!(!status.available);
        assert!(status.message.unwrap().contains("unavailable"));
    }
}

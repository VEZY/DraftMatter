use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fmt::{Display, Formatter};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

mod code_formatting;
mod execution_artifacts;
mod execution_manifests;
mod execution_trust;
mod export_adapter;
mod git_adapter;
mod julia_tools;
mod jupyter_execution;
mod jupyter_publishing;
use code_formatting::{
    format_code_impl, install_code_formatter_with_progress_impl, probe_code_formatter_impl,
    CodeFormatRequest, CodeFormatResult, CodeFormatterRequest, CodeFormatterStatus,
};
use execution_artifacts::{
    fingerprint_execution_inputs_impl, inspect_execution_artifacts_impl,
    ExecutionArtifactFingerprint, ExecutionInput,
};
use execution_manifests::{
    read_execution_manifests_impl, save_execution_manifest_impl, SaveExecutionManifestRequest,
};
mod runtime;
use execution_trust::{
    execution_trust_status_impl, revoke_project_trust_impl, trust_project_for_session_impl,
    ExecutionTrustStatus, ExecutionTrustStore,
};
use export_adapter::{
    external_export_extension, probe_external_export_tools_impl, render_external_export_impl,
    render_external_export_to_path_impl, ExternalExportRequest, ExternalExportResult,
    ExternalExportTools,
};
use git_adapter::{
    git_branches_impl, git_checkpoint_diff_impl, git_create_branch_impl,
    git_create_checkpoint_impl, git_create_commit_impl, git_diff_impl, git_fetch_impl,
    git_history_impl, git_initialize_impl, git_pull_impl, git_push_impl,
    git_restore_checkpoint_impl, git_stage_impl, git_status_impl, git_switch_branch_impl,
    GitBranchRequest, GitBranchStatus, GitCheckpointDiffRequest, GitCheckpointDiffResult,
    GitCheckpointRequest, GitCommitRequest, GitCommitResult, GitDiffRequest, GitDiffResult,
    GitHistoryEntry, GitInitializeResult, GitRemoteRequest, GitRemoteResult, GitRepositoryStatus,
    GitRestoreCheckpointRequest, GitStageRequest,
};
use julia_tools::{
    add_julia_package_with_progress_impl, format_julia_code_impl,
    list_julia_packages_with_progress_impl, remove_julia_package_with_progress_impl,
    JuliaEnvironment, JuliaFormatRequest, JuliaFormatResult, JuliaPackageRequest,
};
use jupyter_execution::{
    execute_kernel_impl, interrupt_kernel_impl, restart_kernel_impl, terminate_kernel_impl,
    KernelExecutionRequest, KernelExecutionResult, KernelProcessRegistry,
};
use runtime::{
    discover_jupyter_kernels_impl, probe_runtime_executable_impl,
    setup_kernel_integration_with_progress_impl, JupyterKernelInventory,
    KernelIntegrationSetupResult, RuntimeExecutableProbe, RuntimeLanguage,
};

pub(crate) type TaskProgressReporter = Arc<dyn Fn(&str, &str) + Send + Sync>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskProgressEvent {
    task_id: String,
    stream: String,
    message: String,
}

fn task_progress_reporter(
    app: tauri::AppHandle,
    task_id: Option<String>,
) -> Option<TaskProgressReporter> {
    task_id.map(|task_id| {
        Arc::new(move |stream: &str, message: &str| {
            let _ = app.emit(
                "draftmatter-task-progress",
                TaskProgressEvent {
                    task_id: task_id.clone(),
                    stream: stream.to_string(),
                    message: message.to_string(),
                },
            );
        }) as TaskProgressReporter
    })
}

fn runtime_name_for_progress(language: RuntimeLanguage) -> &'static str {
    match language {
        RuntimeLanguage::Python => "Python",
        RuntimeLanguage::R => "R",
        RuntimeLanguage::Julia => "Julia",
    }
}

const PROJECT_SCHEMA: u32 = 1;
const MAX_RECOVERY_FILES: usize = 8;
const MAX_BIBLIOGRAPHY_BYTES: u64 = 10 * 1024 * 1024;
const MAX_CITATION_LOCK_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ZOTERO_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_CROSSREF_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_GENERATED_EXPORT_BYTES: usize = 128 * 1024 * 1024;
const MAX_PROJECT_ASSET_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PROJECT_ASSETS_BYTES: u64 = 96 * 1024 * 1024;
const ZOTERO_PORT: u16 = 23119;
const CROSSREF_WORKS_URL: &str = "https://api.crossref.org/works";
const DOI_RESOLVER_URL: &str = "https://doi.org";
const CROSSREF_USER_AGENT: &str = "DraftMatter/0.1 (desktop scholarly search)";
const CROSSREF_MAILTO: Option<&str> = option_env!("DRAFTMATTER_CROSSREF_MAILTO");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    pub schema_version: u32,
    pub name: String,
    pub main_document: String,
    #[serde(default = "default_citation_style")]
    pub citation_style: String,
    #[serde(default = "default_citation_locale")]
    pub citation_locale: String,
    #[serde(default)]
    pub citation_bibliography: Option<String>,
    #[serde(default)]
    pub execution: ProjectExecutionPreferences,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct NewProjectAuthor {
    name: String,
    #[serde(default)]
    orcid: Option<String>,
    #[serde(default)]
    affiliations: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ProjectExecutionLanguagePreferences {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kernel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectExecutionPreferences {
    #[serde(default)]
    pub python: ProjectExecutionLanguagePreferences,
    #[serde(default)]
    pub r: ProjectExecutionLanguagePreferences,
    #[serde(default)]
    pub julia: ProjectExecutionLanguagePreferences,
}

fn default_citation_style() -> String {
    "draftmatter-author-date".to_string()
}

fn default_citation_locale() -> String {
    "en-US".to_string()
}

fn validate_citation_preferences(style: &str, locale: &str) -> Result<(), HostError> {
    if !matches!(style, "draftmatter-author-date" | "draftmatter-numeric") {
        return Err(HostError::InvalidProject(format!(
            "Unsupported citation style: {style}."
        )));
    }
    if !matches!(locale, "en-US" | "fr-FR") {
        return Err(HostError::InvalidProject(format!(
            "Unsupported citation locale: {locale}."
        )));
    }
    Ok(())
}

fn validate_execution_preferences(
    preferences: &ProjectExecutionPreferences,
) -> Result<(), HostError> {
    for kernel in [
        preferences.python.kernel.as_deref(),
        preferences.r.kernel.as_deref(),
        preferences.julia.kernel.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if kernel.is_empty()
            || kernel.len() > 128
            || !kernel
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
        {
            return Err(HostError::InvalidProject(
                "Jupyter kernel names may contain only ASCII letters, numbers, dots, dashes, and underscores."
                    .to_string(),
            ));
        }
    }
    for environment in [
        preferences.python.environment.as_deref(),
        preferences.r.environment.as_deref(),
        preferences.julia.environment.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if environment.is_empty()
            || environment.len() > 1024
            || environment.chars().any(char::is_control)
        {
            return Err(HostError::InvalidProject(
                "Execution environment identifiers must be non-empty text without control characters."
                    .to_string(),
            ));
        }
    }
    Ok(())
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
pub struct ProjectAsset {
    pub path: String,
    pub bytes: Vec<u8>,
    pub media_type: String,
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
pub struct SaveExportFileRequest {
    pub suggested_name: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveExportFileResult {
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveCitationLockRequest {
    pub root: String,
    pub content: String,
    pub expected_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquireCitationsRequest {
    pub root: String,
    pub document_path: String,
    pub document_content: String,
    pub expected_document_hash: String,
    pub bibliography_path: String,
    pub expected_bibliography_hash: Option<String>,
    pub bibliography_records: Vec<serde_json::Value>,
    pub lock_content: String,
    pub expected_lock_hash: Option<String>,
    pub cache_content: String,
    pub expected_cache_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcquireCitationsResult {
    pub document_hash: String,
    pub bibliography_hash: String,
    pub lock_hash: String,
    pub cache_hash: String,
    pub bibliography_path: String,
    pub acquired: usize,
    pub unchanged: usize,
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
#[serde(rename_all = "camelCase")]
pub struct ZoteroAttachment {
    pub item_key: String,
    pub title: String,
    pub filename: Option<String>,
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CrossrefSearchRequest {
    pub doi: Option<String>,
    pub bibliographic: Option<String>,
    pub author: Option<String>,
    pub title: Option<String>,
    pub from_publication_date: Option<String>,
    pub until_publication_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CrossrefAuthor {
    pub family: String,
    pub given: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CrossrefWork {
    pub doi: String,
    pub title: String,
    pub authors: Vec<CrossrefAuthor>,
    pub year: Option<u64>,
    pub container: Option<String>,
    #[serde(rename = "type")]
    pub work_type: String,
    pub url: Option<String>,
    pub provider_score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CrossrefSearchResponse {
    pub works: Vec<CrossrefWork>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CrossrefCommandError {
    pub kind: String,
    pub message: String,
    pub retry_after_ms: Option<u64>,
}

impl Display for CrossrefCommandError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CrossrefCommandError {}

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
            "bib" | "bibtex" | "json" | "ris" | "enw" => {
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
        citation_style: default_citation_style(),
        citation_locale: default_citation_locale(),
        citation_bibliography: None,
        execution: ProjectExecutionPreferences::default(),
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
    validate_citation_preferences(&config.citation_style, &config.citation_locale)?;
    validate_execution_preferences(&config.execution)?;
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
    recover_citation_transactions(&root)?;
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
        "bib" | "bibtex" | "json" | "ris" | "enw"
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
            "Only .bib, .bibtex, .json, .ris, and .enw bibliography files can be read: {relative}"
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

fn project_asset_media_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "tif" | "tiff" => Some("image/tiff"),
        "svg" => Some("image/svg+xml"),
        "pdf" => Some("application/pdf"),
        "eps" => Some("application/postscript"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn read_project_assets_impl(
    raw_root: &str,
    paths: &[String],
) -> Result<Vec<ProjectAsset>, HostError> {
    if paths.len() > 128 {
        return Err(HostError::UnsupportedFile(
            "A submission package cannot include more than 128 project assets.".to_string(),
        ));
    }
    let root = canonical_root(raw_root)?;
    let mut total_bytes = 0_u64;
    let mut assets = Vec::with_capacity(paths.len());
    for relative in paths {
        let safe = safe_relative(relative)?;
        let requested = root.join(&safe);
        let canonical = fs::canonicalize(&requested).map_err(|_| {
            HostError::NotFound(format!("The project asset was not found: {relative}"))
        })?;
        if !canonical.starts_with(&root) {
            return Err(HostError::InvalidPath(format!(
                "Project assets cannot resolve outside the project folder: {relative}"
            )));
        }
        let media_type = project_asset_media_type(&canonical).ok_or_else(|| {
            HostError::UnsupportedFile(format!(
                "Submission assets must be PNG, JPEG, TIFF, SVG, PDF, EPS, or WebP files: {relative}"
            ))
        })?;
        let metadata = fs::metadata(&canonical)?;
        if !metadata.is_file() {
            return Err(HostError::UnsupportedFile(format!(
                "The project asset is not a file: {relative}"
            )));
        }
        if metadata.len() > MAX_PROJECT_ASSET_BYTES {
            return Err(HostError::UnsupportedFile(format!(
                "A project asset exceeds the 32 MB packaging limit: {relative}"
            )));
        }
        total_bytes = total_bytes.saturating_add(metadata.len());
        if total_bytes > MAX_PROJECT_ASSETS_BYTES {
            return Err(HostError::UnsupportedFile(
                "Project assets exceed the 96 MB packaging limit.".to_string(),
            ));
        }
        assets.push(ProjectAsset {
            path: slash_path(&safe),
            bytes: fs::read(&canonical)?,
            media_type: media_type.to_string(),
        });
    }
    Ok(assets)
}

fn citation_lock_path(root: &Path) -> PathBuf {
    root.join(".draftmatter").join("citations.lock.json")
}

fn citation_cache_path(root: &Path) -> PathBuf {
    root.join(".draftmatter").join("cited-records.json")
}

fn validate_citation_cache(content: &str) -> Result<(), HostError> {
    if content.len() as u64 > MAX_CITATION_LOCK_BYTES {
        return Err(HostError::UnsupportedFile(
            "The cited-record cache exceeds the 4 MB project limit.".to_string(),
        ));
    }
    let value: serde_json::Value = serde_json::from_str(content).map_err(|error| {
        HostError::InvalidProject(format!("The cited-record cache is not valid JSON: {error}"))
    })?;
    if value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
        || !value
            .get("records")
            .is_some_and(serde_json::Value::is_array)
    {
        return Err(HostError::InvalidProject(
            "The cited-record cache must use schemaVersion 1 and contain a records array."
                .to_string(),
        ));
    }
    Ok(())
}

fn read_citation_cache_impl(raw_root: &str) -> Result<Option<DocumentSnapshot>, HostError> {
    let root = canonical_root(raw_root)?;
    let path = citation_cache_path(&root);
    if !path.exists() {
        return Ok(None);
    }
    let metadata = fs::metadata(&path)?;
    if metadata.len() > MAX_CITATION_LOCK_BYTES {
        return Err(HostError::UnsupportedFile(
            "The cited-record cache exceeds the 4 MB project limit.".to_string(),
        ));
    }
    let content = fs::read_to_string(&path).map_err(|error| {
        HostError::InvalidProject(format!(
            "The cited-record cache must be valid UTF-8: {error}"
        ))
    })?;
    validate_citation_cache(&content)?;
    Ok(Some(DocumentSnapshot {
        path: ".draftmatter/cited-records.json".to_string(),
        hash: source_hash(content.as_bytes()),
        content,
        modified_ms: modified_ms(&metadata),
    }))
}

fn validate_citation_lock(content: &str) -> Result<(), HostError> {
    if content.len() as u64 > MAX_CITATION_LOCK_BYTES {
        return Err(HostError::UnsupportedFile(
            "The citation lock exceeds the 4 MB project limit.".to_string(),
        ));
    }
    let value: serde_json::Value = serde_json::from_str(content).map_err(|error| {
        HostError::InvalidProject(format!("The citation lock is not valid JSON: {error}"))
    })?;
    if value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
    {
        return Err(HostError::InvalidProject(
            "The citation lock must use schemaVersion 1.".to_string(),
        ));
    }
    if !value
        .get("entries")
        .is_some_and(serde_json::Value::is_array)
    {
        return Err(HostError::InvalidProject(
            "The citation lock must contain an entries array.".to_string(),
        ));
    }
    Ok(())
}

fn read_citation_lock_impl(raw_root: &str) -> Result<Option<DocumentSnapshot>, HostError> {
    let root = canonical_root(raw_root)?;
    let path = citation_lock_path(&root);
    if !path.exists() {
        return Ok(None);
    }
    let metadata = fs::metadata(&path)?;
    if metadata.len() > MAX_CITATION_LOCK_BYTES {
        return Err(HostError::UnsupportedFile(
            "The citation lock exceeds the 4 MB project limit.".to_string(),
        ));
    }
    let content = fs::read_to_string(&path).map_err(|error| {
        HostError::InvalidProject(format!("The citation lock must be valid UTF-8: {error}"))
    })?;
    Ok(Some(DocumentSnapshot {
        path: ".draftmatter/citations.lock.json".to_string(),
        hash: source_hash(content.as_bytes()),
        content,
        modified_ms: modified_ms(&metadata),
    }))
}

fn save_citation_lock_impl(
    request: SaveCitationLockRequest,
) -> Result<DocumentSnapshot, HostError> {
    validate_citation_lock(&request.content)?;
    let root = canonical_root(&request.root)?;
    let path = citation_lock_path(&root);
    let previous = if path.exists() {
        fs::read(&path)?
    } else {
        Vec::new()
    };
    if let Some(expected) = request.expected_hash.as_deref() {
        let actual = source_hash(&previous);
        if actual != expected {
            return Err(HostError::Conflict(format!(
                ".draftmatter/citations.lock.json changed outside DraftMatter (expected {expected}, found {actual})."
            )));
        }
    } else if !previous.is_empty() {
        return Err(HostError::Conflict(
            ".draftmatter/citations.lock.json appeared outside DraftMatter before the first save."
                .to_string(),
        ));
    }
    write_atomic(&path, request.content.as_bytes(), false)?;
    read_citation_lock_impl(&request.root)?.ok_or_else(|| {
        HostError::Io("The citation lock disappeared after it was saved.".to_string())
    })
}

fn expected_file_bytes(
    path: &Path,
    expected_hash: Option<&str>,
    label: &str,
) -> Result<Vec<u8>, HostError> {
    let previous = if path.exists() {
        fs::read(path)?
    } else {
        Vec::new()
    };
    match expected_hash {
        Some(expected) if source_hash(&previous) != expected => Err(HostError::Conflict(format!(
            "{label} changed outside DraftMatter (expected {expected}, found {}).",
            source_hash(&previous)
        ))),
        None if !previous.is_empty() => Err(HostError::Conflict(format!(
            "{label} appeared outside DraftMatter before citation acquisition."
        ))),
        _ => Ok(previous),
    }
}

fn citation_json_id(value: &serde_json::Value) -> Option<&str> {
    value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id.chars().all(|character| {
                    character.is_ascii_alphanumeric() || "_:.+-".contains(character)
                })
        })
}

fn citation_json_doi(value: &serde_json::Value) -> Option<String> {
    value
        .get("DOI")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|doi| valid_doi(doi))
        .map(str::to_ascii_lowercase)
}

fn citation_json_provider(value: &serde_json::Value) -> Option<String> {
    let metadata = value.get("_draftmatter")?;
    let provider = metadata.get("provider")?.as_str()?.trim();
    let provider_id = metadata.get("providerId")?.as_str()?.trim();
    if provider.is_empty() || provider_id.is_empty() {
        None
    } else {
        Some(format!("{provider}:{provider_id}"))
    }
}

fn merge_acquired_bibliography(
    previous: &[u8],
    incoming: &[serde_json::Value],
) -> Result<(Vec<u8>, usize, usize), HostError> {
    if incoming.is_empty() || incoming.len() > 100 {
        return Err(HostError::InvalidProject(
            "A citation acquisition must contain between 1 and 100 records.".to_string(),
        ));
    }
    let mut records = if previous.is_empty() {
        Vec::new()
    } else {
        serde_json::from_slice::<Vec<serde_json::Value>>(previous).map_err(|error| {
            HostError::InvalidProject(format!(
                "The acquisition bibliography must be a CSL JSON array: {error}"
            ))
        })?
    };
    if records
        .iter()
        .any(|record| citation_json_id(record).is_none())
    {
        return Err(HostError::InvalidProject(
            "The acquisition bibliography contains a record without a safe CSL id.".to_string(),
        ));
    }
    let mut acquired = 0;
    let mut unchanged = 0;
    for candidate in incoming {
        let id = citation_json_id(candidate).ok_or_else(|| {
            HostError::InvalidProject("An acquired citation record has no safe CSL id.".to_string())
        })?;
        let doi = citation_json_doi(candidate);
        let provider = citation_json_provider(candidate);
        let existing = records.iter().find(|record| {
            doi.as_ref()
                .is_some_and(|value| citation_json_doi(record).as_ref() == Some(value))
                || provider
                    .as_ref()
                    .is_some_and(|value| citation_json_provider(record).as_ref() == Some(value))
                || citation_json_id(record).is_some_and(|value| value.eq_ignore_ascii_case(id))
        });
        if let Some(existing) = existing {
            let existing_id = citation_json_id(existing).unwrap_or_default();
            if !existing_id.eq_ignore_ascii_case(id) {
                return Err(HostError::Conflict(format!(
                    "This citation is already acquired as @{existing_id}; refresh the project before inserting it again."
                )));
            }
            unchanged += 1;
            continue;
        }
        records.push(candidate.clone());
        acquired += 1;
    }
    records.sort_by(|left, right| {
        citation_json_id(left)
            .unwrap_or_default()
            .to_ascii_lowercase()
            .cmp(
                &citation_json_id(right)
                    .unwrap_or_default()
                    .to_ascii_lowercase(),
            )
    });
    let mut content = serde_json::to_vec_pretty(&records)
        .map_err(|error| HostError::InvalidProject(error.to_string()))?;
    content.push(b'\n');
    if content.len() as u64 > MAX_BIBLIOGRAPHY_BYTES {
        return Err(HostError::UnsupportedFile(
            "The acquisition bibliography exceeds the 10 MB project limit.".to_string(),
        ));
    }
    Ok((content, acquired, unchanged))
}

fn acquire_citations_impl(
    request: AcquireCitationsRequest,
) -> Result<AcquireCitationsResult, HostError> {
    acquire_citations_impl_with_fault(request, None)
}

fn acquire_citations_impl_with_fault(
    request: AcquireCitationsRequest,
    fail_after_replace: Option<usize>,
) -> Result<AcquireCitationsResult, HostError> {
    validate_citation_lock(&request.lock_content)?;
    validate_citation_cache(&request.cache_content)?;
    let root = canonical_root(&request.root)?;
    recover_citation_transactions(&root)?;
    let document_path = contained_path(&root, &request.document_path)?;
    if !manuscript_extension(&document_path) {
        return Err(HostError::UnsupportedFile(
            "Citation acquisition can update only a .md or .qmd manuscript.".to_string(),
        ));
    }
    let bibliography_path = contained_path(&root, &request.bibliography_path)?;
    if bibliography_path.extension().and_then(OsStr::to_str) != Some("json")
        || request.bibliography_path.starts_with(".draftmatter/")
    {
        return Err(HostError::UnsupportedFile(
            "The portable acquisition target must be a project-visible CSL JSON file.".to_string(),
        ));
    }
    let previous_document = expected_file_bytes(
        &document_path,
        Some(&request.expected_document_hash),
        &request.document_path,
    )?;
    let previous_bibliography = expected_file_bytes(
        &bibliography_path,
        request.expected_bibliography_hash.as_deref(),
        &request.bibliography_path,
    )?;
    let lock_path = citation_lock_path(&root);
    expected_file_bytes(
        &lock_path,
        request.expected_lock_hash.as_deref(),
        ".draftmatter/citations.lock.json",
    )?;
    let cache_path = citation_cache_path(&root);
    expected_file_bytes(
        &cache_path,
        request.expected_cache_hash.as_deref(),
        ".draftmatter/cited-records.json",
    )?;

    let (bibliography_content, acquired, unchanged) =
        merge_acquired_bibliography(&previous_bibliography, &request.bibliography_records)?;
    let mut documents = Vec::new();
    let mut bibliographies = Vec::new();
    discover_entries(&root, &root, 0, &mut documents, &mut bibliographies)?;
    let mut config = load_config(&root, &documents)?;
    config.citation_bibliography = Some(request.bibliography_path.clone());
    let config_content = serde_json::to_vec_pretty(&config)
        .map_err(|error| HostError::InvalidProject(error.to_string()))?;

    let changes = vec![
        (
            request.bibliography_path.clone(),
            bibliography_content.clone(),
        ),
        (
            ".draftmatter/citations.lock.json".to_string(),
            request.lock_content.as_bytes().to_vec(),
        ),
        (
            ".draftmatter/cited-records.json".to_string(),
            request.cache_content.as_bytes().to_vec(),
        ),
        (".draftmatter/project.json".to_string(), config_content),
        (
            request.document_path.clone(),
            request.document_content.as_bytes().to_vec(),
        ),
    ];
    apply_citation_file_transaction(&root, changes, fail_after_replace)?;
    if !previous_document.is_empty() && previous_document != request.document_content.as_bytes() {
        let _ = create_recovery(&root, &request.document_path, &previous_document);
    }
    Ok(AcquireCitationsResult {
        document_hash: source_hash(request.document_content.as_bytes()),
        bibliography_hash: source_hash(&bibliography_content),
        lock_hash: source_hash(request.lock_content.as_bytes()),
        cache_hash: source_hash(request.cache_content.as_bytes()),
        bibliography_path: request.bibliography_path,
        acquired,
        unchanged,
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

fn generated_export_extension(name: &str) -> Result<&str, HostError> {
    let path = Path::new(name);
    if name.is_empty()
        || name.len() > 180
        || path.is_absolute()
        || path.components().count() != 1
        || path.file_name().and_then(OsStr::to_str) != Some(name)
    {
        return Err(HostError::InvalidPath(
            "Export filenames must be a single filename with no folders.".to_string(),
        ));
    }
    let extension = path.extension().and_then(OsStr::to_str).unwrap_or_default();
    if !matches!(extension, "md" | "qmd" | "html" | "docx" | "zip") {
        return Err(HostError::UnsupportedFile(
            "Generated exports must use .md, .qmd, .html, .docx, or .zip.".to_string(),
        ));
    }
    Ok(extension)
}

fn save_generated_export_to_path(
    path: &Path,
    expected_extension: &str,
    bytes: &[u8],
) -> Result<SaveExportFileResult, HostError> {
    if !path.is_absolute() || path.extension().and_then(OsStr::to_str) != Some(expected_extension) {
        return Err(HostError::InvalidPath(format!(
            "Choose an absolute .{expected_extension} export path."
        )));
    }
    write_atomic(path, bytes, false)?;
    Ok(SaveExportFileResult {
        path: path.to_string_lossy().to_string(),
        bytes: bytes.len() as u64,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CitationTransactionManifest {
    state: String,
    files: Vec<CitationTransactionFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CitationTransactionFile {
    target: String,
    backup: Option<String>,
}

fn rollback_citation_transaction(
    root: &Path,
    directory: &Path,
    manifest: &CitationTransactionManifest,
) -> Result<(), HostError> {
    for file in manifest.files.iter().rev() {
        let target = contained_path(root, &file.target)?;
        if let Some(backup) = file.backup.as_deref() {
            let bytes = fs::read(directory.join(safe_relative(backup)?))?;
            write_atomic(&target, &bytes, false)?;
        } else if target.exists() {
            fs::remove_file(&target)?;
        }
    }
    if directory.exists() {
        fs::remove_dir_all(directory)?;
    }
    Ok(())
}

fn recover_citation_transactions(root: &Path) -> Result<(), HostError> {
    let transactions = root.join(".draftmatter").join("transactions");
    if !transactions.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&transactions)? {
        let directory = entry?.path();
        if !directory.is_dir() {
            continue;
        }
        let manifest_path = directory.join("manifest.json");
        if !manifest_path.exists() {
            fs::remove_dir_all(&directory)?;
            continue;
        }
        let manifest: CitationTransactionManifest =
            serde_json::from_slice(&fs::read(&manifest_path).map_err(|error| {
                HostError::InvalidProject(format!(
                    "Citation acquisition recovery cannot read {}: {error}",
                    manifest_path.display()
                ))
            })?)
            .map_err(|error| {
                HostError::InvalidProject(format!(
                    "Citation acquisition recovery cannot parse {}: {error}",
                    manifest_path.display()
                ))
            })?;
        if manifest.state == "committed" {
            fs::remove_dir_all(&directory)?;
        } else {
            rollback_citation_transaction(root, &directory, &manifest)?;
        }
    }
    Ok(())
}

fn apply_citation_file_transaction(
    root: &Path,
    changes: Vec<(String, Vec<u8>)>,
    fail_after_replace: Option<usize>,
) -> Result<(), HostError> {
    let mut seen = std::collections::HashSet::new();
    if changes
        .iter()
        .any(|(target, _)| !seen.insert(target.clone()))
    {
        return Err(HostError::InvalidProject(
            "A citation acquisition transaction contains duplicate target files.".to_string(),
        ));
    }
    let directory = root.join(".draftmatter").join("transactions").join(format!(
        "citation-{}-{}",
        now_millis(),
        std::process::id()
    ));
    fs::create_dir_all(&directory)?;
    let mut manifest = CitationTransactionManifest {
        state: "prepared".to_string(),
        files: Vec::new(),
    };
    for (index, (target, _)) in changes.iter().enumerate() {
        let path = contained_path(root, target)?;
        let backup = if path.exists() {
            let name = format!("backup-{index}.bin");
            write_atomic(&directory.join(&name), &fs::read(&path)?, false)?;
            Some(name)
        } else {
            None
        };
        manifest.files.push(CitationTransactionFile {
            target: target.clone(),
            backup,
        });
    }
    let manifest_path = directory.join("manifest.json");
    write_atomic(
        &manifest_path,
        &serde_json::to_vec_pretty(&manifest)
            .map_err(|error| HostError::InvalidProject(error.to_string()))?,
        false,
    )?;

    let result = (|| {
        for (index, (target, content)) in changes.iter().enumerate() {
            write_atomic(&contained_path(root, target)?, content, false)?;
            if fail_after_replace == Some(index + 1) {
                return Err(HostError::Io(format!(
                    "Injected citation acquisition failure after {} replacement(s).",
                    index + 1
                )));
            }
        }
        manifest.state = "committed".to_string();
        write_atomic(
            &manifest_path,
            &serde_json::to_vec_pretty(&manifest)
                .map_err(|error| HostError::InvalidProject(error.to_string()))?,
            false,
        )?;
        fs::remove_dir_all(&directory)?;
        Ok(())
    })();
    if let Err(error) = result {
        rollback_citation_transaction(root, &directory, &manifest).map_err(|rollback| {
            HostError::Io(format!(
                "{error} Citation acquisition rollback also failed: {rollback}"
            ))
        })?;
        return Err(error);
    }
    Ok(())
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

fn set_citation_preferences_impl(
    raw_root: &str,
    style: &str,
    locale: &str,
) -> Result<ProjectSnapshot, HostError> {
    validate_citation_preferences(style, locale)?;
    let mut snapshot = open_project_impl(raw_root)?;
    snapshot.config.citation_style = style.to_string();
    snapshot.config.citation_locale = locale.to_string();
    let root = canonical_root(raw_root)?;
    persist_config(&root, &snapshot.config)?;
    open_project_impl(raw_root)
}

fn set_execution_preferences_impl(
    raw_root: &str,
    preferences: ProjectExecutionPreferences,
) -> Result<ProjectSnapshot, HostError> {
    validate_execution_preferences(&preferences)?;
    let mut snapshot = open_project_impl(raw_root)?;
    snapshot.config.execution = preferences;
    let root = canonical_root(raw_root)?;
    persist_config(&root, &snapshot.config)?;
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
    filename: Option<String>,
    content_type: Option<String>,
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

fn scholar_search_url(query: &str) -> Result<String, HostError> {
    let query = query.trim();
    if query.is_empty() || query.len() > 512 {
        return Err(HostError::Integration(
            "Google Scholar search needs an explicit query of at most 512 bytes.".to_string(),
        ));
    }
    Ok(format!(
        "https://scholar.google.com/scholar?q={}",
        percent_encode_query(query)
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum CitationLinkKind {
    Doi,
    RecordUrl,
    ZoteroItem,
    ZoteroAttachment,
}

fn valid_zotero_item_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
}

fn citation_record_url(value: &str) -> Result<String, HostError> {
    let url = value.trim();
    if url.is_empty()
        || url.len() > 2_048
        || url
            .chars()
            .any(|character| character.is_control() || character.is_whitespace() || character == '\\')
    {
        return Err(HostError::Integration(
            "The citation source URL is not safe to open.".to_string(),
        ));
    }
    let scheme_end = url.find("://").ok_or_else(|| {
        HostError::Integration("Citation source links must use HTTP or HTTPS.".to_string())
    })?;
    let scheme = &url[..scheme_end];
    if !scheme.eq_ignore_ascii_case("https") && !scheme.eq_ignore_ascii_case("http") {
        return Err(HostError::Integration(
            "Citation source links must use HTTP or HTTPS.".to_string(),
        ));
    }
    let remainder = &url[scheme_end + 3..];
    let authority_end = remainder
        .find(|character| matches!(character, '/' | '?' | '#'))
        .unwrap_or(remainder.len());
    let authority = &remainder[..authority_end];
    if authority.is_empty()
        || authority.contains('@')
        || !authority.chars().any(|character| character.is_ascii_alphanumeric())
    {
        return Err(HostError::Integration(
            "Citation source links cannot contain embedded credentials or an empty host."
                .to_string(),
        ));
    }
    Ok(url.to_string())
}

fn citation_link_url(kind: CitationLinkKind, value: &str) -> Result<String, HostError> {
    match kind {
        CitationLinkKind::Doi => doi_csl_request_url(value).map_err(|error| {
            HostError::Integration(format!("Could not open the citation DOI: {}", error.message))
        }),
        CitationLinkKind::RecordUrl => citation_record_url(value),
        CitationLinkKind::ZoteroItem => {
            let item_key = value.trim();
            if !valid_zotero_item_key(item_key) {
                return Err(HostError::Integration(
                    "The citation does not contain a valid Zotero item identity.".to_string(),
                ));
            }
            Ok(format!("zotero://select/library/items/{item_key}"))
        }
        CitationLinkKind::ZoteroAttachment => {
            let item_key = value.trim();
            if !valid_zotero_item_key(item_key) {
                return Err(HostError::Integration(
                    "The citation does not contain a valid Zotero attachment identity."
                        .to_string(),
                ));
            }
            Ok(format!("zotero://open-pdf/library/items/{item_key}"))
        }
    }
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

fn zotero_item_attachments_impl(item_key: &str) -> Result<Vec<ZoteroAttachment>, HostError> {
    zotero_item_attachments_at(zotero_address(), item_key)
}

fn zotero_item_attachments_at(
    address: SocketAddr,
    item_key: &str,
) -> Result<Vec<ZoteroAttachment>, HostError> {
    let item_key = item_key.trim();
    if !valid_zotero_item_key(item_key) {
        return Err(integration_error(
            "Zotero attachment lookup requires a valid item key.",
        ));
    }
    let path = format!(
        "/api/users/0/items/{item_key}/children?itemType=attachment&limit=25"
    );
    let response = zotero_request_at(address, &path)?;
    if !(200..300).contains(&response.status) {
        return Err(integration_error(format!(
            "Zotero attachment lookup returned HTTP {}.",
            response.status
        )));
    }
    let raw = serde_json::from_slice::<Vec<RawZoteroItem>>(&response.body).map_err(|error| {
        integration_error(format!("Zotero returned unreadable attachment data: {error}"))
    })?;
    Ok(raw
        .into_iter()
        .filter(|item| item.data.item_type == "attachment")
        .map(|item| ZoteroAttachment {
            item_key: item.key,
            title: if item.data.title.trim().is_empty() {
                item.data
                    .filename
                    .clone()
                    .unwrap_or_else(|| "Zotero attachment".to_string())
            } else {
                item.data.title
            },
            filename: item.data.filename,
            content_type: item.data.content_type,
        })
        .collect())
}

fn crossref_error(kind: &str, message: impl Into<String>) -> CrossrefCommandError {
    CrossrefCommandError {
        kind: kind.to_string(),
        message: message.into(),
        retry_after_ms: None,
    }
}

fn valid_doi(value: &str) -> bool {
    let doi = value.trim();
    let Some((registrant, suffix)) = doi.split_once('/') else {
        return false;
    };
    registrant.starts_with("10.")
        && (7..=12).contains(&registrant.len())
        && registrant[3..]
            .chars()
            .all(|character| character.is_ascii_digit())
        && !suffix.is_empty()
        && !suffix.chars().any(char::is_whitespace)
}

fn valid_crossref_date(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .chars()
            .enumerate()
            .all(|(index, character)| matches!(index, 4 | 7) || character.is_ascii_digit())
}

fn valid_crossref_mailto(value: &str) -> bool {
    value.len() <= 254
        && !value.chars().any(char::is_whitespace)
        && value
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.'))
}

fn crossref_request_parts(
    request: &CrossrefSearchRequest,
) -> Result<(String, Vec<(&'static str, String)>), CrossrefCommandError> {
    crossref_request_parts_with_mailto(request, CROSSREF_MAILTO)
}

fn crossref_request_parts_with_mailto(
    request: &CrossrefSearchRequest,
    maintainer_email: Option<&str>,
) -> Result<(String, Vec<(&'static str, String)>), CrossrefCommandError> {
    let mailto = maintainer_email.filter(|value| valid_crossref_mailto(value));
    if let Some(doi) = request.doi.as_deref() {
        if request.bibliographic.is_some()
            || request.author.is_some()
            || request.title.is_some()
            || request.from_publication_date.is_some()
            || request.until_publication_date.is_some()
        {
            return Err(crossref_error(
                "invalid-request",
                "A DOI lookup cannot include general Crossref query fields.",
            ));
        }
        let normalized = doi
            .trim()
            .strip_prefix("https://doi.org/")
            .unwrap_or(doi.trim())
            .to_ascii_lowercase();
        if normalized.len() > 512 || !valid_doi(&normalized) {
            return Err(crossref_error("invalid-request", "The DOI is not valid."));
        }
        return Ok((
            format!("{CROSSREF_WORKS_URL}/{}", percent_encode_query(&normalized)),
            mailto
                .map(|value| vec![("mailto", value.to_string())])
                .unwrap_or_default(),
        ));
    }

    let bibliographic = request
        .bibliographic
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let author = request
        .author
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let title = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if bibliographic.is_none() && (author.is_none() || title.is_none()) {
        return Err(crossref_error(
            "invalid-request",
            "Crossref search needs a bibliographic query or both author and title fields.",
        ));
    }
    if bibliographic.is_some_and(|value| value.len() > 512)
        || author.is_some_and(|value| value.len() > 128)
        || title.is_some_and(|value| value.len() > 512)
    {
        return Err(crossref_error(
            "invalid-request",
            "The Crossref query exceeds the bounded field length.",
        ));
    }
    for date in [
        request.from_publication_date.as_deref(),
        request.until_publication_date.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if !valid_crossref_date(date) {
            return Err(crossref_error(
                "invalid-request",
                "Crossref publication dates must use YYYY-MM-DD.",
            ));
        }
    }

    let mut query = vec![
        ("rows", "20".to_string()),
        (
            "select",
            "DOI,title,author,published,container-title,type,URL,score".to_string(),
        ),
    ];
    if let Some(value) = mailto {
        query.push(("mailto", value.to_string()));
    }
    if let Some(value) = bibliographic {
        query.push(("query.bibliographic", value.to_string()));
    }
    if let Some(value) = author {
        query.push(("query.author", value.to_string()));
    }
    if let Some(value) = title {
        query.push(("query.title", value.to_string()));
    }
    let dates = match (
        request.from_publication_date.as_deref(),
        request.until_publication_date.as_deref(),
    ) {
        (Some(from), Some(until)) => Some(format!("from-pub-date:{from},until-pub-date:{until}")),
        (Some(from), None) => Some(format!("from-pub-date:{from}")),
        (None, Some(until)) => Some(format!("until-pub-date:{until}")),
        (None, None) => None,
    };
    if let Some(filter) = dates {
        query.push(("filter", filter));
    }
    Ok((CROSSREF_WORKS_URL.to_string(), query))
}

fn crossref_string(value: &serde_json::Value, key: &str) -> Option<String> {
    let field = value.get(key)?;
    field
        .as_str()
        .or_else(|| field.as_array()?.first()?.as_str())
        .map(str::to_string)
}

fn crossref_work(value: &serde_json::Value) -> CrossrefWork {
    let authors = value
        .get("author")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|author| {
            let family = author.get("family")?.as_str()?.trim();
            if family.is_empty() {
                return None;
            }
            Some(CrossrefAuthor {
                family: family.to_string(),
                given: author
                    .get("given")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect();
    let year = value
        .get("published")
        .and_then(|published| published.get("date-parts"))
        .and_then(serde_json::Value::as_array)
        .and_then(|parts| parts.first())
        .and_then(serde_json::Value::as_array)
        .and_then(|date| date.first())
        .and_then(serde_json::Value::as_u64);
    CrossrefWork {
        doi: crossref_string(value, "DOI").unwrap_or_default(),
        title: crossref_string(value, "title").unwrap_or_else(|| "Untitled record".to_string()),
        authors,
        year,
        container: crossref_string(value, "container-title"),
        work_type: crossref_string(value, "type").unwrap_or_else(|| "article".to_string()),
        url: crossref_string(value, "URL"),
        provider_score: value.get("score").and_then(serde_json::Value::as_f64),
    }
}

fn parse_crossref_response(body: &[u8]) -> Result<CrossrefSearchResponse, CrossrefCommandError> {
    let root = serde_json::from_slice::<serde_json::Value>(body).map_err(|error| {
        crossref_error(
            "invalid-response",
            format!("Crossref returned unreadable JSON: {error}"),
        )
    })?;
    let message = root.get("message").ok_or_else(|| {
        crossref_error(
            "invalid-response",
            "Crossref response has no message object.",
        )
    })?;
    let works = if let Some(items) = message.get("items").and_then(serde_json::Value::as_array) {
        items.iter().take(20).map(crossref_work).collect()
    } else if message.is_object() {
        vec![crossref_work(message)]
    } else {
        return Err(crossref_error(
            "invalid-response",
            "Crossref response has an invalid message shape.",
        ));
    };
    Ok(CrossrefSearchResponse { works })
}

fn crossref_search_impl(
    request: CrossrefSearchRequest,
) -> Result<CrossrefSearchResponse, CrossrefCommandError> {
    let (url, query) = crossref_request_parts(&request)?;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(4))
        .timeout_read(Duration::from_secs(8))
        .build();
    let mut http = agent
        .get(&url)
        .set("Accept", "application/json")
        .set("User-Agent", CROSSREF_USER_AGENT);
    for (name, value) in &query {
        http = http.query(name, value);
    }
    let response = http.call().map_err(|error| match error {
        ureq::Error::Status(429, response) => {
            let retry_after_ms = response
                .header("Retry-After")
                .and_then(|value| value.parse::<u64>().ok())
                .map(|seconds| seconds.saturating_mul(1_000))
                .or(Some(1_000));
            CrossrefCommandError {
                kind: "rate-limit".to_string(),
                message: "Crossref is rate-limiting requests.".to_string(),
                retry_after_ms,
            }
        }
        ureq::Error::Status(status, _) if (500..=599).contains(&status) => CrossrefCommandError {
            kind: "http".to_string(),
            message: format!("Crossref search returned HTTP {status}."),
            retry_after_ms: Some(1_000),
        },
        ureq::Error::Status(status, _) => {
            crossref_error("http", format!("Crossref search returned HTTP {status}."))
        }
        ureq::Error::Transport(_) => crossref_error(
            "offline",
            "Crossref is unavailable. Check the network connection and retry.",
        ),
    })?;
    let mut body = Vec::new();
    response
        .into_reader()
        .take(MAX_CROSSREF_RESPONSE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|error| crossref_error("offline", format!("Crossref response failed: {error}")))?;
    if body.len() as u64 > MAX_CROSSREF_RESPONSE_BYTES {
        return Err(crossref_error(
            "invalid-response",
            "Crossref response exceeded the 4 MB safety limit.",
        ));
    }
    parse_crossref_response(&body)
}

fn doi_csl_request_url(doi: &str) -> Result<String, CrossrefCommandError> {
    let normalized = doi
        .trim()
        .strip_prefix("https://doi.org/")
        .unwrap_or(doi.trim())
        .to_ascii_lowercase();
    if normalized.len() > 512 || !valid_doi(&normalized) {
        return Err(crossref_error("invalid-request", "The DOI is not valid."));
    }
    Ok(format!(
        "{DOI_RESOLVER_URL}/{}",
        percent_encode_query(&normalized)
    ))
}

fn parse_doi_csl_response(body: &[u8]) -> Result<serde_json::Value, CrossrefCommandError> {
    let value = serde_json::from_slice::<serde_json::Value>(body).map_err(|error| {
        crossref_error(
            "invalid-response",
            format!("The DOI resolver returned unreadable CSL JSON: {error}"),
        )
    })?;
    if !value.is_object() {
        return Err(crossref_error(
            "invalid-response",
            "The DOI resolver did not return a CSL JSON object.",
        ));
    }
    Ok(value)
}

fn resolve_doi_csl_impl(doi: &str) -> Result<serde_json::Value, CrossrefCommandError> {
    let url = doi_csl_request_url(doi)?;
    let response = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(4))
        .timeout_read(Duration::from_secs(8))
        .build()
        .get(&url)
        .set("Accept", "application/vnd.citationstyles.csl+json")
        .set("User-Agent", CROSSREF_USER_AGENT)
        .call()
        .map_err(|error| match error {
            ureq::Error::Status(429, _) => CrossrefCommandError {
                kind: "rate-limit".to_string(),
                message: "The DOI resolver is rate-limiting requests.".to_string(),
                retry_after_ms: Some(1_000),
            },
            ureq::Error::Status(status, _) => crossref_error(
                "http",
                format!("DOI metadata resolution returned HTTP {status}."),
            ),
            ureq::Error::Transport(_) => crossref_error(
                "offline",
                "DOI metadata resolution is unavailable. Check the network connection and retry.",
            ),
        })?;
    let mut body = Vec::new();
    response
        .into_reader()
        .take(MAX_CROSSREF_RESPONSE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|error| crossref_error("offline", format!("DOI metadata read failed: {error}")))?;
    if body.len() as u64 > MAX_CROSSREF_RESPONSE_BYTES {
        return Err(crossref_error(
            "invalid-response",
            "DOI metadata exceeded the 4 MB safety limit.",
        ));
    }
    parse_doi_csl_response(&body)
}

#[tauri::command]
fn open_project(root: String) -> Result<ProjectSnapshot, HostError> {
    open_project_impl(&root)
}

fn normalized_project_name(raw: &str) -> Result<String, HostError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(HostError::InvalidProject(
            "Enter a name for the new DraftMatter project.".to_string(),
        ));
    }
    if name.chars().count() > 240 || name.chars().any(char::is_control) {
        return Err(HostError::InvalidProject(
            "Project names must be at most 240 characters and cannot contain control characters."
                .to_string(),
        ));
    }
    Ok(name.to_string())
}

fn windows_reserved_folder_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or_default().to_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
}

fn portable_project_folder_name(name: &str) -> Result<String, HostError> {
    const MAX_FOLDER_BYTES: usize = 160;
    let mut folder = String::new();
    for character in name.chars() {
        let replacement = if character.is_control() || "<>:\"/\\|?*".contains(character) {
            '-'
        } else {
            character
        };
        if replacement == '-' && folder.ends_with('-') {
            continue;
        }
        if folder.len() + replacement.len_utf8() > MAX_FOLDER_BYTES {
            break;
        }
        folder.push(replacement);
    }
    let mut folder = folder
        .trim_matches(|character| matches!(character, ' ' | '.'))
        .to_string();
    if folder.is_empty() || matches!(folder.as_str(), "." | "..") {
        return Err(HostError::InvalidProject(
            "The project name cannot be converted to a portable folder name.".to_string(),
        ));
    }
    if windows_reserved_folder_name(&folder) {
        folder.push_str(" project");
    }
    Ok(folder)
}

fn normalized_new_project_author(
    mut author: NewProjectAuthor,
) -> Result<NewProjectAuthor, HostError> {
    author.name = author.name.trim().to_string();
    if author.name.is_empty()
        || author.name.chars().count() > 240
        || author.name.chars().any(char::is_control)
    {
        return Err(HostError::InvalidProject(
            "Enter a valid first-author name on one line.".into(),
        ));
    }
    author.orcid = author.orcid.and_then(|value| {
        let trimmed = value.trim().to_uppercase();
        (!trimmed.is_empty()).then_some(trimmed)
    });
    if author
        .orcid
        .as_ref()
        .is_some_and(|value| value.len() > 64 || value.chars().any(char::is_control))
    {
        return Err(HostError::InvalidProject(
            "Enter a valid ORCID identifier on one line.".into(),
        ));
    }
    let mut affiliations = Vec::new();
    for affiliation in author.affiliations {
        let affiliation = affiliation.trim().to_string();
        if !affiliation.is_empty() && !affiliations.contains(&affiliation) {
            affiliations.push(affiliation);
        }
    }
    author.affiliations = affiliations;
    if author.affiliations.len() > 20
        || author
            .affiliations
            .iter()
            .any(|value| value.chars().count() > 300 || value.chars().any(char::is_control))
    {
        return Err(HostError::InvalidProject(
            "Use at most 20 one-line affiliations for the first author.".into(),
        ));
    }
    Ok(author)
}

fn starter_author_yaml(author: Option<&NewProjectAuthor>) -> String {
    let Some(author) = author else {
        return String::new();
    };
    let mut yaml = format!(
        "author:\n  - name: {}\n",
        serde_json::to_string(&author.name).unwrap()
    );
    if let Some(orcid) = &author.orcid {
        yaml.push_str(&format!(
            "    orcid: {}\n",
            serde_json::to_string(orcid).unwrap()
        ));
    }
    if !author.affiliations.is_empty() {
        yaml.push_str("    affiliations:\n");
        for affiliation in &author.affiliations {
            yaml.push_str(&format!(
                "      - {}\n",
                serde_json::to_string(affiliation).unwrap()
            ));
        }
    }
    yaml
}

fn initialize_project_root(
    root_path: &Path,
    raw_name: &str,
    first_author: Option<&NewProjectAuthor>,
) -> Result<ProjectSnapshot, HostError> {
    let name = normalized_project_name(raw_name)?;
    let canonical = fs::canonicalize(root_path)?;
    let main_document = "paper.qmd".to_string();
    let config = ProjectConfig {
        schema_version: PROJECT_SCHEMA,
        name,
        main_document: main_document.clone(),
        citation_style: default_citation_style(),
        citation_locale: default_citation_locale(),
        citation_bibliography: None,
        execution: ProjectExecutionPreferences::default(),
    };
    persist_config(&canonical, &config)?;
    let document = canonical.join(&main_document);
    if !document.exists() {
        let title = config.name.replace('\\', "\\\\").replace('"', "\\\"");
        let author = starter_author_yaml(first_author);
        let source = format!(
            "---\ntitle: \"{title}\"\n{author}format: html\n---\n\n## Abstract\n\nThis starter abstract introduces the research question, outlines the approach, and summarizes the principal finding. Replace it with a concise account of your own study.\n\n## Introduction\n\nIntroduce the topic, explain why it matters, and identify the gap your study addresses. End with the central research question or hypothesis.\n\n## Methods\n\nDescribe the study design, materials, measurements, and analysis in enough detail for another researcher to reproduce the work.\n\n## Results\n\nReport the observations that answer the research question most directly. Add figures, tables, or published values where they help readers understand the evidence.\n\n## Discussion\n\nInterpret the main findings in relation to the research question and relevant literature. Explain plausible mechanisms, limitations, and directions for future work.\n\n## Conclusion\n\nSummarize what the findings mean, note the main limitation, and close with the broader implication of the work.\n"
        );
        write_atomic(&document, source.as_bytes(), false)?;
    }
    open_project_impl(canonical.to_string_lossy().as_ref())
}

#[cfg(test)]
fn create_project_at_root(root_path: &Path, name: &str) -> Result<ProjectSnapshot, HostError> {
    if root_path.exists() && fs::read_dir(root_path)?.next().is_some() {
        return Err(HostError::InvalidProject(format!(
            "Choose an empty folder for a new DraftMatter project: {}",
            root_path.display()
        )));
    }
    fs::create_dir_all(root_path)?;
    initialize_project_root(root_path, name, None)
}

#[tauri::command]
fn create_project(
    parent: String,
    name: String,
    first_author: Option<NewProjectAuthor>,
) -> Result<ProjectSnapshot, HostError> {
    let parent_path = canonical_root(&parent)?;
    let normalized_name = normalized_project_name(&name)?;
    let first_author = first_author
        .map(normalized_new_project_author)
        .transpose()?;
    let folder_name = portable_project_folder_name(&normalized_name)?;
    let root_path = parent_path.join(&folder_name);
    fs::create_dir(&root_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            HostError::InvalidProject(format!(
                "A folder named {folder_name:?} already exists in {}. Choose another project name or location.",
                parent_path.display()
            ))
        } else {
            HostError::Io(error.to_string())
        }
    })?;
    match initialize_project_root(&root_path, &normalized_name, first_author.as_ref()) {
        Ok(snapshot) => Ok(snapshot),
        Err(error) => {
            let _ = fs::remove_dir_all(&root_path);
            Err(error)
        }
    }
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
fn read_project_assets(root: String, paths: Vec<String>) -> Result<Vec<ProjectAsset>, HostError> {
    read_project_assets_impl(&root, &paths)
}

#[tauri::command]
fn read_citation_lock(root: String) -> Result<Option<DocumentSnapshot>, HostError> {
    read_citation_lock_impl(&root)
}

#[tauri::command]
fn read_citation_cache(root: String) -> Result<Option<DocumentSnapshot>, HostError> {
    read_citation_cache_impl(&root)
}

#[tauri::command]
fn save_citation_lock(request: SaveCitationLockRequest) -> Result<DocumentSnapshot, HostError> {
    save_citation_lock_impl(request)
}

#[tauri::command]
fn save_document(request: SaveDocumentRequest) -> Result<SaveDocumentResult, HostError> {
    save_document_impl(request)
}

#[tauri::command]
async fn save_export_file(
    app: tauri::AppHandle,
    request: SaveExportFileRequest,
) -> Result<Option<SaveExportFileResult>, HostError> {
    if request.bytes.len() > MAX_GENERATED_EXPORT_BYTES {
        return Err(HostError::UnsupportedFile(
            "Generated exports cannot exceed 128 MB.".to_string(),
        ));
    }
    let extension = generated_export_extension(&request.suggested_name)?.to_string();
    let label = match extension.as_str() {
        "md" | "qmd" => "Portable manuscript",
        "html" => "HTML document",
        "docx" => "Word document",
        "zip" => "Journal submission package",
        _ => unreachable!(),
    };
    let selected = app
        .dialog()
        .file()
        .set_title("Save DraftMatter export")
        .set_file_name(&request.suggested_name)
        .add_filter(label, &[extension.as_str()])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let mut path = selected.into_path().map_err(|_| {
        HostError::InvalidPath(
            "The selected export destination is not a local file path.".to_string(),
        )
    })?;
    if path.extension().is_none() {
        path.set_extension(&extension);
    }
    save_generated_export_to_path(&path, &extension, &request.bytes).map(Some)
}

#[tauri::command]
fn print_publication(webview: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        webview.print().map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        webview
            .eval("window.print()")
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn acquire_citations(
    request: AcquireCitationsRequest,
) -> Result<AcquireCitationsResult, HostError> {
    acquire_citations_impl(request)
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
fn set_citation_preferences(
    root: String,
    style: String,
    locale: String,
) -> Result<ProjectSnapshot, HostError> {
    set_citation_preferences_impl(&root, &style, &locale)
}

#[tauri::command]
fn set_execution_preferences(
    root: String,
    preferences: ProjectExecutionPreferences,
) -> Result<ProjectSnapshot, HostError> {
    set_execution_preferences_impl(&root, preferences)
}

#[tauri::command]
fn zotero_status() -> ZoteroStatus {
    zotero_status_impl()
}

#[tauri::command]
fn zotero_search(query: String, limit: Option<u8>) -> Result<ZoteroSearchResult, HostError> {
    zotero_search_impl(&query, limit.unwrap_or(25))
}

#[tauri::command]
fn zotero_item_attachments(item_key: String) -> Result<Vec<ZoteroAttachment>, HostError> {
    zotero_item_attachments_impl(&item_key)
}

#[tauri::command]
fn crossref_search(
    request: CrossrefSearchRequest,
) -> Result<CrossrefSearchResponse, CrossrefCommandError> {
    crossref_search_impl(request)
}

#[tauri::command]
fn resolve_doi_csl(doi: String) -> Result<serde_json::Value, CrossrefCommandError> {
    resolve_doi_csl_impl(&doi)
}

#[tauri::command]
fn open_scholar_search(app: tauri::AppHandle, query: String) -> Result<(), HostError> {
    let url = scholar_search_url(&query)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| HostError::Integration(format!("Could not open Google Scholar: {error}")))
}

#[tauri::command]
fn open_citation_link(
    app: tauri::AppHandle,
    kind: CitationLinkKind,
    value: String,
) -> Result<(), HostError> {
    let url = citation_link_url(kind, &value)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| HostError::Integration(format!("Could not open the citation link: {error}")))
}

#[tauri::command]
fn probe_runtime_executable(language: RuntimeLanguage) -> RuntimeExecutableProbe {
    probe_runtime_executable_impl(language)
}

#[tauri::command]
fn discover_jupyter_kernels() -> JupyterKernelInventory {
    discover_jupyter_kernels_impl()
}

#[tauri::command]
async fn setup_kernel_integration(
    app: tauri::AppHandle,
    root: String,
    language: RuntimeLanguage,
    environment: Option<String>,
    task_id: Option<String>,
    trust: tauri::State<'_, ExecutionTrustStore>,
) -> Result<KernelIntegrationSetupResult, HostError> {
    let canonical = canonical_root(&root)?;
    execution_trust::require_execution_trust(&canonical, trust.inner())?;
    let progress = task_progress_reporter(app, task_id);
    if let Some(report) = &progress {
        report(
            "status",
            &format!(
                "Preparing the {} environment…\n",
                runtime_name_for_progress(language)
            ),
        );
    }
    tauri::async_runtime::spawn_blocking(move || {
        setup_kernel_integration_with_progress_impl(
            &root,
            language,
            environment.as_deref(),
            progress,
        )
    })
    .await
    .map_err(|error| HostError::Integration(format!("The kernel setup task failed: {error}")))?
}

#[tauri::command]
fn execution_trust_status(
    root: String,
    state: tauri::State<'_, ExecutionTrustStore>,
) -> Result<ExecutionTrustStatus, HostError> {
    execution_trust_status_impl(&root, &state)
}

#[tauri::command]
fn trust_project_for_session(
    root: String,
    acknowledgement: String,
    state: tauri::State<'_, ExecutionTrustStore>,
) -> Result<ExecutionTrustStatus, HostError> {
    trust_project_for_session_impl(&root, &acknowledgement, &state)
}

#[tauri::command]
fn revoke_project_trust(
    root: String,
    state: tauri::State<'_, ExecutionTrustStore>,
) -> Result<ExecutionTrustStatus, HostError> {
    revoke_project_trust_impl(&root, &state)
}

#[tauri::command]
fn fingerprint_execution_inputs(
    root: String,
    paths: Vec<String>,
) -> Result<Vec<ExecutionInput>, HostError> {
    fingerprint_execution_inputs_impl(&root, paths)
}

#[tauri::command]
fn inspect_execution_artifacts(
    root: String,
    paths: Vec<String>,
) -> Result<Vec<ExecutionArtifactFingerprint>, HostError> {
    inspect_execution_artifacts_impl(&root, paths)
}

#[tauri::command]
async fn execute_kernel(
    request: KernelExecutionRequest,
    trust: tauri::State<'_, ExecutionTrustStore>,
    kernels: tauri::State<'_, KernelProcessRegistry>,
) -> Result<KernelExecutionResult, HostError> {
    let trust = trust.inner().clone();
    let kernels = kernels.inner().clone();
    tauri::async_runtime::spawn_blocking(move || execute_kernel_impl(request, &trust, &kernels))
        .await
        .map_err(|error| {
            HostError::Integration(format!("The Jupyter runner task failed: {error}"))
        })?
}

#[tauri::command]
async fn interrupt_kernel(
    language: RuntimeLanguage,
    kernels: tauri::State<'_, KernelProcessRegistry>,
) -> Result<bool, HostError> {
    let kernels = kernels.inner().clone();
    tauri::async_runtime::spawn_blocking(move || interrupt_kernel_impl(language, &kernels))
        .await
        .map_err(|error| {
            HostError::Integration(format!("The Jupyter interrupt task failed: {error}"))
        })?
}

#[tauri::command]
async fn restart_kernel(
    language: RuntimeLanguage,
    kernels: tauri::State<'_, KernelProcessRegistry>,
) -> Result<bool, HostError> {
    let kernels = kernels.inner().clone();
    tauri::async_runtime::spawn_blocking(move || restart_kernel_impl(language, &kernels))
        .await
        .map_err(|error| {
            HostError::Integration(format!("The Jupyter restart task failed: {error}"))
        })?
}

#[tauri::command]
async fn terminate_kernel(
    language: RuntimeLanguage,
    kernels: tauri::State<'_, KernelProcessRegistry>,
) -> Result<bool, HostError> {
    let kernels = kernels.inner().clone();
    tauri::async_runtime::spawn_blocking(move || terminate_kernel_impl(language, &kernels))
        .await
        .map_err(|error| {
            HostError::Integration(format!("The Jupyter terminate task failed: {error}"))
        })?
}

#[tauri::command]
fn read_execution_manifests(root: String) -> Result<Vec<DocumentSnapshot>, HostError> {
    read_execution_manifests_impl(&root)
}

#[tauri::command]
fn save_execution_manifest(
    request: SaveExecutionManifestRequest,
) -> Result<DocumentSnapshot, HostError> {
    save_execution_manifest_impl(request)
}

#[tauri::command]
async fn list_julia_packages(
    app: tauri::AppHandle,
    root: String,
    task_id: Option<String>,
    trust: tauri::State<'_, ExecutionTrustStore>,
) -> Result<JuliaEnvironment, HostError> {
    let trust = trust.inner().clone();
    let progress = task_progress_reporter(app, task_id);
    tauri::async_runtime::spawn_blocking(move || {
        list_julia_packages_with_progress_impl(&root, &trust, progress)
    })
    .await
    .map_err(|error| HostError::Integration(format!("The Julia package task failed: {error}")))?
}

#[tauri::command]
async fn add_julia_package(
    app: tauri::AppHandle,
    request: JuliaPackageRequest,
    task_id: Option<String>,
    trust: tauri::State<'_, ExecutionTrustStore>,
) -> Result<JuliaEnvironment, HostError> {
    let trust = trust.inner().clone();
    let progress = task_progress_reporter(app, task_id);
    tauri::async_runtime::spawn_blocking(move || {
        add_julia_package_with_progress_impl(request, &trust, progress)
    })
    .await
    .map_err(|error| HostError::Integration(format!("The Julia package task failed: {error}")))?
}

#[tauri::command]
async fn remove_julia_package(
    app: tauri::AppHandle,
    request: JuliaPackageRequest,
    task_id: Option<String>,
    trust: tauri::State<'_, ExecutionTrustStore>,
) -> Result<JuliaEnvironment, HostError> {
    let trust = trust.inner().clone();
    let progress = task_progress_reporter(app, task_id);
    tauri::async_runtime::spawn_blocking(move || {
        remove_julia_package_with_progress_impl(request, &trust, progress)
    })
    .await
    .map_err(|error| HostError::Integration(format!("The Julia package task failed: {error}")))?
}

#[tauri::command]
async fn format_julia_code(
    request: JuliaFormatRequest,
    trust: tauri::State<'_, ExecutionTrustStore>,
) -> Result<JuliaFormatResult, HostError> {
    let trust = trust.inner().clone();
    tauri::async_runtime::spawn_blocking(move || format_julia_code_impl(request, &trust))
        .await
        .map_err(|error| {
            HostError::Integration(format!("The Julia formatter task failed: {error}"))
        })?
}

#[tauri::command]
async fn probe_code_formatter(
    request: CodeFormatterRequest,
    trust: tauri::State<'_, ExecutionTrustStore>,
) -> Result<CodeFormatterStatus, HostError> {
    let trust = trust.inner().clone();
    tauri::async_runtime::spawn_blocking(move || probe_code_formatter_impl(request, &trust))
        .await
        .map_err(|error| HostError::Integration(format!("The formatter probe failed: {error}")))?
}

#[tauri::command]
async fn install_code_formatter(
    app: tauri::AppHandle,
    request: CodeFormatterRequest,
    task_id: Option<String>,
    trust: tauri::State<'_, ExecutionTrustStore>,
) -> Result<CodeFormatterStatus, HostError> {
    let trust = trust.inner().clone();
    let progress = task_progress_reporter(app, task_id);
    tauri::async_runtime::spawn_blocking(move || {
        install_code_formatter_with_progress_impl(request, &trust, progress)
    })
    .await
    .map_err(|error| HostError::Integration(format!("The formatter setup failed: {error}")))?
}

#[tauri::command]
async fn format_code(
    request: CodeFormatRequest,
    trust: tauri::State<'_, ExecutionTrustStore>,
) -> Result<CodeFormatResult, HostError> {
    let trust = trust.inner().clone();
    tauri::async_runtime::spawn_blocking(move || format_code_impl(request, &trust))
        .await
        .map_err(|error| HostError::Integration(format!("The formatter task failed: {error}")))?
}

#[tauri::command]
fn git_status(root: String) -> Result<GitRepositoryStatus, HostError> {
    git_status_impl(&root)
}

#[tauri::command]
fn git_initialize(root: String) -> Result<GitInitializeResult, HostError> {
    git_initialize_impl(&root)
}

#[tauri::command]
fn git_diff(request: GitDiffRequest) -> Result<GitDiffResult, HostError> {
    git_diff_impl(request)
}

#[tauri::command]
fn git_history(root: String) -> Result<Vec<GitHistoryEntry>, HostError> {
    git_history_impl(&root)
}

#[tauri::command]
fn git_checkpoint_diff(
    request: GitCheckpointDiffRequest,
) -> Result<GitCheckpointDiffResult, HostError> {
    git_checkpoint_diff_impl(request)
}

#[tauri::command]
fn git_restore_checkpoint(
    request: GitRestoreCheckpointRequest,
) -> Result<GitRepositoryStatus, HostError> {
    git_restore_checkpoint_impl(request)
}

#[tauri::command]
fn git_stage(request: GitStageRequest) -> Result<GitRepositoryStatus, HostError> {
    git_stage_impl(request)
}

#[tauri::command]
fn git_create_commit(request: GitCommitRequest) -> Result<GitCommitResult, HostError> {
    git_create_commit_impl(request)
}

#[tauri::command]
fn git_create_checkpoint(request: GitCheckpointRequest) -> Result<GitCommitResult, HostError> {
    git_create_checkpoint_impl(request)
}

#[tauri::command]
fn git_branches(root: String) -> Result<GitBranchStatus, HostError> {
    git_branches_impl(&root)
}

#[tauri::command]
fn git_create_branch(request: GitBranchRequest) -> Result<GitBranchStatus, HostError> {
    git_create_branch_impl(request)
}

#[tauri::command]
fn git_switch_branch(request: GitBranchRequest) -> Result<GitBranchStatus, HostError> {
    git_switch_branch_impl(request)
}

#[tauri::command]
fn git_fetch(request: GitRemoteRequest) -> Result<GitRemoteResult, HostError> {
    git_fetch_impl(request)
}

#[tauri::command]
fn git_pull(request: GitRemoteRequest) -> Result<GitRemoteResult, HostError> {
    git_pull_impl(request)
}

#[tauri::command]
fn git_push(request: GitRemoteRequest) -> Result<GitRemoteResult, HostError> {
    git_push_impl(request)
}

#[tauri::command]
fn probe_external_export_tools() -> ExternalExportTools {
    probe_external_export_tools_impl()
}

#[tauri::command]
fn render_external_export(
    request: ExternalExportRequest,
) -> Result<ExternalExportResult, HostError> {
    render_external_export_impl(request)
}

#[tauri::command]
async fn render_external_export_to_file(
    app: tauri::AppHandle,
    request: ExternalExportRequest,
) -> Result<Option<ExternalExportResult>, HostError> {
    let extension = external_export_extension(request.format);
    let selected = app
        .dialog()
        .file()
        .set_title("Save rendered manuscript")
        .set_file_name(&request.output_name)
        .add_filter("Rendered manuscript", &[extension])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let mut destination = selected.into_path().map_err(|_| {
        HostError::InvalidPath(
            "The selected export destination is not a local file path.".to_string(),
        )
    })?;
    if destination.extension().is_none() {
        destination.set_extension(extension);
    }
    render_external_export_to_path_impl(request, &destination).map(Some)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ExecutionTrustStore::default())
        .manage(KernelProcessRegistry::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_project,
            create_project,
            read_document,
            read_bibliography,
            read_project_assets,
            read_citation_lock,
            read_citation_cache,
            save_citation_lock,
            save_document,
            save_export_file,
            print_publication,
            acquire_citations,
            document_status,
            set_main_document,
            set_citation_preferences,
            set_execution_preferences,
            zotero_status,
            zotero_search,
            zotero_item_attachments,
            crossref_search,
            resolve_doi_csl,
            open_scholar_search,
            open_citation_link,
            probe_runtime_executable,
            discover_jupyter_kernels,
            setup_kernel_integration,
            execution_trust_status,
            trust_project_for_session,
            revoke_project_trust,
            fingerprint_execution_inputs,
            inspect_execution_artifacts,
            execute_kernel,
            interrupt_kernel,
            restart_kernel,
            terminate_kernel,
            read_execution_manifests,
            save_execution_manifest,
            list_julia_packages,
            add_julia_package,
            remove_julia_package,
            format_julia_code,
            probe_code_formatter,
            install_code_formatter,
            format_code,
            git_status,
            git_initialize,
            git_diff,
            git_history,
            git_checkpoint_diff,
            git_restore_checkpoint,
            git_stage,
            git_create_commit,
            git_create_checkpoint,
            git_branches,
            git_create_branch,
            git_switch_branch,
            git_fetch,
            git_pull,
            git_push,
            probe_external_export_tools,
            render_external_export,
            render_external_export_to_file
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

    fn acquisition_record(id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "type": "article-journal",
            "title": "DynACof: A process-based model",
            "author": [{"family": "Vezy", "given": "Remi"}],
            "issued": {"date-parts": [[2020]]},
            "DOI": "10.1016/j.envsoft.2019.104609",
            "_draftmatter": {
                "provider": "crossref",
                "providerId": "10.1016/j.envsoft.2019.104609"
            }
        })
    }

    fn acquisition_request(
        root: &Path,
        expected_bibliography_hash: Option<String>,
    ) -> AcquireCitationsRequest {
        let document = fs::read(root.join("paper.qmd")).unwrap();
        let lock = fs::read(root.join(".draftmatter/citations.lock.json")).unwrap();
        let cache = fs::read(root.join(".draftmatter/cited-records.json")).unwrap();
        AcquireCitationsRequest {
            root: root.to_string_lossy().into_owned(),
            document_path: "paper.qmd".to_string(),
            document_content: "---\nbibliography: references.json\n---\n\nCited [@vezy2020dynacof].\n".to_string(),
            expected_document_hash: source_hash(&document),
            bibliography_path: "references.json".to_string(),
            expected_bibliography_hash,
            bibliography_records: vec![acquisition_record("vezy2020dynacof")],
            lock_content: "{\"schemaVersion\":1,\"entries\":[{\"citekey\":\"vezy2020dynacof\",\"source\":{\"provider\":\"crossref\",\"doi\":\"10.1016/j.envsoft.2019.104609\"},\"aliases\":[],\"identifiers\":{\"doi\":\"10.1016/j.envsoft.2019.104609\"}}]}\n".to_string(),
            expected_lock_hash: Some(source_hash(&lock)),
            cache_content: "{\"schemaVersion\":1,\"records\":[{\"citekey\":\"vezy2020dynacof\",\"type\":\"article\",\"title\":\"DynACof: A process-based model\",\"authors\":[\"Remi Vezy\"],\"year\":\"2020\",\"doi\":\"10.1016/j.envsoft.2019.104609\",\"source\":\"crossref\"}]}\n".to_string(),
            expected_cache_hash: Some(source_hash(&cache)),
        }
    }

    fn prepare_acquisition_project(root: &Path) {
        fs::create_dir_all(root.join(".draftmatter")).unwrap();
        fs::write(
            root.join("paper.qmd"),
            "---\ntitle: Test\n---\n\nNo citation.\n",
        )
        .unwrap();
        fs::write(
            root.join(".draftmatter/citations.lock.json"),
            "{\"schemaVersion\":1,\"entries\":[]}\n",
        )
        .unwrap();
        fs::write(
            root.join(".draftmatter/cited-records.json"),
            "{\"schemaVersion\":1,\"records\":[]}\n",
        )
        .unwrap();
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
    fn builds_only_bounded_crossref_routes() {
        let structured = CrossrefSearchRequest {
            author: Some("vezy".into()),
            title: Some("DynACof".into()),
            from_publication_date: Some("2020-01-01".into()),
            until_publication_date: Some("2020-12-31".into()),
            ..CrossrefSearchRequest::default()
        };
        let (url, query) = crossref_request_parts(&structured).unwrap();
        assert_eq!(url, CROSSREF_WORKS_URL);
        assert!(query.contains(&("query.author", "vezy".into())));
        assert!(query.contains(&("query.title", "DynACof".into())));
        assert!(query.contains(&(
            "filter",
            "from-pub-date:2020-01-01,until-pub-date:2020-12-31".into()
        )));
        let (_, polite_query) =
            crossref_request_parts_with_mailto(&structured, Some("maintainer@example.org"))
                .unwrap();
        assert!(polite_query.contains(&("mailto", "maintainer@example.org".into())));

        let (doi_url, doi_query) = crossref_request_parts(&CrossrefSearchRequest {
            doi: Some("10.1016/j.envsoft.2019.104609".into()),
            ..CrossrefSearchRequest::default()
        })
        .unwrap();
        assert_eq!(
            doi_url,
            "https://api.crossref.org/works/10.1016%2Fj.envsoft.2019.104609"
        );
        assert!(doi_query.is_empty());

        assert!(crossref_request_parts(&CrossrefSearchRequest {
            doi: Some("https://elsewhere.example/work".into()),
            ..CrossrefSearchRequest::default()
        })
        .is_err());
        assert!(crossref_request_parts(&CrossrefSearchRequest {
            bibliographic: Some("x".repeat(513)),
            ..CrossrefSearchRequest::default()
        })
        .is_err());
    }

    #[test]
    fn builds_only_an_explicit_google_scholar_search_url() {
        assert_eq!(
            scholar_search_url("vezy et al. 2020 DynACof").unwrap(),
            "https://scholar.google.com/scholar?q=vezy%20et%20al.%202020%20DynACof"
        );
        assert!(scholar_search_url("   ").is_err());
        assert!(scholar_search_url(&"x".repeat(513)).is_err());
    }

    #[test]
    fn opens_only_bounded_typed_citation_links() {
        assert_eq!(
            citation_link_url(
                CitationLinkKind::Doi,
                "https://doi.org/10.1016/J.ENVSOFT.2019.104609"
            )
            .unwrap(),
            "https://doi.org/10.1016%2Fj.envsoft.2019.104609"
        );
        assert_eq!(
            citation_link_url(
                CitationLinkKind::RecordUrl,
                "https://publisher.example/article?id=42"
            )
            .unwrap(),
            "https://publisher.example/article?id=42"
        );
        assert_eq!(
            citation_link_url(CitationLinkKind::ZoteroItem, "PXW99EKT").unwrap(),
            "zotero://select/library/items/PXW99EKT"
        );
        assert_eq!(
            citation_link_url(CitationLinkKind::ZoteroAttachment, "ATTACH01").unwrap(),
            "zotero://open-pdf/library/items/ATTACH01"
        );
        assert!(citation_link_url(CitationLinkKind::RecordUrl, "javascript:alert(1)").is_err());
        assert!(citation_link_url(
            CitationLinkKind::RecordUrl,
            "https://user:secret@publisher.example/article"
        )
        .is_err());
        assert!(citation_link_url(CitationLinkKind::ZoteroItem, "../PXW99EKT").is_err());
    }

    #[test]
    fn bounds_and_validates_doi_csl_content_negotiation() {
        assert_eq!(
            doi_csl_request_url("https://doi.org/10.1016/J.ENVSOFT.2019.104609").unwrap(),
            "https://doi.org/10.1016%2Fj.envsoft.2019.104609"
        );
        assert!(doi_csl_request_url("https://example.org/not-a-doi").is_err());
        assert_eq!(
            parse_doi_csl_response(br#"{"title":"DynACof","DOI":"10.1016/j.envsoft.2019.104609"}"#)
                .unwrap()["title"],
            "DynACof"
        );
        assert_eq!(
            parse_doi_csl_response(br#"[]"#).unwrap_err().kind,
            "invalid-response"
        );
    }

    #[test]
    fn citation_acquisition_is_idempotent_by_doi_and_provider_identity() {
        let temporary = tempdir().unwrap();
        let root = temporary.path();
        prepare_acquisition_project(root);

        let first = acquire_citations_impl(acquisition_request(root, None)).unwrap();
        assert_eq!(first.acquired, 1);
        assert_eq!(first.unchanged, 0);
        assert!(fs::read_to_string(root.join("paper.qmd"))
            .unwrap()
            .contains("@vezy2020dynacof"));
        let bibliography = fs::read_to_string(root.join("references.json")).unwrap();
        assert_eq!(
            bibliography
                .matches("10.1016/j.envsoft.2019.104609")
                .count(),
            2
        );
        assert_eq!(
            open_project_impl(root.to_str().unwrap())
                .unwrap()
                .config
                .citation_bibliography
                .as_deref(),
            Some("references.json")
        );

        let mut repeated = acquisition_request(root, Some(first.bibliography_hash.clone()));
        repeated.expected_document_hash = first.document_hash;
        repeated.expected_lock_hash = Some(first.lock_hash);
        repeated.expected_cache_hash = Some(first.cache_hash);
        let second = acquire_citations_impl(repeated).unwrap();
        assert_eq!(second.acquired, 0);
        assert_eq!(second.unchanged, 1);
        assert_eq!(
            fs::read_to_string(root.join("references.json")).unwrap(),
            bibliography
        );

        let mut conflicting = acquisition_request(root, Some(second.bibliography_hash));
        conflicting.expected_document_hash = second.document_hash;
        conflicting.expected_lock_hash = Some(second.lock_hash);
        conflicting.expected_cache_hash = Some(second.cache_hash);
        conflicting.bibliography_records = vec![acquisition_record("anotherKey")];
        assert!(matches!(
            acquire_citations_impl(conflicting),
            Err(HostError::Conflict(_))
        ));
    }

    #[test]
    fn every_injected_acquisition_failure_rolls_all_project_files_back() {
        for fail_after in 1..=5 {
            let temporary = tempdir().unwrap();
            let root = temporary.path();
            prepare_acquisition_project(root);
            let before_document = fs::read(root.join("paper.qmd")).unwrap();
            let before_lock = fs::read(root.join(".draftmatter/citations.lock.json")).unwrap();
            let before_cache = fs::read(root.join(".draftmatter/cited-records.json")).unwrap();

            assert!(acquire_citations_impl_with_fault(
                acquisition_request(root, None),
                Some(fail_after)
            )
            .is_err());
            assert_eq!(fs::read(root.join("paper.qmd")).unwrap(), before_document);
            assert_eq!(
                fs::read(root.join(".draftmatter/citations.lock.json")).unwrap(),
                before_lock
            );
            assert_eq!(
                fs::read(root.join(".draftmatter/cited-records.json")).unwrap(),
                before_cache
            );
            assert!(!root.join("references.json").exists());
            assert!(!root.join(".draftmatter/project.json").exists());
            assert!(fs::read_dir(root.join(".draftmatter/transactions"))
                .unwrap()
                .next()
                .is_none());
        }
    }

    #[test]
    fn project_open_discards_an_unprepared_acquisition_directory_safely() {
        let temporary = tempdir().unwrap();
        let root = temporary.path();
        prepare_acquisition_project(root);
        let orphan = root.join(".draftmatter/transactions/unprepared");
        fs::create_dir_all(&orphan).unwrap();
        fs::write(orphan.join("backup-0.bin"), b"unused").unwrap();

        assert!(open_project_impl(root.to_str().unwrap()).is_ok());
        assert!(!orphan.exists());
        assert_eq!(
            fs::read_to_string(root.join("paper.qmd")).unwrap(),
            "---\ntitle: Test\n---\n\nNo citation.\n"
        );
    }

    #[test]
    fn normalizes_crossref_list_and_doi_responses() {
        let list = br#"{
          "message": {
            "items": [{
              "DOI": "10.1016/j.envsoft.2019.104609",
              "title": ["DynACof: a process-based model"],
              "author": [{"family":"Vezy","given":"Remi"}],
              "published": {"date-parts":[[2020,1,1]]},
              "container-title": ["Environmental Modelling & Software"],
              "type": "journal-article",
              "URL": "https://doi.org/10.1016/j.envsoft.2019.104609",
              "score": 12.5
            }]
          }
        }"#;
        let parsed = parse_crossref_response(list).unwrap();
        assert_eq!(parsed.works.len(), 1);
        assert_eq!(parsed.works[0].authors[0].family, "Vezy");
        assert_eq!(parsed.works[0].year, Some(2020));
        assert_eq!(parsed.works[0].provider_score, Some(12.5));

        let single = br#"{"message":{"DOI":"10.1000/one","title":["One"],"type":"book"}}"#;
        assert_eq!(
            parse_crossref_response(single).unwrap().works[0].title,
            "One"
        );
        assert_eq!(
            parse_crossref_response(br#"{"status":"ok"}"#)
                .unwrap_err()
                .kind,
            "invalid-response"
        );
    }

    #[test]
    fn creates_and_discovers_a_project_without_running_content() {
        let temporary = tempdir().unwrap();
        fs::write(temporary.path().join("another-download.txt"), "keep me").unwrap();
        let snapshot = create_project(
            temporary.path().to_string_lossy().into_owned(),
            "Canopy study".into(),
            Some(NewProjectAuthor {
                name: "Alice Martin".into(),
                orcid: Some("0000-0002-1825-0097".into()),
                affiliations: vec!["Plant Research Institute".into()],
            }),
        )
        .unwrap();
        let root = temporary.path().join("Canopy study");
        assert_eq!(
            snapshot.root,
            fs::canonicalize(&root).unwrap().to_string_lossy()
        );
        assert_eq!(snapshot.config.main_document, "paper.qmd");
        assert_eq!(snapshot.config.citation_style, "draftmatter-author-date");
        assert_eq!(snapshot.config.citation_locale, "en-US");
        assert_eq!(snapshot.documents.len(), 1);
        assert_eq!(snapshot.documents[0].path, "paper.qmd");
        assert!(root.join(".draftmatter/project.json").is_file());
        let starter = fs::read_to_string(root.join("paper.qmd")).unwrap();
        let section_blocks = [
            (
                "Abstract",
                "This starter abstract introduces the research question",
            ),
            (
                "Introduction",
                "Introduce the topic, explain why it matters",
            ),
            (
                "Methods",
                "Describe the study design, materials, measurements",
            ),
            (
                "Results",
                "Report the observations that answer the research question",
            ),
            (
                "Discussion",
                "Interpret the main findings in relation to the research question",
            ),
            ("Conclusion", "Summarize what the findings mean"),
        ];
        for (heading, paragraph_start) in section_blocks {
            assert!(starter.contains(&format!("## {heading}\n\n{paragraph_start}")));
        }
        assert_eq!(
            starter
                .lines()
                .filter(|line| line.starts_with("## "))
                .count(),
            6
        );
        assert!(starter.contains("author:\n  - name: \"Alice Martin\""));
        assert!(starter.contains("orcid: \"0000-0002-1825-0097\""));
        assert!(starter.contains("- \"Plant Research Institute\""));
        assert_eq!(
            fs::read_to_string(temporary.path().join("another-download.txt")).unwrap(),
            "keep me"
        );
    }

    #[test]
    fn persists_valid_citation_preferences_and_rejects_unknown_values() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join("citation-preferences");
        create_project_at_root(&root, "Citations").unwrap();

        let updated =
            set_citation_preferences_impl(root.to_str().unwrap(), "draftmatter-numeric", "fr-FR")
                .unwrap();
        assert_eq!(updated.config.citation_style, "draftmatter-numeric");
        assert_eq!(updated.config.citation_locale, "fr-FR");
        assert_eq!(
            open_project_impl(root.to_str().unwrap()).unwrap().config,
            updated.config
        );

        let error = set_citation_preferences_impl(root.to_str().unwrap(), "remote-style", "fr-FR")
            .unwrap_err();
        assert!(matches!(error, HostError::InvalidProject(_)));
    }

    #[test]
    fn persists_valid_execution_preferences_and_rejects_unsafe_kernel_names() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join("execution-preferences");
        create_project_at_root(&root, "Execution").unwrap();
        let preferences = ProjectExecutionPreferences {
            python: ProjectExecutionLanguagePreferences {
                kernel: Some("python-research-3".to_string()),
                environment: Some(".venv".to_string()),
            },
            r: ProjectExecutionLanguagePreferences {
                kernel: Some("ir-4.5".to_string()),
                environment: None,
            },
            julia: ProjectExecutionLanguagePreferences::default(),
        };

        let updated =
            set_execution_preferences_impl(root.to_str().unwrap(), preferences.clone()).unwrap();
        assert_eq!(updated.config.execution, preferences);
        assert_eq!(
            open_project_impl(root.to_str().unwrap())
                .unwrap()
                .config
                .execution,
            preferences
        );

        let before = fs::read(root.join(".draftmatter/project.json")).unwrap();
        let error = set_execution_preferences_impl(
            root.to_str().unwrap(),
            ProjectExecutionPreferences {
                python: ProjectExecutionLanguagePreferences {
                    kernel: Some("../outside".to_string()),
                    environment: None,
                },
                ..ProjectExecutionPreferences::default()
            },
        )
        .unwrap_err();
        assert!(matches!(error, HostError::InvalidProject(_)));
        assert_eq!(
            fs::read(root.join(".draftmatter/project.json")).unwrap(),
            before
        );
    }

    #[test]
    fn refuses_to_create_a_project_over_existing_files() {
        let temporary = tempdir().unwrap();
        let existing = temporary.path().join("Unsafe");
        fs::create_dir(&existing).unwrap();
        fs::write(existing.join("notes.txt"), "keep me").unwrap();
        let error = create_project(
            temporary.path().to_string_lossy().into_owned(),
            "Unsafe".into(),
            None,
        )
        .unwrap_err();
        assert!(matches!(error, HostError::InvalidProject(_)));
        assert_eq!(
            fs::read_to_string(existing.join("notes.txt")).unwrap(),
            "keep me"
        );
    }

    #[test]
    fn derives_a_portable_child_folder_without_changing_the_project_name() {
        let temporary = tempdir().unwrap();
        let snapshot = create_project(
            temporary.path().to_string_lossy().into_owned(),
            "  Canopy: water / 2026  ".into(),
            None,
        )
        .unwrap();

        assert_eq!(snapshot.config.name, "Canopy: water / 2026");
        assert_eq!(
            Path::new(&snapshot.root)
                .file_name()
                .and_then(OsStr::to_str),
            Some("Canopy- water - 2026")
        );
        assert_eq!(portable_project_folder_name("CON").unwrap(), "CON project");
        assert!(portable_project_folder_name("...").is_err());
    }

    #[test]
    fn saves_with_expected_hash_and_preserves_a_recovery() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join("project");
        create_project_at_root(&root, "Test").unwrap();
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
        create_project_at_root(&root, "Test").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{vezy2024, title={Portable research}}",
        )
        .unwrap();
        fs::write(root.join("library.ris"), "TY  - JOUR\nER  -\n").unwrap();
        fs::write(root.join("export.enw"), "%0 Journal Article\n%T Portable\n").unwrap();

        let bibliography =
            read_bibliography_impl(root.to_str().unwrap(), "references.bib").unwrap();
        assert!(bibliography.content.contains("vezy2024"));
        assert!(read_bibliography_impl(root.to_str().unwrap(), "library.ris").is_ok());
        assert!(read_bibliography_impl(root.to_str().unwrap(), "export.enw").is_ok());
        let discovered = open_project_impl(root.to_str().unwrap()).unwrap();
        assert_eq!(
            discovered
                .bibliographies
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["export.enw", "library.ris", "references.bib"]
        );
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
    fn reads_only_supported_submission_assets_inside_the_project() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join("project");
        create_project_at_root(&root, "Test").unwrap();
        fs::create_dir_all(root.join("figures")).unwrap();
        fs::write(root.join("figures/canopy.png"), b"png-fixture").unwrap();
        fs::write(root.join("figures/data.csv"), b"x,y\n1,2\n").unwrap();

        let assets =
            read_project_assets_impl(root.to_str().unwrap(), &["figures/canopy.png".to_string()])
                .unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].path, "figures/canopy.png");
        assert_eq!(assets[0].bytes, b"png-fixture");
        assert_eq!(assets[0].media_type, "image/png");
        assert!(matches!(
            read_project_assets_impl(root.to_str().unwrap(), &["../outside.png".to_string()]),
            Err(HostError::InvalidPath(_))
        ));
        assert!(matches!(
            read_project_assets_impl(root.to_str().unwrap(), &["figures/data.csv".to_string()]),
            Err(HostError::UnsupportedFile(_))
        ));
    }

    #[test]
    fn persists_only_valid_citation_locks_atomically_and_detects_conflicts() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join("project");
        create_project_at_root(&root, "Test").unwrap();
        assert_eq!(
            read_citation_lock_impl(root.to_str().unwrap()).unwrap(),
            None
        );

        let content = "{\n  \"schemaVersion\": 1,\n  \"entries\": []\n}\n";
        let saved = save_citation_lock_impl(SaveCitationLockRequest {
            root: root.to_string_lossy().into_owned(),
            content: content.into(),
            expected_hash: None,
        })
        .unwrap();
        assert_eq!(saved.path, ".draftmatter/citations.lock.json");
        assert_eq!(saved.content, content);

        fs::write(
            root.join(".draftmatter/citations.lock.json"),
            "{\"schemaVersion\":1,\"entries\":[{\"external\":true}]}",
        )
        .unwrap();
        let conflict = save_citation_lock_impl(SaveCitationLockRequest {
            root: root.to_string_lossy().into_owned(),
            content: content.into(),
            expected_hash: Some(saved.hash),
        })
        .unwrap_err();
        assert!(matches!(conflict, HostError::Conflict(_)));
        assert!(
            fs::read_to_string(root.join(".draftmatter/citations.lock.json"))
                .unwrap()
                .contains("external")
        );

        let invalid = save_citation_lock_impl(SaveCitationLockRequest {
            root: root.to_string_lossy().into_owned(),
            content: "{\"schemaVersion\":2,\"entries\":[]}".into(),
            expected_hash: None,
        })
        .unwrap_err();
        assert!(matches!(invalid, HostError::InvalidProject(_)));
    }

    #[test]
    fn rejects_a_save_after_an_external_change() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join("project");
        create_project_at_root(&root, "Test").unwrap();
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
        create_project_at_root(&root, "Test").unwrap();
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
        create_project_at_root(&root, "Test").unwrap();
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
        create_project_at_root(&root, "Test").unwrap();

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
    fn lists_bounded_child_attachments_only_on_explicit_item_inspection() {
        let body = r#"[
          {"key":"ATTACH01","version":5,"data":{"itemType":"attachment","title":"Accepted manuscript","filename":"paper.pdf","contentType":"application/pdf","creators":[]}},
          {"key":"NOTE0001","version":2,"data":{"itemType":"note","title":"Reading note","creators":[]}}
        ]"#;
        let (address, server) = serve_zotero_once(body, "Zotero-API-Version: 3\r\n");
        let attachments = zotero_item_attachments_at(address, "PXW99EKT").unwrap();
        let request = server.join().unwrap();

        assert_eq!(attachments, vec![ZoteroAttachment {
            item_key: "ATTACH01".into(),
            title: "Accepted manuscript".into(),
            filename: Some("paper.pdf".into()),
            content_type: Some("application/pdf".into()),
        }]);
        assert!(request.starts_with(
            "GET /api/users/0/items/PXW99EKT/children?itemType=attachment&limit=25 HTTP/1.1\r\n"
        ));
        assert!(zotero_item_attachments_at(address, "../PXW99EKT").is_err());
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

    #[test]
    fn validates_and_atomically_writes_user_selected_generated_exports() {
        assert_eq!(
            generated_export_extension("paper.final.qmd").unwrap(),
            "qmd"
        );
        assert_eq!(
            generated_export_extension("paper-submission.zip").unwrap(),
            "zip"
        );
        assert!(generated_export_extension("../paper.qmd").is_err());
        assert!(generated_export_extension("paper.pdf").is_err());

        let directory = tempdir().unwrap();
        let path = directory.path().join("paper.docx");
        let result = save_generated_export_to_path(&path, "docx", b"word-package").unwrap();
        assert_eq!(result.bytes, 12);
        assert_eq!(fs::read(&path).unwrap(), b"word-package");
        assert!(
            save_generated_export_to_path(&directory.path().join("paper.html"), "docx", b"x")
                .is_err()
        );
    }
}

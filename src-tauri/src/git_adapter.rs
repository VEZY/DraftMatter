use crate::{canonical_root, safe_relative, slash_path, HostError};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const MAX_GIT_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
const MAX_STATUS_ENTRIES: usize = 10_000;
const MAX_SELECTED_PATHS: usize = 512;
const MAX_COMMIT_MESSAGE_BYTES: usize = 4_096;
const MAX_HISTORY_ENTRIES: usize = 50;

#[derive(Debug, Clone)]
struct RepositoryContext {
    project_root: PathBuf,
    repository_root: PathBuf,
    project_prefix: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryStatus {
    pub git_available: bool,
    pub git_version: Option<String>,
    pub repository: bool,
    pub repository_root: Option<String>,
    pub project_prefix: String,
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<GitStatusEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    pub original_path: Option<String>,
    pub kind: GitChangeKind,
    pub index_status: String,
    pub worktree_status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub conflicted: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GitChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffRequest {
    pub root: String,
    pub path: String,
    #[serde(default)]
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub path: String,
    pub staged: bool,
    pub text: String,
    pub binary: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryEntry {
    pub hash: String,
    pub short_hash: String,
    pub authored_at: String,
    pub author: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckpointDiffRequest {
    pub root: String,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckpointDiffResult {
    pub hash: String,
    pub text: String,
    pub truncated: bool,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRestoreCheckpointRequest {
    pub root: String,
    pub hash: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStageRequest {
    pub root: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRequest {
    pub root: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckpointRequest {
    pub root: String,
    pub paths: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitInitializeResult {
    pub repository_root: String,
    pub created_ignore: bool,
    pub status: GitRepositoryStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchStatus {
    pub current: Option<String>,
    pub detached: bool,
    pub branches: Vec<GitBranch>,
    pub remotes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchRequest {
    pub root: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteRequest {
    pub root: String,
    pub remote: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteResult {
    pub action: String,
    pub summary: String,
    pub status: GitRepositoryStatus,
}

fn empty_status(version: Option<String>) -> GitRepositoryStatus {
    GitRepositoryStatus {
        git_available: version.is_some(),
        git_version: version,
        repository: false,
        repository_root: None,
        project_prefix: String::new(),
        branch: None,
        detached: false,
        upstream: None,
        ahead: 0,
        behind: 0,
        entries: Vec::new(),
    }
}

fn git_command(current_dir: &Path) -> Command {
    let disabled_hooks = std::env::temp_dir().join(format!(
        "draftmatter-git-hooks-disabled-{}",
        std::process::id()
    ));
    let _ = fs::create_dir_all(&disabled_hooks);
    let mut command = Command::new("git");
    command
        .current_dir(current_dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_CONFIG_COUNT", "2")
        .env("GIT_CONFIG_KEY_0", "core.hooksPath")
        .env("GIT_CONFIG_VALUE_0", disabled_hooks)
        .env("GIT_CONFIG_KEY_1", "core.fsmonitor")
        .env("GIT_CONFIG_VALUE_1", "false")
        .env("LC_ALL", "C");
    command
}

fn sanitise_message(bytes: &[u8]) -> String {
    let mut message = String::from_utf8_lossy(bytes).trim().to_string();
    let mut search_from = 0;
    while let Some(relative_scheme) = message[search_from..].find("://") {
        let scheme = search_from + relative_scheme;
        let credentials_start = scheme + 3;
        let Some(relative_at) = message[credentials_start..].find('@') else {
            search_from = credentials_start;
            continue;
        };
        let at = credentials_start + relative_at;
        if message[credentials_start..at].contains('/') {
            search_from = credentials_start;
            continue;
        }
        message.replace_range(credentials_start..at, "[redacted]");
        search_from = credentials_start + "[redacted]@".len();
    }
    if message.len() > 4_096 {
        message.truncate(4_096);
        message.push_str("…");
    }
    if message.is_empty() {
        "Git did not provide an error message.".to_string()
    } else {
        message
    }
}

fn run_git(current_dir: &Path, arguments: &[&str]) -> Result<Output, HostError> {
    let output = git_command(current_dir)
        .args(arguments)
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                HostError::Integration(
                    "System Git is not installed or is not available on PATH.".to_string(),
                )
            } else {
                HostError::Io(format!("Could not start Git: {error}"))
            }
        })?;
    if output.stdout.len().saturating_add(output.stderr.len()) > MAX_GIT_OUTPUT_BYTES {
        return Err(HostError::Integration(
            "Git returned more than the 4 MB safety limit.".to_string(),
        ));
    }
    Ok(output)
}

fn require_success(output: Output, action: &str) -> Result<Output, HostError> {
    if output.status.success() {
        Ok(output)
    } else {
        Err(HostError::Integration(format!(
            "Git could not {action}: {}",
            sanitise_message(&output.stderr)
        )))
    }
}

fn git_version(root: &Path) -> Result<Option<String>, HostError> {
    match run_git(root, &["--version"]) {
        Ok(output) if output.status.success() => Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_string(),
        )),
        Ok(_) => Ok(None),
        Err(HostError::Integration(message)) if message.contains("not installed") => Ok(None),
        Err(error) => Err(error),
    }
}

fn repository_context(raw_root: &str) -> Result<Option<RepositoryContext>, HostError> {
    let project_root = canonical_root(raw_root)?;
    let output = run_git(&project_root, &["rev-parse", "--show-toplevel"])?;
    if !output.status.success() {
        return Ok(None);
    }
    let reported = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let repository_root = fs::canonicalize(&reported).map_err(|_| {
        HostError::InvalidProject("Git reported a repository root that does not exist.".to_string())
    })?;
    let project_prefix = project_root
        .strip_prefix(&repository_root)
        .map_err(|_| {
            HostError::InvalidProject(
                "The project folder is not contained by the repository Git reported.".to_string(),
            )
        })?
        .to_path_buf();
    Ok(Some(RepositoryContext {
        project_root,
        repository_root,
        project_prefix,
    }))
}

fn require_repository(raw_root: &str) -> Result<RepositoryContext, HostError> {
    repository_context(raw_root)?.ok_or_else(|| {
        HostError::InvalidProject(
            "This project is not inside a Git repository. Initialize it explicitly first."
                .to_string(),
        )
    })
}

fn project_pathspec(context: &RepositoryContext) -> String {
    if context.project_prefix.as_os_str().is_empty() {
        ".".to_string()
    } else {
        slash_path(&context.project_prefix)
    }
}

fn repository_path(context: &RepositoryContext, relative: &str) -> Result<String, HostError> {
    let safe = safe_relative(relative)?;
    Ok(slash_path(&context.project_prefix.join(safe)))
}

fn project_relative(context: &RepositoryContext, repository_path: &str) -> Option<String> {
    let path = Path::new(repository_path);
    let relative = if context.project_prefix.as_os_str().is_empty() {
        path
    } else {
        path.strip_prefix(&context.project_prefix).ok()?
    };
    if relative.as_os_str().is_empty() {
        None
    } else {
        Some(slash_path(relative))
    }
}

fn branch_name(context: &RepositoryContext) -> Result<Option<String>, HostError> {
    let output = run_git(
        &context.repository_root,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
    )?;
    if output.status.success() {
        Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_string(),
        ))
    } else {
        Ok(None)
    }
}

fn upstream_name(context: &RepositoryContext) -> Result<Option<String>, HostError> {
    let output = run_git(
        &context.repository_root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )?;
    if output.status.success() {
        Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_string(),
        ))
    } else {
        Ok(None)
    }
}

fn ahead_behind(
    context: &RepositoryContext,
    upstream: Option<&str>,
) -> Result<(u32, u32), HostError> {
    if upstream.is_none() {
        return Ok((0, 0));
    }
    let output = run_git(
        &context.repository_root,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )?;
    if !output.status.success() {
        return Ok((0, 0));
    }
    let values = String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .filter_map(|value| value.parse::<u32>().ok())
        .collect::<Vec<_>>();
    Ok((
        values.first().copied().unwrap_or(0),
        values.get(1).copied().unwrap_or(0),
    ))
}

fn conflict_pair(index: char, worktree: char) -> bool {
    matches!(
        (index, worktree),
        ('D', 'D') | ('A', 'U') | ('U', 'D') | ('U', 'A') | ('D', 'U') | ('A', 'A') | ('U', 'U')
    )
}

fn change_kind(index: char, worktree: char) -> GitChangeKind {
    if conflict_pair(index, worktree) {
        GitChangeKind::Conflicted
    } else if index == '?' && worktree == '?' {
        GitChangeKind::Untracked
    } else if index == 'R' || worktree == 'R' {
        GitChangeKind::Renamed
    } else if index == 'C' || worktree == 'C' {
        GitChangeKind::Copied
    } else if index == 'A' || worktree == 'A' {
        GitChangeKind::Added
    } else if index == 'D' || worktree == 'D' {
        GitChangeKind::Deleted
    } else {
        GitChangeKind::Modified
    }
}

fn file_looks_binary(path: &Path) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut bytes = [0_u8; 8_192];
    let Ok(read) = file.read(&mut bytes) else {
        return false;
    };
    bytes[..read].contains(&0)
}

fn diff_reports_binary(
    context: &RepositoryContext,
    repository_path: &str,
    staged: bool,
) -> Result<bool, HostError> {
    let mut arguments = vec!["diff", "--numstat"];
    if staged {
        arguments.push("--cached");
    }
    arguments.extend(["--", repository_path]);
    let output = run_git(&context.repository_root, &arguments)?;
    Ok(output.status.success()
        && String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.starts_with("-\t-\t")))
}

fn entry_binary(
    context: &RepositoryContext,
    project_path: &str,
    repository_path: &str,
    index: char,
) -> Result<bool, HostError> {
    if file_looks_binary(&context.project_root.join(project_path)) {
        return Ok(true);
    }
    diff_reports_binary(context, repository_path, false).and_then(|binary| {
        if binary || index == ' ' || index == '?' {
            Ok(binary)
        } else {
            diff_reports_binary(context, repository_path, true)
        }
    })
}

fn status_entries(context: &RepositoryContext) -> Result<Vec<GitStatusEntry>, HostError> {
    let pathspec = project_pathspec(context);
    let output = require_success(
        run_git(
            &context.repository_root,
            &[
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--",
                &pathspec,
            ],
        )?,
        "read repository status",
    )?;
    let records = output.stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut entries = Vec::new();
    let mut cursor = 0;
    while cursor < records.len() {
        let record = records[cursor];
        cursor += 1;
        if record.is_empty() {
            continue;
        }
        if record.len() < 4 || record[2] != b' ' {
            return Err(HostError::Integration(
                "Git returned an unreadable status record.".to_string(),
            ));
        }
        if entries.len() >= MAX_STATUS_ENTRIES {
            return Err(HostError::Integration(
                "Repository status exceeds the 10,000 item safety limit.".to_string(),
            ));
        }
        let index = record[0] as char;
        let worktree = record[1] as char;
        let repository_path = String::from_utf8_lossy(&record[3..]).to_string();
        let renamed = index == 'R' || index == 'C' || worktree == 'R' || worktree == 'C';
        let original_repository_path = if renamed {
            let value = records.get(cursor).copied().unwrap_or_default();
            cursor += 1;
            Some(String::from_utf8_lossy(value).to_string())
        } else {
            None
        };
        let Some(path) = project_relative(context, &repository_path) else {
            continue;
        };
        let kind = change_kind(index, worktree);
        entries.push(GitStatusEntry {
            binary: entry_binary(context, &path, &repository_path, index)?,
            path,
            original_path: original_repository_path
                .as_deref()
                .and_then(|value| project_relative(context, value)),
            kind,
            index_status: index.to_string(),
            worktree_status: worktree.to_string(),
            staged: index != ' ' && index != '?',
            unstaged: worktree != ' ',
            conflicted: conflict_pair(index, worktree),
        });
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

pub fn git_status_impl(raw_root: &str) -> Result<GitRepositoryStatus, HostError> {
    let root = canonical_root(raw_root)?;
    let version = git_version(&root)?;
    if version.is_none() {
        return Ok(empty_status(None));
    }
    let Some(context) = repository_context(raw_root)? else {
        return Ok(empty_status(version));
    };
    let branch = branch_name(&context)?;
    let upstream = upstream_name(&context)?;
    let (ahead, behind) = ahead_behind(&context, upstream.as_deref())?;
    Ok(GitRepositoryStatus {
        git_available: true,
        git_version: version,
        repository: true,
        repository_root: Some(context.repository_root.to_string_lossy().to_string()),
        project_prefix: slash_path(&context.project_prefix),
        detached: branch.is_none(),
        branch,
        upstream,
        ahead,
        behind,
        entries: status_entries(&context)?,
    })
}

pub fn git_initialize_impl(raw_root: &str) -> Result<GitInitializeResult, HostError> {
    let root = canonical_root(raw_root)?;
    if repository_context(raw_root)?.is_some() {
        return Err(HostError::Conflict(
            "This project is already inside a Git repository.".to_string(),
        ));
    }
    require_success(run_git(&root, &["init"])?, "initialize the repository")?;
    let ignore_path = root.join(".gitignore");
    let created_ignore = if ignore_path.exists() {
        false
    } else {
        fs::write(
            &ignore_path,
            ".draftmatter/cache/\n.draftmatter/recovery/\n.draftmatter/kernels/\n",
        )?;
        true
    };
    Ok(GitInitializeResult {
        repository_root: root.to_string_lossy().to_string(),
        created_ignore,
        status: git_status_impl(raw_root)?,
    })
}

pub fn git_diff_impl(request: GitDiffRequest) -> Result<GitDiffResult, HostError> {
    let context = require_repository(&request.root)?;
    let repository_path = repository_path(&context, &request.path)?;
    let mut arguments = vec!["diff", "--no-ext-diff", "--no-color", "--unified=3"];
    if request.staged {
        arguments.push("--cached");
    }
    arguments.extend(["--", &repository_path]);
    let output = require_success(
        run_git(&context.repository_root, &arguments)?,
        "read the selected diff",
    )?;
    let binary = String::from_utf8_lossy(&output.stdout).contains("Binary files ");
    let truncated = output.stdout.len() > MAX_DIFF_BYTES;
    let bytes = &output.stdout[..output.stdout.len().min(MAX_DIFF_BYTES)];
    let mut text = String::from_utf8_lossy(bytes).to_string();
    if truncated {
        text.push_str("\n… diff truncated at DraftMatter's 2 MB display limit …\n");
    }
    Ok(GitDiffResult {
        path: request.path,
        staged: request.staged,
        text,
        binary,
        truncated,
    })
}

fn validate_commit_hash(hash: &str) -> Result<&str, HostError> {
    if (7..=40).contains(&hash.len()) && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(hash)
    } else {
        Err(HostError::InvalidProject(
            "The checkpoint identifier is not a valid abbreviated commit hash.".to_string(),
        ))
    }
}

fn project_history_pathspec(context: &RepositoryContext) -> String {
    if context.project_prefix.as_os_str().is_empty() {
        ".".to_string()
    } else {
        slash_path(&context.project_prefix)
    }
}

pub fn git_history_impl(raw_root: &str) -> Result<Vec<GitHistoryEntry>, HostError> {
    let context = require_repository(raw_root)?;
    let head = run_git(&context.repository_root, &["rev-parse", "--verify", "HEAD"])?;
    if !head.status.success() {
        return Ok(Vec::new());
    }
    let limit = format!("--max-count={MAX_HISTORY_ENTRIES}");
    let pathspec = project_history_pathspec(&context);
    let output = require_success(
        run_git(
            &context.repository_root,
            &[
                "log",
                "-z",
                &limit,
                "--date=iso-strict",
                "--format=%H%x00%h%x00%aI%x00%an%x00%s%x00",
                "--",
                &pathspec,
            ],
        )?,
        "read checkpoint history",
    )?;
    let mut fields = output.stdout.split(|byte| *byte == 0).peekable();
    let mut history = Vec::new();
    loop {
        while fields.peek().is_some_and(|field| field.is_empty()) {
            fields.next();
        }
        let Some(hash) = fields.next() else { break };
        let Some(short_hash) = fields.next() else {
            return Err(HostError::Integration(
                "Git returned malformed checkpoint history.".to_string(),
            ));
        };
        let Some(authored_at) = fields.next() else {
            return Err(HostError::Integration(
                "Git returned malformed checkpoint history.".to_string(),
            ));
        };
        let Some(author) = fields.next() else {
            return Err(HostError::Integration(
                "Git returned malformed checkpoint history.".to_string(),
            ));
        };
        let Some(message) = fields.next() else {
            return Err(HostError::Integration(
                "Git returned malformed checkpoint history.".to_string(),
            ));
        };
        history.push(GitHistoryEntry {
            hash: String::from_utf8_lossy(hash).to_string(),
            short_hash: String::from_utf8_lossy(short_hash).to_string(),
            authored_at: String::from_utf8_lossy(authored_at).to_string(),
            author: String::from_utf8_lossy(author).to_string(),
            message: String::from_utf8_lossy(message).to_string(),
        });
    }
    Ok(history)
}

pub fn git_checkpoint_diff_impl(
    request: GitCheckpointDiffRequest,
) -> Result<GitCheckpointDiffResult, HostError> {
    let context = require_repository(&request.root)?;
    let hash = validate_commit_hash(&request.hash)?;
    let verified = format!("{hash}^{{commit}}");
    require_success(
        run_git(
            &context.repository_root,
            &["rev-parse", "--verify", &verified],
        )?,
        "find the selected checkpoint",
    )?;
    let pathspec = project_history_pathspec(&context);
    let output = require_success(
        run_git(
            &context.repository_root,
            &[
                "show",
                "--format=",
                "--no-ext-diff",
                "--no-color",
                "--unified=3",
                "--find-renames",
                hash,
                "--",
                &pathspec,
            ],
        )?,
        "read the selected checkpoint diff",
    )?;
    let truncated = output.stdout.len() > MAX_DIFF_BYTES;
    let bytes = &output.stdout[..output.stdout.len().min(MAX_DIFF_BYTES)];
    let mut text = String::from_utf8_lossy(bytes).to_string();
    if truncated {
        text.push_str("\n… diff truncated at DraftMatter's 2 MB display limit …\n");
    }
    let files = checkpoint_files(&context, hash)?;
    Ok(GitCheckpointDiffResult {
        hash: hash.to_string(),
        text,
        truncated,
        files,
    })
}

fn checkpoint_files(context: &RepositoryContext, hash: &str) -> Result<Vec<String>, HostError> {
    let pathspec = project_history_pathspec(context);
    let output = require_success(
        run_git(
            &context.repository_root,
            &[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--name-only",
                "--find-renames",
                "-r",
                "-m",
                "-z",
                hash,
                "--",
                &pathspec,
            ],
        )?,
        "read the selected checkpoint files",
    )?;
    let mut files = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .filter_map(|value| project_relative(context, &String::from_utf8_lossy(value)))
        .collect::<Vec<_>>();
    files.sort();
    files.dedup();
    Ok(files)
}

pub fn git_restore_checkpoint_impl(
    request: GitRestoreCheckpointRequest,
) -> Result<GitRepositoryStatus, HostError> {
    let context = require_repository(&request.root)?;
    let hash = validate_commit_hash(&request.hash)?;
    let verified = format!("{hash}^{{commit}}");
    require_success(
        run_git(
            &context.repository_root,
            &["rev-parse", "--verify", &verified],
        )?,
        "find the selected checkpoint",
    )?;
    let repository_paths = selected_repository_paths(&context, &request.paths)?;
    let available = checkpoint_files(&context, hash)?
        .into_iter()
        .collect::<HashSet<_>>();
    if request.paths.iter().any(|path| !available.contains(path)) {
        return Err(HostError::InvalidProject(
            "Only files changed by the selected checkpoint can be restored from this view."
                .to_string(),
        ));
    }
    let dirty = status_entries(&context)?;
    if let Some(path) = request.paths.iter().find(|path| {
        dirty.iter().any(|entry| {
            &entry.path == *path || entry.original_path.as_deref() == Some(path.as_str())
        })
    }) {
        return Err(HostError::Conflict(format!(
            "{path} has staged or working-tree changes. Create a checkpoint or resolve those changes before restoring it."
        )));
    }

    let mut tree_arguments = vec!["ls-tree", "-r", "--name-only", "-z", hash, "--"];
    tree_arguments.extend(repository_paths.iter().map(String::as_str));
    let tree = require_success(
        run_git(&context.repository_root, &tree_arguments)?,
        "inspect checkpoint files",
    )?;
    let present = tree
        .stdout
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .map(|value| String::from_utf8_lossy(value).to_string())
        .collect::<HashSet<_>>();
    let present_paths = repository_paths
        .iter()
        .filter(|path| present.contains(*path))
        .collect::<Vec<_>>();
    let absent_paths = repository_paths
        .iter()
        .filter(|path| !present.contains(*path))
        .collect::<Vec<_>>();
    for path in &absent_paths {
        if context.repository_root.join(path).is_dir() {
            return Err(HostError::Conflict(format!(
                "DraftMatter will not replace the directory {path} while restoring a checkpoint."
            )));
        }
    }
    if !present_paths.is_empty() {
        let mut restore_arguments = vec!["restore", "--source", hash, "--worktree", "--"];
        restore_arguments.extend(present_paths.iter().map(|path| path.as_str()));
        require_success(
            run_git(&context.repository_root, &restore_arguments)?,
            "restore checkpoint files",
        )?;
    }
    for path in absent_paths {
        let destination = context.repository_root.join(path);
        if destination.exists() {
            fs::remove_file(destination)?;
        }
    }
    git_status_impl(&request.root)
}

fn selected_repository_paths(
    context: &RepositoryContext,
    paths: &[String],
) -> Result<Vec<String>, HostError> {
    if paths.is_empty() || paths.len() > MAX_SELECTED_PATHS {
        return Err(HostError::InvalidProject(format!(
            "Select between 1 and {MAX_SELECTED_PATHS} project files."
        )));
    }
    let mut seen = HashSet::new();
    let mut selected = Vec::with_capacity(paths.len());
    for path in paths {
        let repository_path = repository_path(context, path)?;
        if seen.insert(repository_path.clone()) {
            selected.push(repository_path);
        }
    }
    Ok(selected)
}

pub fn git_stage_impl(request: GitStageRequest) -> Result<GitRepositoryStatus, HostError> {
    let context = require_repository(&request.root)?;
    let paths = selected_repository_paths(&context, &request.paths)?;
    let mut arguments = vec!["add", "--all", "--"];
    arguments.extend(paths.iter().map(String::as_str));
    require_success(
        run_git(&context.repository_root, &arguments)?,
        "stage the selected files",
    )?;
    git_status_impl(&request.root)
}

fn validate_commit_message(message: &str) -> Result<String, HostError> {
    let message = message.trim();
    if message.is_empty() || message.len() > MAX_COMMIT_MESSAGE_BYTES || message.contains('\0') {
        return Err(HostError::InvalidProject(
            "Checkpoint names must contain between 1 and 4,096 bytes of text.".to_string(),
        ));
    }
    Ok(message.to_string())
}

pub fn git_create_commit_impl(request: GitCommitRequest) -> Result<GitCommitResult, HostError> {
    let context = require_repository(&request.root)?;
    let message = validate_commit_message(&request.message)?;
    let staged = run_git(&context.repository_root, &["diff", "--cached", "--quiet"])?;
    if staged.status.success() {
        return Err(HostError::Conflict(
            "No staged changes are available for this checkpoint.".to_string(),
        ));
    }
    require_success(
        run_git(
            &context.repository_root,
            &["commit", "--no-verify", "-m", &message],
        )?,
        "create the checkpoint",
    )?;
    let hash = require_success(
        run_git(&context.repository_root, &["rev-parse", "HEAD"])?,
        "read the new checkpoint",
    )?;
    let hash = String::from_utf8_lossy(&hash.stdout).trim().to_string();
    let files_output = require_success(
        run_git(
            &context.repository_root,
            &[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--name-only",
                "-r",
                "-z",
                "HEAD",
            ],
        )?,
        "read the checkpoint files",
    )?;
    let mut files = files_output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .filter_map(|value| project_relative(&context, &String::from_utf8_lossy(value)))
        .collect::<Vec<_>>();
    files.sort();
    Ok(GitCommitResult {
        short_hash: hash.chars().take(8).collect(),
        hash,
        message,
        files,
    })
}

pub fn git_create_checkpoint_impl(
    request: GitCheckpointRequest,
) -> Result<GitCommitResult, HostError> {
    let context = require_repository(&request.root)?;
    let message = validate_commit_message(&request.message)?;
    let paths = selected_repository_paths(&context, &request.paths)?;

    let mut stage_arguments = vec!["add", "--all", "--"];
    stage_arguments.extend(paths.iter().map(String::as_str));
    require_success(
        run_git(&context.repository_root, &stage_arguments)?,
        "stage the selected checkpoint files",
    )?;

    let mut commit_arguments = vec!["commit", "--only", "--no-verify", "-m", &message, "--"];
    commit_arguments.extend(paths.iter().map(String::as_str));
    require_success(
        run_git(&context.repository_root, &commit_arguments)?,
        "create the selected checkpoint",
    )?;

    let hash = require_success(
        run_git(&context.repository_root, &["rev-parse", "HEAD"])?,
        "read the new checkpoint",
    )?;
    let hash = String::from_utf8_lossy(&hash.stdout).trim().to_string();
    Ok(GitCommitResult {
        short_hash: hash.chars().take(8).collect(),
        hash,
        message,
        files: request.paths,
    })
}

fn validate_branch_name(context: &RepositoryContext, name: &str) -> Result<(), HostError> {
    if name.is_empty() || name.len() > 255 || name.contains('\0') {
        return Err(HostError::InvalidProject(
            "The branch name is empty or too long.".to_string(),
        ));
    }
    let output = run_git(
        &context.repository_root,
        &["check-ref-format", "--branch", name],
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err(HostError::InvalidProject(format!(
            "Git rejected the branch name: {}",
            sanitise_message(&output.stderr)
        )))
    }
}

fn require_clean_worktree(root: &str) -> Result<(), HostError> {
    if git_status_impl(root)?.entries.is_empty() {
        Ok(())
    } else {
        Err(HostError::Conflict(
            "Commit or otherwise resolve project changes before switching branches or pulling."
                .to_string(),
        ))
    }
}

pub fn git_branches_impl(raw_root: &str) -> Result<GitBranchStatus, HostError> {
    let context = require_repository(raw_root)?;
    let current = branch_name(&context)?;
    let output = require_success(
        run_git(
            &context.repository_root,
            &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        )?,
        "list branches",
    )?;
    let mut branches = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|name| !name.is_empty())
        .map(|name| GitBranch {
            name: name.to_string(),
            current: current.as_deref() == Some(name),
        })
        .collect::<Vec<_>>();
    branches.sort_by(|left, right| left.name.cmp(&right.name));
    let remotes = require_success(
        run_git(&context.repository_root, &["remote"])?,
        "list remotes",
    )?;
    let mut remotes = String::from_utf8_lossy(&remotes.stdout)
        .lines()
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    remotes.sort();
    Ok(GitBranchStatus {
        detached: current.is_none(),
        current,
        branches,
        remotes,
    })
}

pub fn git_create_branch_impl(request: GitBranchRequest) -> Result<GitBranchStatus, HostError> {
    let context = require_repository(&request.root)?;
    validate_branch_name(&context, &request.name)?;
    require_clean_worktree(&request.root)?;
    require_success(
        run_git(
            &context.repository_root,
            &["switch", "--create", &request.name],
        )?,
        "create and switch branches",
    )?;
    git_branches_impl(&request.root)
}

pub fn git_switch_branch_impl(request: GitBranchRequest) -> Result<GitBranchStatus, HostError> {
    let context = require_repository(&request.root)?;
    validate_branch_name(&context, &request.name)?;
    require_clean_worktree(&request.root)?;
    require_success(
        run_git(
            &context.repository_root,
            &["switch", "--no-guess", &request.name],
        )?,
        "switch branches",
    )?;
    git_branches_impl(&request.root)
}

fn validate_remote(
    context: &RepositoryContext,
    remote: Option<&str>,
) -> Result<Option<String>, HostError> {
    let Some(remote) = remote else {
        return Ok(None);
    };
    if remote.is_empty() || remote.len() > 128 || remote.contains('\0') {
        return Err(HostError::InvalidProject(
            "The remote name is invalid.".to_string(),
        ));
    }
    let remotes = git_branches_impl(&context.project_root.to_string_lossy())?.remotes;
    if remotes.iter().any(|candidate| candidate == remote) {
        Ok(Some(remote.to_string()))
    } else {
        Err(HostError::InvalidProject(format!(
            "The configured Git remote {remote:?} does not exist."
        )))
    }
}

fn remote_result(root: &str, action: &str, output: &Output) -> Result<GitRemoteResult, HostError> {
    let summary = if output.stderr.is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        sanitise_message(&output.stderr)
    };
    Ok(GitRemoteResult {
        action: action.to_string(),
        summary: if summary.is_empty() {
            format!("Git {action} completed.")
        } else {
            summary
        },
        status: git_status_impl(root)?,
    })
}

pub fn git_fetch_impl(request: GitRemoteRequest) -> Result<GitRemoteResult, HostError> {
    let context = require_repository(&request.root)?;
    let remote = validate_remote(&context, request.remote.as_deref())?;
    if request.branch.is_some() {
        return Err(HostError::InvalidProject(
            "Fetch accepts a configured remote, not a branch or arbitrary refspec.".to_string(),
        ));
    }
    let mut arguments = vec!["fetch", "--prune"];
    if let Some(remote) = remote.as_deref() {
        arguments.push(remote);
    } else {
        arguments.push("--all");
    }
    let output = require_success(
        run_git(&context.repository_root, &arguments)?,
        "fetch remote changes",
    )?;
    remote_result(&request.root, "fetch", &output)
}

pub fn git_pull_impl(request: GitRemoteRequest) -> Result<GitRemoteResult, HostError> {
    let context = require_repository(&request.root)?;
    let remote = validate_remote(&context, request.remote.as_deref())?;
    if let Some(branch) = request.branch.as_deref() {
        validate_branch_name(&context, branch)?;
    }
    if remote.is_none() != request.branch.is_none() {
        return Err(HostError::InvalidProject(
            "Pull must use the current upstream or an explicit configured remote and branch."
                .to_string(),
        ));
    }
    require_clean_worktree(&request.root)?;
    let mut arguments = vec!["pull", "--ff-only"];
    if let (Some(remote), Some(branch)) = (remote.as_deref(), request.branch.as_deref()) {
        arguments.extend([remote, branch]);
    }
    let output = require_success(
        run_git(&context.repository_root, &arguments)?,
        "fast-forward pull remote changes",
    )?;
    remote_result(&request.root, "pull", &output)
}

pub fn git_push_impl(request: GitRemoteRequest) -> Result<GitRemoteResult, HostError> {
    let context = require_repository(&request.root)?;
    let remote = validate_remote(&context, request.remote.as_deref())?;
    if let Some(branch) = request.branch.as_deref() {
        validate_branch_name(&context, branch)?;
    }
    if remote.is_none() != request.branch.is_none() {
        return Err(HostError::InvalidProject(
            "Push must use the current upstream or an explicit configured remote and branch."
                .to_string(),
        ));
    }
    let mut arguments = vec!["push"];
    if let (Some(remote), Some(branch)) = (remote.as_deref(), request.branch.as_deref()) {
        arguments.extend([remote, branch]);
    }
    let output = require_success(
        run_git(&context.repository_root, &arguments)?,
        "push the current branch",
    )?;
    remote_result(&request.root, "push", &output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use tempfile::tempdir;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn git<I, S>(root: &Path, args: I) -> Output
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let output = Command::new("git")
            .current_dir(root)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }

    fn initialise(root: &Path) {
        git(root, ["init", "-b", "main"]);
        git(root, ["config", "user.name", "DraftMatter Test"]);
        git(
            root,
            ["config", "user.email", "draftmatter@example.invalid"],
        );
    }

    fn commit_all(root: &Path, message: &str) {
        git(root, ["add", "--all"]);
        git(root, ["commit", "-m", message]);
    }

    #[test]
    fn status_classifies_portable_worktree_changes() {
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join("modified.qmd"), "before\n").unwrap();
        fs::write(project.path().join("deleted.qmd"), "delete\n").unwrap();
        fs::write(project.path().join("rename-me.qmd"), "rename\n").unwrap();
        fs::write(project.path().join("figure.bin"), [0, 1, 2, 3]).unwrap();
        commit_all(project.path(), "base");

        fs::write(project.path().join("modified.qmd"), "after\n").unwrap();
        fs::remove_file(project.path().join("deleted.qmd")).unwrap();
        fs::rename(
            project.path().join("rename-me.qmd"),
            project.path().join("renamed.qmd"),
        )
        .unwrap();
        fs::write(project.path().join("added.qmd"), "new\n").unwrap();
        fs::write(project.path().join("figure.bin"), [0, 1, 2, 4]).unwrap();
        git(project.path(), ["add", "renamed.qmd", "rename-me.qmd"]);

        let status = git_status_impl(&project.path().to_string_lossy()).unwrap();
        assert!(status.repository);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.entries.len(), 5);
        assert!(status.entries.iter().any(|entry| {
            entry.path == "modified.qmd" && entry.kind == GitChangeKind::Modified
        }));
        assert!(status
            .entries
            .iter()
            .any(|entry| { entry.path == "added.qmd" && entry.kind == GitChangeKind::Untracked }));
        assert!(status
            .entries
            .iter()
            .any(|entry| { entry.path == "deleted.qmd" && entry.kind == GitChangeKind::Deleted }));
        assert!(status.entries.iter().any(|entry| {
            entry.path == "renamed.qmd"
                && entry.original_path.as_deref() == Some("rename-me.qmd")
                && entry.kind == GitChangeKind::Renamed
        }));
        assert!(status
            .entries
            .iter()
            .any(|entry| entry.path == "figure.bin" && entry.binary));
    }

    #[test]
    fn selected_checkpoint_preserves_unrelated_worktree_changes() {
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join("paper.qmd"), "one\n").unwrap();
        fs::write(project.path().join("notes.md"), "private\n").unwrap();
        commit_all(project.path(), "base");
        fs::write(project.path().join("paper.qmd"), "two\n").unwrap();
        fs::write(project.path().join("notes.md"), "private edits\n").unwrap();

        git_stage_impl(GitStageRequest {
            root: project.path().to_string_lossy().to_string(),
            paths: vec!["paper.qmd".to_string()],
        })
        .unwrap();
        let commit = git_create_commit_impl(GitCommitRequest {
            root: project.path().to_string_lossy().to_string(),
            message: "Manuscript checkpoint".to_string(),
        })
        .unwrap();
        assert_eq!(commit.files, vec!["paper.qmd"]);
        let status = git_status_impl(&project.path().to_string_lossy()).unwrap();
        assert_eq!(status.entries.len(), 1);
        assert_eq!(status.entries[0].path, "notes.md");
        assert!(!status.entries[0].staged);
    }

    #[test]
    fn checkpoint_history_is_bounded_and_exposes_read_only_diffs() {
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join("paper.qmd"), "one\n").unwrap();
        commit_all(project.path(), "First draft");
        fs::write(project.path().join("paper.qmd"), "two\n").unwrap();
        commit_all(project.path(), "Revise result");
        let root = project.path().to_string_lossy().to_string();

        let history = git_history_impl(&root).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].message, "Revise result");
        assert_eq!(history[1].message, "First draft");
        assert_eq!(history[0].hash.len(), 40);

        let diff = git_checkpoint_diff_impl(GitCheckpointDiffRequest {
            root: root.clone(),
            hash: history[0].short_hash.clone(),
        })
        .unwrap();
        assert!(diff.text.contains("-one"));
        assert!(diff.text.contains("+two"));
        assert_eq!(diff.files, vec!["paper.qmd"]);
        assert!(git_status_impl(&root).unwrap().entries.is_empty());
        assert!(matches!(
            git_checkpoint_diff_impl(GitCheckpointDiffRequest {
                root,
                hash: "HEAD;rm".to_string(),
            }),
            Err(HostError::InvalidProject(_))
        ));
    }

    #[test]
    fn checkpoint_restore_refuses_dirty_files_and_restores_clean_content() {
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join("paper.qmd"), "one\n").unwrap();
        commit_all(project.path(), "First draft");
        let first = String::from_utf8_lossy(&git(project.path(), ["rev-parse", "HEAD"]).stdout)
            .trim()
            .to_string();
        fs::write(project.path().join("paper.qmd"), "two\n").unwrap();
        commit_all(project.path(), "Second draft");
        let root = project.path().to_string_lossy().to_string();

        fs::write(project.path().join("paper.qmd"), "unsaved\n").unwrap();
        let blocked = git_restore_checkpoint_impl(GitRestoreCheckpointRequest {
            root: root.clone(),
            hash: first.clone(),
            paths: vec!["paper.qmd".to_string()],
        });
        assert!(matches!(blocked, Err(HostError::Conflict(_))));
        assert_eq!(
            fs::read_to_string(project.path().join("paper.qmd")).unwrap(),
            "unsaved\n"
        );

        fs::write(project.path().join("paper.qmd"), "two\n").unwrap();
        let status = git_restore_checkpoint_impl(GitRestoreCheckpointRequest {
            root,
            hash: first,
            paths: vec!["paper.qmd".to_string()],
        })
        .unwrap();
        assert_eq!(
            fs::read_to_string(project.path().join("paper.qmd"))
                .unwrap()
                .replace("\r\n", "\n"),
            "one\n"
        );
        assert_eq!(status.entries.len(), 1);
        assert_eq!(status.entries[0].path, "paper.qmd");
        assert!(status.entries[0].unstaged);
    }

    #[test]
    fn checkpoint_restore_can_reapply_an_explicit_file_deletion() {
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join("obsolete.md"), "old\n").unwrap();
        commit_all(project.path(), "Add note");
        fs::remove_file(project.path().join("obsolete.md")).unwrap();
        commit_all(project.path(), "Remove note");
        let deletion = String::from_utf8_lossy(&git(project.path(), ["rev-parse", "HEAD"]).stdout)
            .trim()
            .to_string();
        fs::write(project.path().join("obsolete.md"), "new\n").unwrap();
        commit_all(project.path(), "Restore note later");
        let root = project.path().to_string_lossy().to_string();

        git_restore_checkpoint_impl(GitRestoreCheckpointRequest {
            root: root.clone(),
            hash: deletion,
            paths: vec!["obsolete.md".to_string()],
        })
        .unwrap();

        assert!(!project.path().join("obsolete.md").exists());
        let status = git_status_impl(&root).unwrap();
        assert_eq!(status.entries.len(), 1);
        assert_eq!(status.entries[0].kind, GitChangeKind::Deleted);
    }

    #[test]
    fn one_step_checkpoint_preserves_unselected_staged_changes() {
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join("paper.qmd"), "one\n").unwrap();
        fs::write(project.path().join("notes.md"), "private\n").unwrap();
        commit_all(project.path(), "base");
        fs::write(project.path().join("paper.qmd"), "two\n").unwrap();
        fs::write(project.path().join("notes.md"), "private staged edits\n").unwrap();
        git(project.path(), ["add", "notes.md"]);

        let checkpoint = git_create_checkpoint_impl(GitCheckpointRequest {
            root: project.path().to_string_lossy().to_string(),
            paths: vec!["paper.qmd".to_string()],
            message: "Selected manuscript".to_string(),
        })
        .unwrap();

        assert_eq!(checkpoint.files, vec!["paper.qmd"]);
        let committed = git(project.path(), ["show", "HEAD:paper.qmd"]);
        assert_eq!(String::from_utf8_lossy(&committed.stdout), "two\n");
        let status = git_status_impl(&project.path().to_string_lossy()).unwrap();
        assert_eq!(status.entries.len(), 1);
        assert_eq!(status.entries[0].path, "notes.md");
        assert!(status.entries[0].staged);
    }

    #[test]
    fn guarded_branches_refuse_dirty_switches_and_accept_clean_names() {
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join("paper.qmd"), "one\n").unwrap();
        commit_all(project.path(), "base");
        fs::write(project.path().join("paper.qmd"), "dirty\n").unwrap();
        let root = project.path().to_string_lossy().to_string();

        let blocked = git_create_branch_impl(GitBranchRequest {
            root: root.clone(),
            name: "analysis".to_string(),
        });
        assert!(matches!(blocked, Err(HostError::Conflict(_))));
        fs::write(project.path().join("paper.qmd"), "one\n").unwrap();
        let branches = git_create_branch_impl(GitBranchRequest {
            root: root.clone(),
            name: "analysis".to_string(),
        })
        .unwrap();
        assert_eq!(branches.current.as_deref(), Some("analysis"));
        assert!(git_switch_branch_impl(GitBranchRequest {
            root,
            name: "main".to_string(),
        })
        .is_ok());
    }

    #[test]
    fn initialization_is_explicit_and_does_not_replace_an_existing_ignore() {
        let project = tempdir().unwrap();
        fs::write(project.path().join(".gitignore"), "private/\n").unwrap();
        let root = project.path().to_string_lossy();
        assert!(!git_status_impl(&root).unwrap().repository);
        let initialized = git_initialize_impl(&root).unwrap();
        assert!(!initialized.created_ignore);
        assert!(initialized.status.repository);
        assert_eq!(
            fs::read_to_string(project.path().join(".gitignore")).unwrap(),
            "private/\n"
        );
    }

    #[test]
    fn the_first_selected_checkpoint_can_create_the_root_commit() {
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join("paper.qmd"), "# First draft\n").unwrap();
        let checkpoint = git_create_checkpoint_impl(GitCheckpointRequest {
            root: project.path().to_string_lossy().to_string(),
            paths: vec!["paper.qmd".to_string()],
            message: "First draft".to_string(),
        })
        .unwrap();

        assert_eq!(checkpoint.files, vec!["paper.qmd"]);
        assert_eq!(
            branch_name(&require_repository(&project.path().to_string_lossy()).unwrap())
                .unwrap()
                .as_deref(),
            Some("main")
        );
        assert!(git_status_impl(&project.path().to_string_lossy())
            .unwrap()
            .entries
            .is_empty());
    }

    #[test]
    fn conflicted_files_are_classified_without_attempting_resolution() {
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join("paper.qmd"), "base\n").unwrap();
        commit_all(project.path(), "base");
        git(project.path(), ["switch", "-c", "other"]);
        fs::write(project.path().join("paper.qmd"), "other\n").unwrap();
        commit_all(project.path(), "other edit");
        git(project.path(), ["switch", "main"]);
        fs::write(project.path().join("paper.qmd"), "main\n").unwrap();
        commit_all(project.path(), "main edit");

        let merge = Command::new("git")
            .current_dir(project.path())
            .args(["merge", "other"])
            .output()
            .unwrap();
        assert!(!merge.status.success());
        let status = git_status_impl(&project.path().to_string_lossy()).unwrap();
        assert_eq!(status.entries.len(), 1);
        assert_eq!(status.entries[0].kind, GitChangeKind::Conflicted);
        assert!(status.entries[0].conflicted);
    }

    #[test]
    fn local_bare_remote_supports_explicit_fetch_pull_and_push() {
        let remote = tempdir().unwrap();
        git(remote.path(), ["init", "--bare", "-b", "main"]);
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join("paper.qmd"), "base\n").unwrap();
        commit_all(project.path(), "base");
        git(
            project.path(),
            ["remote", "add", "origin", &remote.path().to_string_lossy()],
        );
        git(project.path(), ["push", "-u", "origin", "main"]);
        let root = project.path().to_string_lossy().to_string();

        let fetched = git_fetch_impl(GitRemoteRequest {
            root: root.clone(),
            remote: Some("origin".to_string()),
            branch: None,
        })
        .unwrap();
        assert_eq!(fetched.action, "fetch");

        fs::write(project.path().join("paper.qmd"), "pushed\n").unwrap();
        commit_all(project.path(), "push change");
        let pushed = git_push_impl(GitRemoteRequest {
            root: root.clone(),
            remote: Some("origin".to_string()),
            branch: Some("main".to_string()),
        })
        .unwrap();
        assert_eq!(pushed.status.ahead, 0);

        let collaborator = tempdir().unwrap();
        git(
            collaborator.path(),
            [
                "clone",
                &remote.path().to_string_lossy(),
                &collaborator.path().join("clone").to_string_lossy(),
            ],
        );
        let clone = collaborator.path().join("clone");
        git(&clone, ["config", "user.name", "Collaborator"]);
        git(
            &clone,
            ["config", "user.email", "collaborator@example.invalid"],
        );
        fs::write(clone.join("paper.qmd"), "pulled\n").unwrap();
        commit_all(&clone, "remote change");
        git(&clone, ["push", "origin", "main"]);

        let pulled = git_pull_impl(GitRemoteRequest {
            root,
            remote: Some("origin".to_string()),
            branch: Some("main".to_string()),
        })
        .unwrap();
        assert_eq!(pulled.action, "pull");
        assert_eq!(
            fs::read_to_string(project.path().join("paper.qmd"))
                .unwrap()
                .replace("\r\n", "\n"),
            "pulled\n"
        );
    }

    #[test]
    fn divergent_pull_stops_and_preserves_local_work() {
        let remote = tempdir().unwrap();
        git(remote.path(), ["init", "--bare", "-b", "main"]);
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join("paper.qmd"), "base\n").unwrap();
        commit_all(project.path(), "base");
        git(
            project.path(),
            ["remote", "add", "origin", &remote.path().to_string_lossy()],
        );
        git(project.path(), ["push", "-u", "origin", "main"]);
        let collaborator = tempdir().unwrap();
        git(
            collaborator.path(),
            [
                "clone",
                &remote.path().to_string_lossy(),
                &collaborator.path().join("clone").to_string_lossy(),
            ],
        );
        let clone = collaborator.path().join("clone");
        git(&clone, ["config", "user.name", "Collaborator"]);
        git(
            &clone,
            ["config", "user.email", "collaborator@example.invalid"],
        );
        fs::write(clone.join("paper.qmd"), "remote conflict\n").unwrap();
        commit_all(&clone, "remote conflict");
        git(&clone, ["push", "origin", "main"]);
        fs::write(project.path().join("paper.qmd"), "local conflict\n").unwrap();
        commit_all(project.path(), "local conflict");
        let local_head =
            String::from_utf8_lossy(&git(project.path(), ["rev-parse", "HEAD"]).stdout)
                .trim()
                .to_string();

        let result = git_pull_impl(GitRemoteRequest {
            root: project.path().to_string_lossy().to_string(),
            remote: Some("origin".to_string()),
            branch: Some("main".to_string()),
        });
        assert!(matches!(result, Err(HostError::Integration(_))));
        assert_eq!(
            fs::read_to_string(project.path().join("paper.qmd")).unwrap(),
            "local conflict\n"
        );
        let after = String::from_utf8_lossy(&git(project.path(), ["rev-parse", "HEAD"]).stdout)
            .trim()
            .to_string();
        assert_eq!(after, local_head);
    }

    #[test]
    fn remote_failures_are_bounded_and_credentials_are_redacted() {
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join("paper.qmd"), "base\n").unwrap();
        commit_all(project.path(), "base");
        let missing_remote = project.path().join("missing-remote.git");
        git(
            project.path(),
            [
                "remote",
                "add",
                "private",
                &missing_remote.to_string_lossy(),
            ],
        );

        let result = git_fetch_impl(GitRemoteRequest {
            root: project.path().to_string_lossy().to_string(),
            remote: Some("private".to_string()),
            branch: None,
        });
        let Err(HostError::Integration(message)) = result else {
            panic!("expected an integration error");
        };
        assert!(!message.contains("secret"));
        assert_eq!(
            sanitise_message(b"fatal: https://user:secret@example.invalid/private.git failed"),
            "fatal: https://[redacted]@example.invalid/private.git failed"
        );
    }

    #[test]
    fn traversal_and_empty_commits_are_rejected() {
        let project = tempdir().unwrap();
        initialise(project.path());
        let root = project.path().to_string_lossy().to_string();
        let traversal = git_stage_impl(GitStageRequest {
            root: root.clone(),
            paths: vec!["../outside".to_string()],
        });
        assert!(matches!(traversal, Err(HostError::InvalidPath(_))));
        let empty = git_create_commit_impl(GitCommitRequest {
            root,
            message: "Empty".to_string(),
        });
        assert!(matches!(empty, Err(HostError::Conflict(_))));
    }

    #[cfg(unix)]
    #[test]
    fn repository_hooks_and_fsmonitor_cannot_execute_through_the_adapter() {
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join("paper.qmd"), "base\n").unwrap();
        commit_all(project.path(), "base");
        let sentinel = project.path().join("hook-ran");
        let hooks = project.path().join("controlled-hooks");
        fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("post-commit");
        fs::write(
            &hook,
            format!("#!/bin/sh\nprintf unsafe > '{}'\n", sentinel.display()),
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        git(
            project.path(),
            ["config", "core.hooksPath", &hooks.to_string_lossy()],
        );
        git(
            project.path(),
            ["config", "core.fsmonitor", &hook.to_string_lossy()],
        );
        fs::write(project.path().join("paper.qmd"), "next\n").unwrap();

        let root = project.path().to_string_lossy().to_string();
        git_status_impl(&root).unwrap();
        git_create_checkpoint_impl(GitCheckpointRequest {
            root,
            paths: vec!["paper.qmd".to_string()],
            message: "Safe checkpoint".to_string(),
        })
        .unwrap();
        assert!(!sentinel.exists());
    }
}

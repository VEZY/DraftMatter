use crate::{canonical_root, safe_relative, slash_path, HostError};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const MAX_GIT_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
const MAX_STATUS_ENTRIES: usize = 10_000;
const MAX_SELECTED_PATHS: usize = 512;
const MAX_COMMIT_MESSAGE_BYTES: usize = 4_096;
const MAX_HISTORY_ENTRIES: usize = 50;
const GIT_TIMEOUT: Duration = Duration::from_secs(60);
const GIT_CLONE_TIMEOUT: Duration = Duration::from_secs(300);

#[path = "git_initialization.rs"]
mod initialization;
pub use initialization::{
    git_initialization_plan_impl, git_initialize_with_commit_impl,
    GitInitializationExpectedFile, GitInitializationPlan, GitInitializeRequest,
};

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_commit: Option<GitCommitResult>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteConfiguration {
    pub name: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub push_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitSetRemoteRequest {
    pub root: String,
    pub name: String,
    pub url: String,
    pub expected_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneRequest {
    pub url: String,
    pub parent: String,
    pub folder_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneResult {
    pub root: String,
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
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("GIT_ALLOW_PROTOCOL", "https:ssh:file")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_CONFIG_COUNT", "8")
        .env("GIT_CONFIG_KEY_0", "core.hooksPath")
        .env("GIT_CONFIG_VALUE_0", disabled_hooks)
        .env("GIT_CONFIG_KEY_1", "core.fsmonitor")
        .env("GIT_CONFIG_VALUE_1", "false")
        .env("GIT_CONFIG_KEY_2", "submodule.recurse")
        .env("GIT_CONFIG_VALUE_2", "false")
        .env("GIT_CONFIG_KEY_3", "diff.ignoreSubmodules")
        .env("GIT_CONFIG_VALUE_3", "dirty")
        // Also constrain effective transports after Git's insteadOf rewrites.
        // In particular an HTTPS URL must never invoke an ext/remote helper.
        .env("GIT_CONFIG_KEY_4", "protocol.allow")
        .env("GIT_CONFIG_VALUE_4", "never")
        .env("GIT_CONFIG_KEY_5", "protocol.https.allow")
        .env("GIT_CONFIG_VALUE_5", "always")
        .env("GIT_CONFIG_KEY_6", "protocol.ssh.allow")
        .env("GIT_CONFIG_VALUE_6", "always")
        .env("GIT_CONFIG_KEY_7", "protocol.file.allow")
        .env("GIT_CONFIG_VALUE_7", "always")
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
        let mut limit = 4_096;
        while !message.is_char_boundary(limit) {
            limit -= 1;
        }
        message.truncate(limit);
        message.push_str("…");
    }
    if message.is_empty() {
        "Git did not provide an error message.".to_string()
    } else {
        message
    }
}

fn run_git(current_dir: &Path, arguments: &[&str]) -> Result<Output, HostError> {
    run_git_with_timeout(current_dir, arguments, GIT_TIMEOUT)
}

fn stop_git_process(child: &mut Child) {
    #[cfg(unix)]
    {
        // Git owns a separate process group so timeout also stops its SSH helper.
        // Its unreaped child PID cannot have been reused by an unrelated process.
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn run_git_with_timeout(
    current_dir: &Path,
    arguments: &[&str],
    timeout: Duration,
) -> Result<Output, HostError> {
    let mut command = git_command(current_dir);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            HostError::Integration(
                "System Git is not installed or is not available on PATH.".to_string(),
            )
        } else {
            HostError::Io(format!("Could not start Git: {error}"))
        }
    })?;
    fn drain(mut reader: impl Read) -> Result<Vec<u8>, std::io::Error> {
        let mut retained = Vec::new();
        let mut buffer = [0; 8192];
        loop {
            let size = reader.read(&mut buffer)?;
            if size == 0 {
                return Ok(retained);
            }
            let remaining = (MAX_GIT_OUTPUT_BYTES + 1).saturating_sub(retained.len());
            retained.extend_from_slice(&buffer[..size.min(remaining)]);
        }
    }
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (stdout_sender, stdout_reader) = mpsc::sync_channel(1);
    let (stderr_sender, stderr_reader) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = stdout_sender.send(drain(stdout));
    });
    thread::spawn(move || {
        let _ = stderr_sender.send(drain(stderr));
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(5)),
            Ok(None) => {
                stop_git_process(&mut child);
                return Err(HostError::Integration(format!(
                    "Git did not finish within {} seconds. Check the repository and remote connection before retrying; authentication must be configured in your local Git client.",
                    timeout.as_secs(),
                )));
            }
            Err(error) => {
                stop_git_process(&mut child);
                return Err(HostError::Io(format!(
                    "Could not read the Git process status: {error}"
                )));
            }
        }
    };
    let read_output =
        |reader: mpsc::Receiver<Result<Vec<u8>, std::io::Error>>| -> Result<Vec<u8>, HostError> {
            reader
                .recv_timeout(timeout.saturating_sub(started.elapsed()))
                .map_err(|_| {
                    HostError::Integration(
                        "Git output did not finish in time. Check the repository before retrying."
                            .into(),
                    )
                })?
                .map_err(|error| HostError::Io(format!("Could not read Git output: {error}")))
        };
    let output = Output {
        status,
        stdout: read_output(stdout_reader)?,
        stderr: read_output(stderr_reader)?,
    };
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

fn check_repository_filters(repository_root: &Path) -> Result<(), HostError> {
    // Worktree comparisons can start a clean/process filter even with
    // --no-ext-diff and --no-textconv. Keep user/system filters (e.g. LFS),
    // but refuse repository-supplied commands rather than bypassing a filter
    // and staging or restoring an incorrect file representation.
    check_repository_command_config(
        repository_root,
        r"^filter\..*\.(clean|smudge|process)$",
        "filter",
    )
}

fn check_repository_network_commands(repository_root: &Path) -> Result<(), HostError> {
    // SSH overrides and credential helpers are executable commands, including
    // commands inherited through a repository's include/includeIf files. Git
    // configuration in a downloaded project is not permission to run them.
    // User/system configuration remains available for SSH identities and the
    // user's credential manager.
    check_repository_command_config(
        repository_root,
        r"^(core\.(sshcommand|gitproxy|askpass)|credential(\..*)?\.helper|remote\..*\.(uploadpack|receivepack))$",
        "network",
    )
}

fn check_repository_signing_commands(repository_root: &Path) -> Result<(), HostError> {
    // Keep trusted user-configured commit signing, but a local repository must
    // not turn a Save Version operation into execution of an arbitrary signer.
    check_repository_command_config(
        repository_root,
        r"^gpg((\..*)?\.program|\.ssh\.defaultkeycommand)$",
        "signing",
    )
}

fn check_repository_command_config(
    repository_root: &Path,
    pattern: &str,
    purpose: &str,
) -> Result<(), HostError> {
    // Read repository scopes explicitly. In particular Apple Git reports its
    // built-in system credential helper with an "unknown" scope: treating all
    // unknown settings as repository commands would break ordinary Git on macOS.
    // --worktree falls back to --local when worktreeConfig is not enabled.
    for scope in ["--local", "--worktree"] {
        let output = run_git(
            repository_root,
            &[
                "config", scope, "--includes", "--name-only", "--null", "--get-regexp", pattern,
            ],
        )?;
        if output.status.code() == Some(1) && output.stdout.is_empty() && output.stderr.is_empty() {
            continue; // No matching keys in this repository scope.
        }
        let output = require_success(output, "inspect Git command settings")?;
        if output.stdout.split(|byte| *byte == 0).any(|key| !key.is_empty()) {
            return Err(HostError::Integration(
                format!("This repository defines a Git {purpose} command. DraftMatter cannot run repository-defined {purpose} commands. Use your Git client, or configure the trusted command in your user Git settings."),
            ));
        }
    }
    Ok(())
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
    check_repository_filters(&repository_root)?;
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
    let mut arguments = vec![
        "diff",
        "--numstat",
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=dirty",
        "--submodule=short",
    ];
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
                "--ignore-submodules=dirty",
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
        // Coordination/recovery files are transient runtime state, including
        // the claim held while a guarded branch or restore command runs.
        if path.starts_with(".draftmatter/write-locks/") || path.starts_with(".draftmatter/transactions/") { continue; }
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
    let _project_guard = crate::project_guard(&root)?;
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
    let _project_guard = crate::project_guard(&root)?;
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
            ".draftmatter/cache/\n.draftmatter/recovery/\n.draftmatter/kernels/\n.draftmatter/write-locks/\n.draftmatter/transactions/\n",
        )?;
        true
    };
    Ok(GitInitializeResult {
        repository_root: root.to_string_lossy().to_string(),
        created_ignore,
        status: git_status_impl(raw_root)?,
        initial_commit: None,
    })
}

pub fn git_diff_impl(request: GitDiffRequest) -> Result<GitDiffResult, HostError> {
    let context = require_repository(&request.root)?;
    let _project_guard = crate::project_guard(&context.project_root)?;
    let repository_path = repository_path(&context, &request.path)?;
    let untracked = if request.staged {
        false
    } else {
        let files = require_success(
            run_git(
                &context.repository_root,
                &[
                    "ls-files",
                    "--others",
                    "--exclude-standard",
                    "-z",
                    "--",
                    &repository_path,
                ],
            )?,
            "inspect the selected new file",
        )?;
        files
            .stdout
            .split(|byte| *byte == 0)
            .any(|path| path == repository_path.as_bytes())
    };
    let mut arguments = vec![
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=dirty",
        "--submodule=short",
        "--no-color",
        "--unified=3",
    ];
    if request.staged {
        arguments.push("--cached");
    }
    if untracked {
        arguments.extend(["--no-index", "--", "/dev/null", &repository_path]);
    } else {
        arguments.extend(["--", &repository_path]);
    }
    let output = run_git(&context.repository_root, &arguments)?;
    // --no-index uses exit code 1 for an ordinary difference.
    let output = if untracked && output.status.code() == Some(1) {
        output
    } else {
        require_success(output, "read the selected diff")?
    };
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
            "The commit identifier is not a valid abbreviated commit hash.".to_string(),
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
                "--no-show-signature",
                "-z",
                &limit,
                "--date=iso-strict",
                "--format=%H%x00%h%x00%aI%x00%an%x00%s%x00",
                "--",
                &pathspec,
            ],
        )?,
        "read commit history",
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
                "Git returned malformed commit history.".to_string(),
            ));
        };
        let Some(authored_at) = fields.next() else {
            return Err(HostError::Integration(
                "Git returned malformed commit history.".to_string(),
            ));
        };
        let Some(author) = fields.next() else {
            return Err(HostError::Integration(
                "Git returned malformed commit history.".to_string(),
            ));
        };
        let Some(message) = fields.next() else {
            return Err(HostError::Integration(
                "Git returned malformed commit history.".to_string(),
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
    let _project_guard = crate::project_guard(&context.project_root)?;
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
                "--no-show-signature",
                "--format=",
                "--no-ext-diff",
                "--no-textconv",
                "--submodule=short",
                "--ignore-submodules=dirty",
                "--no-color",
                "--unified=3",
                "--find-renames",
                hash,
                "--",
                &pathspec,
            ],
        )?,
        "read the selected commit diff",
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
        "read the selected commit files",
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
    let _project_guard = crate::project_guard(&context.project_root)?;
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
    let _project_guard = crate::project_guard(&context.project_root)?;
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
            "Commit messages must contain between 1 and 4,096 bytes of text.".to_string(),
        ));
    }
    Ok(message.to_string())
}

pub fn git_create_commit_impl(request: GitCommitRequest) -> Result<GitCommitResult, HostError> {
    let context = require_repository(&request.root)?;
    let _project_guard = crate::project_guard(&context.project_root)?;
    check_repository_signing_commands(&context.repository_root)?;
    let message = validate_commit_message(&request.message)?;
    let staged = run_git(
        &context.repository_root,
        &["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv"],
    )?;
    if staged.status.success() {
        return Err(HostError::Conflict(
            "No staged changes are available for this commit.".to_string(),
        ));
    }
    require_success(
        run_git(
            &context.repository_root,
            &["commit", "--no-verify", "-m", &message],
        )?,
        "create the commit",
    )?;
    let hash = require_success(
        run_git(&context.repository_root, &["rev-parse", "HEAD"])?,
        "read the new commit",
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
        "read the commit files",
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
    let _project_guard = crate::project_guard(&context.project_root)?;
    check_repository_signing_commands(&context.repository_root)?;
    let message = validate_commit_message(&request.message)?;
    let paths = selected_repository_paths(&context, &request.paths)?;
    let mut commit_paths = paths.clone();
    // A staged rename is one selectable row. Commit its old name as well when
    // it belongs to this project. Its deletion is already staged, so attempting
    // to git-add that now-absent name would fail; only add the selected new name.
    for entry in status_entries(&context)? {
        if entry.kind == GitChangeKind::Renamed && request.paths.contains(&entry.path) {
            if let Some(original) = entry.original_path {
                let original = repository_path(&context, &original)?;
                if !commit_paths.contains(&original) {
                    commit_paths.push(original);
                }
            }
        }
    }

    let mut stage_arguments = vec!["add", "--all", "--"];
    stage_arguments.extend(paths.iter().map(String::as_str));
    require_success(
        run_git(&context.repository_root, &stage_arguments)?,
        "stage the selected files",
    )?;

    let mut commit_arguments = vec!["commit", "--only", "--no-verify", "-m", &message, "--"];
    commit_arguments.extend(commit_paths.iter().map(String::as_str));
    require_success(
        run_git(&context.repository_root, &commit_arguments)?,
        "create the selected commit",
    )?;

    let hash = require_success(
        run_git(&context.repository_root, &["rev-parse", "HEAD"])?,
        "read the new commit",
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
    let _project_guard = crate::project_guard(&context.project_root)?;
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
    let _project_guard = crate::project_guard(&context.project_root)?;
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

fn validate_remote_name(name: &str) -> Result<(), HostError> {
    if name.is_empty()
        || name.len() > 128
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || name.contains("..")
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(HostError::InvalidProject(
            "Use a remote name such as origin, containing only letters, numbers, dots, underscores or hyphens.".into(),
        ));
    }
    Ok(())
}

fn validate_remote_url(value: &str) -> Result<(), HostError> {
    let invalid = || {
        HostError::InvalidProject(
        "Use an HTTPS or SSH Git URL, an SSH address such as git@host:owner/paper.git, or an absolute local repository path. Passwords, tokens and URL query parameters must stay in your system Git credential manager.".into(),
    )
    };
    if value.is_empty()
        || value.len() > 4096
        || value.starts_with('-')
        || value.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    if Path::new(value).is_absolute() {
        return Ok(());
    }
    if value.chars().any(char::is_whitespace) {
        return Err(invalid());
    }
    if value.contains("://") {
        let url = tauri::Url::parse(value).map_err(|_| invalid())?;
        if url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
            return Err(invalid());
        }
        match url.scheme() {
            "https" if url.host_str().is_some() && url.username().is_empty() => Ok(()),
            "ssh"
                if url.host_str().is_some_and(|host| !host.starts_with('-'))
                    && (url.username().is_empty()
                        || (!url.username().starts_with('-')
                            && url.username().bytes().all(|byte| {
                                byte.is_ascii_alphanumeric() || b"._-".contains(&byte)
                            }))) =>
            {
                Ok(())
            }
            "file"
                if url.username().is_empty()
                    && matches!(url.host_str(), None | Some("localhost"))
                    && url.to_file_path().is_ok() =>
            {
                Ok(())
            }
            _ => Err(invalid()),
        }
    } else if let Some((host, path)) = value.split_once(':') {
        let host = if let Some((user, host)) = host.split_once('@') {
            if user.is_empty()
                || user.starts_with('-')
                || !user
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
            {
                return Err(invalid());
            }
            host
        } else {
            host
        };
        if host.is_empty()
            || host.starts_with('-')
            || !host
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
            || path.is_empty()
            || path.starts_with(':')
            || path.starts_with('-')
        {
            return Err(invalid());
        }
        Ok(())
    } else {
        Err(invalid())
    }
}

fn config_values(root: &Path, key: &str) -> Result<Vec<String>, HostError> {
    let output = run_git(root, &["config", "--null", "--get-all", key])?;
    if output.status.code() == Some(1) && output.stdout.is_empty() {
        return Ok(Vec::new());
    }
    let output = require_success(output, "read remote configuration")?;
    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .map(|value| String::from_utf8_lossy(value).into_owned())
        .collect())
}

fn remote_configurations(
    context: &RepositoryContext,
) -> Result<Vec<GitRemoteConfiguration>, HostError> {
    let output = require_success(
        run_git(&context.repository_root, &["remote"])?,
        "list remotes",
    )?;
    let mut remotes = Vec::new();
    for name in String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|name| !name.is_empty())
    {
        let urls = config_values(&context.repository_root, &format!("remote.{name}.url"))?;
        let push_urls = config_values(&context.repository_root, &format!("remote.{name}.pushurl"))?;
        if urls.len() != 1 || push_urls.len() > 1 {
            return Err(HostError::Integration(format!("Remote {name:?} has multiple or missing URLs. Manage its advanced configuration in your Git client.")));
        }
        for url in urls.iter().chain(push_urls.iter()) {
            // Do not return stored passwords/tokens to the renderer. They cannot
            // be safely redacted while also serving as the edit fingerprint.
            validate_remote_url(url).map_err(|_| HostError::Integration(format!("Remote {name:?} uses an unsupported URL or contains credentials. Configure a plain HTTPS or SSH URL in your Git client; keep authentication in your system credential manager.")))?;
        }
        remotes.push(GitRemoteConfiguration {
            name: name.into(),
            url: urls[0].clone(),
            push_url: push_urls.into_iter().next().filter(|url| url != &urls[0]),
        });
    }
    remotes.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(remotes)
}

pub fn git_remotes_impl(raw_root: &str) -> Result<Vec<GitRemoteConfiguration>, HostError> {
    let context = require_repository(raw_root)?;
    let _project_guard = crate::project_guard(&context.project_root)?;
    remote_configurations(&context)
}

pub fn git_set_remote_impl(
    request: GitSetRemoteRequest,
) -> Result<Vec<GitRemoteConfiguration>, HostError> {
    validate_remote_name(&request.name)?;
    validate_remote_url(&request.url)?;
    let context = require_repository(&request.root)?;
    let _project_guard = crate::project_guard(&context.project_root)?;
    let remotes = remote_configurations(&context)?;
    let current = remotes.iter().find(|remote| remote.name == request.name);
    if current.map(|remote| &remote.url) != request.expected_url.as_ref() {
        return Err(HostError::Conflict("The remote changed since it was opened. Refresh Git and review the current URL before saving.".into()));
    }
    let arguments = if current.is_some() {
        vec!["remote", "set-url", "--", &request.name, &request.url]
    } else {
        vec!["remote", "add", "--", &request.name, &request.url]
    };
    require_success(
        run_git(&context.repository_root, &arguments)?,
        "save the remote URL",
    )?;
    remote_configurations(&context)
}

pub fn git_clone_impl(request: GitCloneRequest) -> Result<GitCloneResult, HostError> {
    validate_remote_url(&request.url)?;
    let name = &request.folder_name;
    if name.is_empty()
        || name.len() > 200
        || name.starts_with(['.', '-'])
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|character| character.is_control() || "/\\:<>\"|?*".contains(character))
    {
        return Err(HostError::InvalidPath(
            "Choose a new folder name without path separators or special filename characters."
                .into(),
        ));
    }
    let parent = canonical_root(&request.parent)?;
    let destination = parent.join(name);
    // create_dir is the reservation: never accept a pre-existing directory,
    // including an empty one or a symlink. Never recursively clean up a path
    // after an error; another process may have put files there in the meantime.
    fs::create_dir(&destination).map_err(|error| if error.kind() == std::io::ErrorKind::AlreadyExists {
        HostError::Conflict("That folder already exists. Choose a new folder name; existing files were preserved.".into())
    } else { HostError::Io(format!("Could not create the clone folder: {error}")) })?;
    let clone = (|| {
        let target = destination.to_str().ok_or_else(|| {
            HostError::InvalidPath("The clone folder path is not valid Unicode.".into())
        })?;
        require_success(
            run_git_with_timeout(
                &parent,
                &[
                    "clone",
                    "--no-checkout",
                    "--no-local",
                    "--no-recurse-submodules",
                    "--template=",
                    "--",
                    &request.url,
                    target,
                ],
                GIT_CLONE_TIMEOUT,
            )?,
            "clone the repository",
        )?;
        if fs::symlink_metadata(&destination)?.file_type().is_symlink()
            || fs::canonicalize(&destination)?.parent() != Some(parent.as_path())
        {
            return Err(HostError::InvalidPath(
                "The clone folder moved outside its selected parent.".into(),
            ));
        }
        // Repository config is checked before creating any working-tree files.
        // Checkout uses the same disabled hook/fsmonitor and submodule settings.
        check_repository_filters(&destination)?;
        let head = run_git(&destination, &["rev-parse", "--verify", "HEAD"])?;
        if head.status.success() {
            require_success(
                run_git_with_timeout(&destination, &["checkout", "--force"], GIT_CLONE_TIMEOUT)?,
                "check out the cloned paper",
            )?;
        }
        let root = fs::canonicalize(&destination)?;
        if root.parent() != Some(parent.as_path()) {
            return Err(HostError::InvalidPath(
                "The clone folder moved outside its selected parent.".into(),
            ));
        }
        Ok(GitCloneResult {
            root: root.to_string_lossy().into_owned(),
        })
    })();
    clone.map_err(|error: HostError| HostError::Integration(format!("{error} The incomplete clone folder was kept at {}. Choose another folder name or remove that incomplete copy before retrying.", destination.display())))
}
fn validate_remote(
    context: &RepositoryContext,
    remote: Option<&str>,
) -> Result<Option<String>, HostError> {
    let Some(remote) = remote else {
        return Ok(None);
    };
    if remote.is_empty() || remote.starts_with('-') || remote.len() > 128 || remote.contains('\0') {
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
    let _project_guard = crate::project_guard(&context.project_root)?;
    check_repository_network_commands(&context.repository_root)?;
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
    let _project_guard = crate::project_guard(&context.project_root)?;
    check_repository_network_commands(&context.repository_root)?;
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
    let _project_guard = crate::project_guard(&context.project_root)?;
    check_repository_network_commands(&context.repository_root)?;
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
    let current = branch_name(&context)?.ok_or_else(|| HostError::Conflict(
        "Switch to a local branch before pushing. Detached HEAD cannot be pushed from DraftMatter.".into(),
    ))?;
    if request
        .branch
        .as_deref()
        .is_some_and(|branch| branch != current)
    {
        return Err(HostError::InvalidProject(
            "Only the current branch can be pushed from DraftMatter.".into(),
        ));
    }
    let (remote, destination) = if let Some(remote) = remote {
        (remote, format!("refs/heads/{current}"))
    } else {
        let read_config = |key: &str| -> Result<String, HostError> {
            let output = require_success(
                run_git(&context.repository_root, &["config", "--get", key])?,
                "read the current branch upstream",
            )?;
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        };
        let name = read_config(&format!("branch.{current}.remote"))?;
        let remote = validate_remote(&context, Some(&name))?.unwrap();
        let destination = read_config(&format!("branch.{current}.merge"))?;
        let target = destination.strip_prefix("refs/heads/").ok_or_else(|| {
            HostError::InvalidProject("The upstream must refer to a remote branch.".into())
        })?;
        validate_branch_name(&context, target)?;
        (remote, destination)
    };
    // An explicit refspec avoids configured '+' push refspecs; disabling mirror
    // also prevents repository configuration from turning this into a forced push.
    let refspec = format!("refs/heads/{current}:{destination}");
    let mirror = format!("remote.{remote}.mirror=false");
    let mut arguments = vec![
        "-c",
        &mirror,
        "push",
        "--no-force",
        "--no-follow-tags",
        "--recurse-submodules=no",
    ];
    // A configured upstream may not resolve yet because it has never been
    // fetched. Preserve that configuration instead of replacing its target.
    if config_values(&context.repository_root, &format!("branch.{current}.remote"))?.is_empty()
        && config_values(&context.repository_root, &format!("branch.{current}.merge"))?.is_empty()
    { arguments.push("--set-upstream"); }
    arguments.extend([remote.as_str(), refspec.as_str()]);
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
    fn remote_configuration_preserves_working_files_and_distinct_push_url() {
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join("paper.md"), "base\n").unwrap();
        fs::write(project.path().join(".gitignore"), "data/\n").unwrap();
        commit_all(project.path(), "base");
        fs::write(project.path().join("paper.md"), "staged\n").unwrap();
        git(project.path(), ["add", "paper.md"]);
        fs::write(project.path().join("paper.md"), "working draft\n").unwrap();
        let index_before = fs::read(project.path().join(".git/index")).unwrap();
        let root = project.path().to_string_lossy().into_owned();
        let initial = git_set_remote_impl(GitSetRemoteRequest {
            root: root.clone(),
            name: "origin".into(),
            url: "https://example.invalid/research/paper.git".into(),
            expected_url: None,
        })
        .unwrap();
        assert_eq!(initial.len(), 1);
        git(
            project.path(),
            [
                "remote",
                "set-url",
                "--push",
                "origin",
                "git@example.invalid:research/publish.git",
            ],
        );
        let updated = git_set_remote_impl(GitSetRemoteRequest {
            root: root.clone(),
            name: "origin".into(),
            url: "https://example.invalid/research/renamed.git".into(),
            expected_url: Some(initial[0].url.clone()),
        })
        .unwrap();
        assert_eq!(
            updated[0].url,
            "https://example.invalid/research/renamed.git"
        );
        assert_eq!(
            updated[0].push_url.as_deref(),
            Some("git@example.invalid:research/publish.git")
        );
        assert_eq!(
            fs::read(project.path().join(".git/index")).unwrap(),
            index_before
        );
        assert_eq!(
            fs::read_to_string(project.path().join("paper.md")).unwrap(),
            "working draft\n"
        );
        assert_eq!(
            fs::read_to_string(project.path().join(".gitignore")).unwrap(),
            "data/\n"
        );
        assert!(upstream_name(&require_repository(&root).unwrap())
            .unwrap()
            .is_none());
    }

    #[test]
    fn remote_save_rejects_stale_snapshot_and_unsafe_urls_without_overwriting_config() {
        let project = tempdir().unwrap();
        initialise(project.path());
        git(
            project.path(),
            [
                "remote",
                "add",
                "origin",
                "https://example.invalid/current.git",
            ],
        );
        let root = project.path().to_string_lossy().into_owned();
        let before = fs::read(project.path().join(".git/config")).unwrap();
        for expected in [None, Some("https://example.invalid/old.git".into())] {
            assert!(matches!(
                git_set_remote_impl(GitSetRemoteRequest {
                    root: root.clone(),
                    name: "origin".into(),
                    url: "https://example.invalid/replacement.git".into(),
                    expected_url: expected
                }),
                Err(HostError::Conflict(_))
            ));
        }
        for url in [
            "ext::sh -c echo unsafe",
            "https://user:SECRET@example.invalid/paper.git",
            "https://SECRET@example.invalid/paper.git",
            "https://example.invalid/paper.git?token=SECRET",
            "-uanything",
            "git://example.invalid/paper.git",
            "http://example.invalid/paper.git",
            "ssh://-option/paper.git",
            "ssh://-oProxyCommand=anything@example.invalid/paper.git",
            "git@host::command",
            "bad\naddress",
        ] {
            let error = git_set_remote_impl(GitSetRemoteRequest {
                root: root.clone(),
                name: "other".into(),
                url: url.into(),
                expected_url: None,
            })
            .unwrap_err();
            assert!(!error.to_string().contains("SECRET"));
        }
        assert_eq!(
            fs::read(project.path().join(".git/config")).unwrap(),
            before
        );
        git(
            project.path(),
            [
                "config",
                "remote.origin.url",
                "https://user:SECRET@example.invalid/paper.git",
            ],
        );
        assert!(!git_remotes_impl(&root)
            .unwrap_err()
            .to_string()
            .contains("SECRET"));
    }

    #[test]
    fn first_explicit_push_configures_tracking_without_implicit_network_on_remote_save() {
        let remote = tempdir().unwrap();
        git(remote.path(), ["init", "--bare", "-b", "main"]);
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join("paper.md"), "paper\n").unwrap();
        commit_all(project.path(), "paper");
        let root = project.path().to_string_lossy().into_owned();
        git_set_remote_impl(GitSetRemoteRequest {
            root: root.clone(),
            name: "origin".into(),
            url: remote.path().to_string_lossy().into_owned(),
            expected_url: None,
        })
        .unwrap();
        assert!(!remote.path().join("refs/heads/main").exists());
        let result = git_push_impl(GitRemoteRequest {
            root,
            remote: Some("origin".into()),
            branch: Some("main".into()),
        })
        .unwrap();
        assert_eq!(result.status.upstream.as_deref(), Some("origin/main"));
        assert!(remote.path().join("refs/heads/main").exists());
    }

    #[test]
    fn explicit_push_preserves_configured_upstream_before_it_has_been_fetched() {
        let remote = tempdir().unwrap();
        git(remote.path(), ["init", "--bare", "-b", "main"]);
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join("paper.md"), "paper\n").unwrap();
        commit_all(project.path(), "paper");
        git(project.path(), ["remote", "add", "origin", &remote.path().to_string_lossy()]);
        git(project.path(), ["config", "branch.main.remote", "origin"]);
        git(project.path(), ["config", "branch.main.merge", "refs/heads/published"]);
        let root = project.path().to_string_lossy().into_owned();
        assert!(upstream_name(&require_repository(&root).unwrap()).unwrap().is_none());
        git_push_impl(GitRemoteRequest { root, remote: Some("origin".into()), branch: Some("main".into()) }).unwrap();
        assert_eq!(config_values(project.path(), "branch.main.merge").unwrap(), vec!["refs/heads/published"]);
    }

    #[test]
    fn clone_creates_an_independent_repository_with_inert_manuscript_and_code() {
        let source = tempdir().unwrap();
        initialise(source.path());
        fs::write(source.path().join("paper.md"), "# A paper\n").unwrap();
        fs::write(
            source.path().join("setup.py"),
            "raise RuntimeError('must not run')\n",
        )
        .unwrap();
        commit_all(source.path(), "paper");
        let parent = tempdir().unwrap();
        let result = git_clone_impl(GitCloneRequest {
            url: source.path().to_string_lossy().into_owned(),
            parent: parent.path().to_string_lossy().into_owned(),
            folder_name: "Cloned paper".into(),
        })
        .unwrap();
        let root = Path::new(&result.root);
        assert_eq!(
            fs::read_to_string(root.join("paper.md"))
                .unwrap()
                .replace("\r\n", "\n"),
            "# A paper\n"
        );
        assert!(root.join("setup.py").is_file());
        assert!(root.join(".git").is_dir());
        let status = git_status_impl(&result.root).unwrap();
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert!(status.entries.is_empty());
    }

    #[test]
    fn clone_never_overwrites_existing_folders_or_accepts_traversal() {
        let source = tempdir().unwrap();
        initialise(source.path());
        let parent = tempdir().unwrap();
        let occupied = parent.path().join("occupied");
        fs::create_dir(&occupied).unwrap();
        fs::write(occupied.join("keep.txt"), "keep\n").unwrap();
        for name in [
            "occupied",
            "../escape",
            ".",
            ".git",
            "nested/child",
            "nested\\child",
            "bad:name",
            "-option",
        ] {
            assert!(git_clone_impl(GitCloneRequest {
                url: source.path().to_string_lossy().into_owned(),
                parent: parent.path().to_string_lossy().into_owned(),
                folder_name: name.into()
            })
            .is_err());
        }
        assert_eq!(
            fs::read_to_string(occupied.join("keep.txt")).unwrap(),
            "keep\n"
        );
        assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 1);
    }

    #[test]
    fn clone_failure_keeps_only_its_reserved_folder_and_reports_it() {
        let parent = tempdir().unwrap();
        let error = git_clone_impl(GitCloneRequest {
            url: parent
                .path()
                .join("missing-source")
                .to_string_lossy()
                .into_owned(),
            parent: parent.path().to_string_lossy().into_owned(),
            folder_name: "incomplete".into(),
        })
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("incomplete clone folder was kept"));
        assert!(parent.path().join("incomplete").is_dir());
        assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn git_runner_rejects_transport_helpers_after_url_rewrite() {
        let parent = tempdir().unwrap();
        let marker = parent.path().join("helper-ran");
        let rewrite = format!(
            "url.ext::sh -c touch% {}.insteadOf=https://example.invalid/",
            marker.display()
        );
        let output = run_git(
            parent.path(),
            &[
                "-c",
                &rewrite,
                "-c",
                "protocol.ext.allow=always",
                "clone",
                "--no-checkout",
                "--",
                "https://example.invalid/paper.git",
                "blocked",
            ],
        )
        .unwrap();
        assert!(!output.status.success());
        assert!(!marker.exists());
        assert!(String::from_utf8_lossy(&output.stderr).contains("transport 'ext' not allowed"));
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
    fn selected_commit_in_a_parent_repository_preserves_other_index_and_worktree_versions() {
        let repository = tempdir().unwrap();
        initialise(repository.path());
        let project = repository.path().join("article");
        fs::create_dir(&project).unwrap();
        fs::write(project.join("paper.qmd"), "Original paper\n").unwrap();
        fs::write(repository.path().join("notes.md"), "Original notes\n").unwrap();
        commit_all(repository.path(), "Base project");
        fs::write(repository.path().join("notes.md"), "Staged notes\n").unwrap();
        git(repository.path(), ["add", "notes.md"]);
        fs::write(repository.path().join("notes.md"), "Newer unstaged notes\n").unwrap();
        fs::write(project.join("paper.qmd"), "Revised paper\n").unwrap();
        let root = project.to_string_lossy().into_owned();

        let status = git_status_impl(&root).unwrap();
        assert_eq!(status.project_prefix, "article");
        assert_eq!(status.entries.len(), 1);
        assert_eq!(status.entries[0].path, "paper.qmd");
        assert_eq!(
            status.repository_root,
            Some(
                fs::canonicalize(repository.path())
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            )
        );
        assert!(matches!(
            git_initialize_impl(&root),
            Err(HostError::Conflict(_))
        ));
        assert!(!project.join(".git").exists());

        git_create_checkpoint_impl(GitCheckpointRequest {
            root: root.clone(),
            paths: vec!["paper.qmd".into()],
            message: "Revise paper only".into(),
        })
        .unwrap();
        assert_eq!(
            git(repository.path(), ["show", "HEAD:article/paper.qmd"]).stdout,
            b"Revised paper\n"
        );
        assert_eq!(
            git(repository.path(), ["show", "HEAD:notes.md"]).stdout,
            b"Original notes\n"
        );
        assert_eq!(
            git(repository.path(), ["show", ":notes.md"]).stdout,
            b"Staged notes\n"
        );
        assert_eq!(
            fs::read(repository.path().join("notes.md")).unwrap(),
            b"Newer unstaged notes\n"
        );
        assert!(git_status_impl(&root).unwrap().entries.is_empty());
        assert_eq!(
            git_history_impl(&root).unwrap()[0].message,
            "Revise paper only"
        );
    }

    #[test]
    fn selecting_a_staged_rename_commits_both_names_without_other_staged_edits() {
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join("paper.qmd"), "# Manuscript\n").unwrap();
        fs::write(project.path().join("notes.md"), "Original notes\n").unwrap();
        commit_all(project.path(), "Base manuscript");
        git(project.path(), ["mv", "paper.qmd", "article.qmd"]);
        fs::write(project.path().join("notes.md"), "Staged notes\n").unwrap();
        git(project.path(), ["add", "notes.md"]);
        fs::write(project.path().join("notes.md"), "Newer working notes\n").unwrap();
        let root = project.path().to_string_lossy().into_owned();

        git_create_checkpoint_impl(GitCheckpointRequest {
            root: root.clone(),
            paths: vec!["article.qmd".into()],
            message: "Rename manuscript".into(),
        })
        .unwrap();
        let tree = git(project.path(), ["ls-tree", "--name-only", "HEAD"]);
        assert_eq!(
            String::from_utf8_lossy(&tree.stdout),
            "article.qmd\nnotes.md\n"
        );
        assert_eq!(
            git(project.path(), ["show", "HEAD:article.qmd"]).stdout,
            b"# Manuscript\n"
        );
        assert_eq!(
            git(project.path(), ["show", "HEAD:notes.md"]).stdout,
            b"Original notes\n"
        );
        assert_eq!(
            git(project.path(), ["show", ":notes.md"]).stdout,
            b"Staged notes\n"
        );
        assert_eq!(
            fs::read(project.path().join("notes.md")).unwrap(),
            b"Newer working notes\n"
        );
        let status = git_status_impl(&root).unwrap();
        assert_eq!(status.entries.len(), 1);
        assert_eq!(status.entries[0].path, "notes.md");
    }

    #[cfg(unix)]
    #[test]
    fn stalled_git_commands_time_out_and_stop_their_helpers() {
        let project = tempdir().unwrap();
        initialise(project.path());
        let started = Instant::now();
        let result = run_git_with_timeout(
            project.path(),
            &[
                "-c",
                "alias.stall=!sh -c 'sleep 0.3; echo late > helper-ran'",
                "stall",
            ],
            Duration::from_millis(50),
        );
        assert!(
            matches!(result, Err(HostError::Integration(message)) if message.contains("did not finish"))
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        thread::sleep(Duration::from_millis(400));
        assert!(!project.path().join("helper-ran").exists());
        assert!(run_git(project.path(), &["status", "--short"])
            .unwrap()
            .status
            .success());
    }

    #[test]
    fn ignored_datasets_are_not_listed_or_added_by_selected_commits() {
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join(".gitignore"), "data/\n").unwrap();
        fs::create_dir(project.path().join("data")).unwrap();
        fs::write(
            project.path().join("data/observations.csv"),
            "private,measurements\n",
        )
        .unwrap();
        fs::write(project.path().join("paper.qmd"), "# Paper\n").unwrap();
        let root = project.path().to_string_lossy().into_owned();
        let status = git_status_impl(&root).unwrap();
        assert!(!status
            .entries
            .iter()
            .any(|entry| entry.path.starts_with("data/")));

        git_create_checkpoint_impl(GitCheckpointRequest {
            root: root.clone(),
            paths: vec!["paper.qmd".into()],
            message: "Paper without data".into(),
        })
        .unwrap();
        assert_eq!(
            git(project.path(), ["ls-tree", "--name-only", "-r", "HEAD"]).stdout,
            b"paper.qmd\n"
        );
        assert!(git_create_checkpoint_impl(GitCheckpointRequest {
            root,
            paths: vec!["data/observations.csv".into()],
            message: "Attempt ignored file".into()
        })
        .is_err());
        assert_eq!(git(project.path(), ["ls-files"]).stdout, b"paper.qmd\n");
        assert_eq!(
            fs::read(project.path().join(".gitignore")).unwrap(),
            b"data/\n"
        );
        assert!(project.path().join("data/observations.csv").exists());
    }

    #[test]
    fn new_files_have_read_only_diffs_without_staging_or_running_text_converters() {
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(
            project.path().join(".gitattributes"),
            "*.qmd diff=fixture\n",
        )
        .unwrap();
        git(
            project.path(),
            [
                "config",
                "diff.fixture.textconv",
                "sh -c 'touch converter-ran'",
            ],
        );
        fs::write(
            project.path().join("paper.qmd"),
            "# New paper\n\nNew result.\n",
        )
        .unwrap();
        let root = project.path().to_string_lossy().into_owned();

        let preview = git_diff_impl(GitDiffRequest {
            root: root.clone(),
            path: "paper.qmd".into(),
            staged: false,
        })
        .unwrap();
        assert!(preview.text.contains("+# New paper"));
        assert!(preview.text.contains("+New result."));
        assert!(!preview.binary);
        assert!(!project.path().join("converter-ran").exists());
        assert!(git(project.path(), ["diff", "--cached", "--name-only"])
            .stdout
            .is_empty());
        assert!(git_status_impl(&root)
            .unwrap()
            .entries
            .iter()
            .all(|entry| !entry.staged));
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
    fn push_uses_the_configured_upstream_when_its_branch_name_differs() {
        let remote = tempdir().unwrap();
        git(remote.path(), ["init", "--bare", "-b", "published"]);
        let project = tempdir().unwrap();
        initialise(project.path());
        fs::write(project.path().join("paper.qmd"), "Base manuscript\n").unwrap();
        commit_all(project.path(), "Base");
        git(
            project.path(),
            ["remote", "add", "origin", &remote.path().to_string_lossy()],
        );
        git(project.path(), ["push", "-u", "origin", "main:published"]);
        fs::write(project.path().join("paper.qmd"), "Revised manuscript\n").unwrap();
        commit_all(project.path(), "Revise manuscript");

        let result = git_push_impl(GitRemoteRequest {
            root: project.path().to_string_lossy().into_owned(),
            remote: None,
            branch: None,
        })
        .unwrap();
        assert_eq!(result.status.upstream.as_deref(), Some("origin/published"));
        assert_eq!(result.status.ahead, 0);
        assert_eq!(
            git(remote.path(), ["show", "published:paper.qmd"]).stdout,
            b"Revised manuscript\n"
        );
        assert_eq!(
            git(
                remote.path(),
                ["for-each-ref", "--format=%(refname:short)", "refs/heads"]
            )
            .stdout,
            b"published\n"
        );
    }

    #[test]
    fn divergent_pull_and_push_stop_and_preserve_both_branches() {
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
        let remote_head = git(remote.path(), ["rev-parse", "refs/heads/main"]).stdout;
        // Even a force refspec or mirror configured by another tool cannot
        // change the non-forced behavior of this application's Push action.
        git(
            project.path(),
            [
                "config",
                "remote.origin.push",
                "+refs/heads/main:refs/heads/main",
            ],
        );
        git(project.path(), ["config", "remote.origin.mirror", "true"]);
        let pushed = git_push_impl(GitRemoteRequest {
            root: project.path().to_string_lossy().into_owned(),
            remote: None,
            branch: None,
        });
        assert!(matches!(pushed, Err(HostError::Integration(message)) if message.contains("non-fast-forward")));
        assert_eq!(
            git(remote.path(), ["rev-parse", "refs/heads/main"]).stdout,
            remote_head
        );
        assert_eq!(
            String::from_utf8_lossy(&git(project.path(), ["rev-parse", "HEAD"]).stdout).trim(),
            local_head
        );
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
        assert!(sanitise_message(format!("{}é", "a".repeat(4095)).as_bytes()).ends_with('…'));
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
    fn viewing_diffs_never_invokes_a_repository_text_converter() {
        let project = tempdir().unwrap();
        let path = project.path();
        initialise(path);
        fs::write(path.join(".gitattributes"), "*.qmd diff=fixture\n").unwrap();
        fs::write(path.join("paper.qmd"), "first\n").unwrap();
        commit_all(path, "First version");
        git(
            path,
            [
                "config",
                "diff.fixture.textconv",
                "sh -c 'touch converter-ran; cat \"$0\"'",
            ],
        );
        fs::write(path.join("paper.qmd"), "second\n").unwrap();
        git(path, ["add", "paper.qmd"]);
        fs::write(path.join("paper.qmd"), "third\n").unwrap();
        let root = path.to_string_lossy().into_owned();
        for (staged, added) in [(true, "+second"), (false, "+third")] {
            let diff = git_diff_impl(GitDiffRequest {
                root: root.clone(),
                path: "paper.qmd".into(),
                staged,
            })
            .unwrap();
            assert!(diff.text.contains(added));
        }
        let hash = git_history_impl(&root).unwrap()[0].hash.clone();
        let diff = git_checkpoint_diff_impl(GitCheckpointDiffRequest { root, hash }).unwrap();
        assert!(diff.text.contains("+first"));
        assert!(!path.join("converter-ran").exists());
    }

    #[cfg(unix)]
    #[test]
    fn history_and_checkpoint_diff_do_not_start_a_repository_signature_verifier() {
        let project = tempdir().unwrap();
        let path = project.path();
        initialise(path);
        fs::write(path.join("paper.qmd"), "base\n").unwrap();
        git(path, ["add", "paper.qmd"]);
        let tree = git(path, ["write-tree"]);
        let tree = String::from_utf8(tree.stdout).unwrap();
        let commit = format!(
            "tree {}\nauthor Test <test@example.invalid> 1720000000 +0000\ncommitter Test <test@example.invalid> 1720000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abcdefg\n -----END PGP SIGNATURE-----\n\nTest\n",
            tree.trim()
        );
        fs::write(path.join(".git/fixture-commit"), commit).unwrap();
        let hash = git(
            path,
            ["hash-object", "-w", "-t", "commit", ".git/fixture-commit"],
        );
        let hash = String::from_utf8(hash.stdout).unwrap().trim().to_string();
        git(path, ["update-ref", "HEAD", &hash]);
        let verifier = path.join("verify-signature");
        fs::write(&verifier, "#!/bin/sh\ntouch verifier-ran\nexit 1\n").unwrap();
        fs::set_permissions(&verifier, fs::Permissions::from_mode(0o755)).unwrap();
        git(path, ["config", "gpg.program", &verifier.to_string_lossy()]);
        git(path, ["config", "log.showSignature", "true"]);
        git(path, ["log", "-1", "--format=%H"]);
        let marker = path.join("verifier-ran");
        assert!(
            marker.exists(),
            "unrestricted Git should try to verify the signature"
        );
        fs::remove_file(&marker).unwrap();
        let root = path.to_string_lossy().into_owned();
        assert_eq!(git_history_impl(&root).unwrap()[0].hash, hash);
        let diff = git_checkpoint_diff_impl(GitCheckpointDiffRequest { root, hash }).unwrap();
        assert!(diff.text.contains("+base"));
        assert!(!marker.exists());
    }

    #[cfg(unix)]
    #[test]
    fn repository_network_commands_are_refused_before_fetch_pull_or_push() {
        let project = tempdir().unwrap();
        let path = project.path();
        initialise(path);
        fs::write(path.join("paper.md"), "base\n").unwrap();
        commit_all(path, "base");
        git(path, ["remote", "add", "origin", "ssh://example.invalid/paper.git"]);
        let executable = path.join("untrusted-ssh");
        fs::write(&executable, "#!/bin/sh\ntouch network-command-ran\nexit 1\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        git(path, ["config", "core.sshCommand", &executable.to_string_lossy()]);
        let control = Command::new("git")
            .current_dir(path)
            .args(["fetch", "origin"])
            .output()
            .unwrap();
        assert!(!control.status.success());
        let marker = path.join("network-command-ran");
        assert!(marker.exists(), "unrestricted Git must execute the repository's SSH command");
        fs::remove_file(&marker).unwrap();
        git(path, ["config", "--unset", "core.sshCommand"]);
        git(path, ["config", "include.path", "network.conf"]);
        let root = path.to_string_lossy().into_owned();
        let index_before = fs::read(path.join(".git/index")).unwrap();
        for section in [
            "[core]\nsshCommand",
            "[core]\naskPass",
            "[credential]\nhelper",
            "[credential \"https://example.invalid\"]\nhelper",
            "[remote \"origin\"]\nuploadpack",
            "[remote \"origin\"]\nreceivepack",
        ] {
            fs::write(path.join(".git/network.conf"), format!("{section} = {}\n", executable.display())).unwrap();
            for operation in [git_fetch_impl, git_pull_impl, git_push_impl] {
                let error = operation(GitRemoteRequest {
                    root: root.clone(), remote: Some("origin".into()), branch: None,
                }).unwrap_err();
                assert!(matches!(error, HostError::Integration(message) if message.contains("repository defines a Git network command")));
                assert!(!marker.exists());
                assert_eq!(fs::read(path.join(".git/index")).unwrap(), index_before);
                assert_eq!(fs::read_to_string(path.join("paper.md")).unwrap(), "base\n");
            }
            assert!(git_status_impl(&root).is_ok(), "read-only inspection remains available");
        }
    }

    #[cfg(unix)]
    #[test]
    fn repository_signing_commands_are_refused_before_committing_or_staging() {
        let project = tempdir().unwrap();
        let path = project.path();
        initialise(path);
        fs::write(path.join("paper.md"), "base\n").unwrap();
        commit_all(path, "base");
        fs::write(path.join("paper.md"), "new version\n").unwrap();
        git(path, ["add", "paper.md"]);
        let executable = path.join("untrusted-signer");
        fs::write(&executable, "#!/bin/sh\ntouch signing-command-ran\nexit 1\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        git(path, ["config", "gpg.program", &executable.to_string_lossy()]);
        git(path, ["config", "commit.gpgSign", "true"]);
        let control = Command::new("git").current_dir(path).args(["commit", "-m", "unsafe control"]).output().unwrap();
        assert!(!control.status.success());
        let marker = path.join("signing-command-ran");
        assert!(marker.exists(), "unrestricted Git must execute the repository's signing command");
        fs::remove_file(&marker).unwrap();
        let root = path.to_string_lossy().into_owned();
        let index_before = fs::read(path.join(".git/index")).unwrap();
        let head_before = git(path, ["rev-parse", "HEAD"]).stdout;
        let commit = git_create_commit_impl(GitCommitRequest { root: root.clone(), message: "save".into() }).unwrap_err();
        let checkpoint = git_create_checkpoint_impl(GitCheckpointRequest {
            root: root.clone(), paths: vec!["paper.md".into()], message: "save selected".into(),
        }).unwrap_err();
        for error in [commit, checkpoint] {
            assert!(matches!(error, HostError::Integration(message) if message.contains("repository defines a Git signing command")));
        }
        assert!(!marker.exists());
        assert_eq!(fs::read(path.join(".git/index")).unwrap(), index_before);
        assert_eq!(git(path, ["rev-parse", "HEAD"]).stdout, head_before);
        assert!(git_history_impl(&root).is_ok(), "read-only history remains available");
    }

    #[cfg(unix)]
    #[test]
    fn committing_staged_changes_never_runs_a_trusted_exit_code_external_diff() {
        let project = tempdir().unwrap();
        let path = project.path();
        initialise(path);
        fs::write(path.join("paper.md"), "base\n").unwrap();
        commit_all(path, "base");
        fs::write(path.join("paper.md"), "new version\n").unwrap();
        git(path, ["add", "paper.md"]);
        let executable = path.join("untrusted-diff");
        fs::write(&executable, "#!/bin/sh\ntouch external-diff-ran\nexit 0\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        git(path, ["config", "diff.external", &executable.to_string_lossy()]);
        git(path, ["config", "diff.trustExitCode", "true"]);
        git(path, ["diff", "--cached", "--quiet"]);
        let marker = path.join("external-diff-ran");
        assert!(marker.exists(), "unrestricted Git must execute the trusted-exit-code external diff");
        fs::remove_file(&marker).unwrap();
        git_create_commit_impl(GitCommitRequest {
            root: path.to_string_lossy().into_owned(), message: "save staged draft".into(),
        }).unwrap();
        assert!(!marker.exists());
        assert_eq!(git(path, ["show", "HEAD:paper.md"]).stdout, b"new version\n");
    }

    #[cfg(unix)]
    #[test]
    fn repository_ssh_default_key_command_cannot_execute_when_saving_a_version() {
        let project = tempdir().unwrap();
        let path = project.path();
        initialise(path);
        fs::write(path.join("paper.md"), "base\n").unwrap();
        commit_all(path, "base");
        fs::write(path.join("paper.md"), "new version\n").unwrap();
        git(path, ["add", "paper.md"]);
        let executable = path.join("untrusted-default-key");
        fs::write(&executable, "#!/bin/sh\ntouch default-key-ran\nexit 1\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        git(path, ["config", "gpg.format", "ssh"]);
        git(path, ["config", "gpg.ssh.defaultKeyCommand", &executable.to_string_lossy()]);
        git(path, ["config", "commit.gpgSign", "true"]);
        let control = Command::new("git").current_dir(path)
            .env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_SYSTEM", "/dev/null")
            .args(["commit", "-m", "unsafe control"]).output().unwrap();
        assert!(!control.status.success());
        let marker = path.join("default-key-ran");
        assert!(marker.exists(), "unrestricted Git must execute the SSH default-key command");
        fs::remove_file(&marker).unwrap();
        let index_before = fs::read(path.join(".git/index")).unwrap();
        let error = git_create_checkpoint_impl(GitCheckpointRequest {
            root: path.to_string_lossy().into_owned(), paths: vec!["paper.md".into()], message: "save version".into(),
        }).unwrap_err();
        assert!(matches!(error, HostError::Integration(message) if message.contains("repository defines a Git signing command")));
        assert!(!marker.exists());
        assert_eq!(fs::read(path.join(".git/index")).unwrap(), index_before);
    }

    #[cfg(unix)]
    #[test]
    fn repository_filter_commands_are_refused_without_changing_the_worktree_or_index() {
        let project = tempdir().unwrap();
        let path = project.path();
        initialise(path);
        fs::write(path.join(".gitattributes"), "*.qmd filter=probe\n").unwrap();
        fs::write(path.join("paper.qmd"), "first\n").unwrap();
        commit_all(path, "Initial version");
        fs::write(path.join("paper.qmd"), "second version\n").unwrap();
        git(path, ["config", "include.path", "filter.conf"]);
        let index_before = fs::read(path.join(".git/index")).unwrap();
        let root = path.to_string_lossy().into_owned();
        let marker = path.join("filter-ran");

        for (key, command) in [
            ("clean", "tee filter-ran"),
            ("process", "echo ran > filter-ran; exit 1"),
            ("smudge", "tee filter-ran"),
        ] {
            fs::write(
                path.join(".git/filter.conf"),
                format!("[filter \"probe\"]\n\t{key} = \"{command}\"\n\trequired = true\n"),
            )
            .unwrap();
            if key == "clean" {
                git(
                    path,
                    [
                        "diff",
                        "--numstat",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--",
                        "paper.qmd",
                    ],
                );
                assert!(
                    marker.exists(),
                    "the Git numstat control must run this filter"
                );
                fs::remove_file(&marker).unwrap();
            }
            let status = git_status_impl(&root).unwrap_err();
            let diff = git_diff_impl(GitDiffRequest {
                root: root.clone(),
                path: "paper.qmd".into(),
                staged: false,
            })
            .unwrap_err();
            let stage = git_stage_impl(GitStageRequest {
                root: root.clone(),
                paths: vec!["paper.qmd".into()],
            })
            .unwrap_err();
            for error in [status, diff, stage] {
                assert!(
                    matches!(error, HostError::Integration(message) if message.contains("repository defines a Git filter command"))
                );
            }
            assert!(!marker.exists());
            assert_eq!(
                fs::read_to_string(path.join("paper.qmd")).unwrap(),
                "second version\n"
            );
            assert_eq!(fs::read(path.join(".git/index")).unwrap(), index_before);
        }

        fs::write(
            path.join(".git/filter.conf"),
            "[filter \"probe\"]\n\trequired = false\n",
        )
        .unwrap();
        assert!(
            git_status_impl(&root).is_ok(),
            "a repository filter policy alone defines no command"
        );
        git(path, ["config", "extensions.worktreeConfig", "true"]);
        git(
            path,
            [
                "config",
                "--worktree",
                "filter.probe.clean",
                "tee filter-ran",
            ],
        );
        assert!(
            matches!(git_status_impl(&root), Err(HostError::Integration(message)) if message.contains("repository defines a Git filter command"))
        );
        assert!(!marker.exists());
    }

    #[cfg(unix)]
    #[test]
    fn repository_status_and_diff_report_changed_gitlinks_without_running_submodule_filters() {
        let project = tempdir().unwrap();
        let path = project.path();
        initialise(path);
        let sub = path.join("sub");
        fs::create_dir(&sub).unwrap();
        initialise(&sub);
        fs::write(sub.join("paper.qmd"), "base\n").unwrap();
        fs::write(sub.join(".gitattributes"), "*.qmd filter=probe\n").unwrap();
        commit_all(&sub, "Initial submodule version");
        fs::write(
            path.join(".gitmodules"),
            "[submodule \"sub\"]\n\tpath = sub\n\turl = ./sub\n",
        )
        .unwrap();
        commit_all(path, "Initial gitlink");
        git(
            &sub,
            ["commit", "--allow-empty", "-m", "New submodule revision"],
        );
        git(
            &sub,
            ["config", "filter.probe.clean", "tee submodule-filter-ran"],
        );
        fs::write(sub.join("paper.qmd"), "dirty worktree\n").unwrap();
        git(path, ["config", "diff.submodule", "diff"]);
        git(path, ["config", "submodule.sub.ignore", "none"]);

        let root = path.to_string_lossy().into_owned();
        let status = git_status_impl(&root).unwrap();
        assert!(status
            .entries
            .iter()
            .any(|entry| entry.path == "sub" && entry.unstaged));
        let diff = git_diff_impl(GitDiffRequest {
            root,
            path: "sub".into(),
            staged: false,
        })
        .unwrap();
        assert!(diff.text.contains("Subproject commit"));
        assert!(!sub.join("submodule-filter-ran").exists());
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

//! Reviewed first commits include portable project infrastructure, never local runtime state.
use super::*;
use std::collections::BTreeSet;

const MAX_PLAN_FILES: usize = 2_000;
const MAX_PLAN_ENTRIES: usize = 10_000;
const MAX_IGNORE_BYTES: u64 = 1024 * 1024;
const IGNORE_START: &str = "# DraftMatter local state (managed)";
const IGNORE_END: &str = "# End DraftMatter local state";
const IGNORE_RULES: &str = "\
!/.gitignore
/.draftmatter/*
!/.draftmatter/project.json
!/.draftmatter/ai-integration.json
!/.draftmatter/citations.lock.json
!/.draftmatter/cited-records.json
!/.draftmatter/outputs/
/.draftmatter/outputs/*
!/.draftmatter/outputs/*/
/.draftmatter/outputs/*/*
!/.draftmatter/outputs/*/manifest.json
/.agents/cache/
/.agents/logs/
/.agents/sessions/
/.agent/cache/
/.agent/logs/
/.agent/sessions/
/.codex/
/.claude/
/.vibe/
/.mcp.json
/.github/mcp.json
.env
.env.*
!.env.example
.DS_Store
.venv/
venv/
node_modules/
__pycache__/
target/
.quarto/
_freeze/
_site/
";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitInitializationEntry {
    pub path: String,
    pub bytes: u64,
    pub modified_ms: u64,
    pub suggested: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitInitializationPlan {
    pub repository_root: String,
    pub entries: Vec<GitInitializationEntry>,
    pub original_ignore_content: Option<String>,
    pub ignore_content: String,
    pub ignore_will_change: bool,
    pub existing_ignore: bool,
    pub truncated: bool,
    pub repository_exists: bool,
    pub has_commits: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitInitializationExpectedFile {
    pub path: String,
    pub bytes: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitInitializeRequest {
    pub root: String,
    pub paths: Vec<String>,
    pub message: String,
    /// Exact original .gitignore, or null when the reviewed project had none.
    pub expected_ignore: Option<String>,
    #[serde(default)]
    pub expected_files: Option<Vec<GitInitializationExpectedFile>>,
}

fn durable_metadata(path: &str) -> bool {
    matches!(
        path,
        ".draftmatter/project.json"
            | ".draftmatter/ai-integration.json"
            | ".draftmatter/citations.lock.json"
            | ".draftmatter/cited-records.json"
    ) || path
        .strip_prefix(".draftmatter/outputs/")
        .is_some_and(|tail| {
            let parts = tail.split('/').collect::<Vec<_>>();
            parts.len() == 2 && !parts[0].is_empty() && parts[1] == "manifest.json"
        })
}

fn infrastructure(path: &str) -> bool {
    durable_metadata(path)
        || path.starts_with(".agents/skills/")
        || path.starts_with(".agent/skills/")
        || matches!(
            path,
            ".gitignore"
                | ".gitattributes"
                | "AGENTS.md"
                | "CLAUDE.md"
                | "Project.toml"
                | "Manifest.toml"
                | "pyproject.toml"
                | "uv.lock"
                | "renv.lock"
                | "environment.yml"
                | "environment.yaml"
                | ".python-version"
                | ".Rprofile"
        )
        || !path.contains('/') && path.starts_with("requirements") && path.ends_with(".txt")
}

fn permitted_path(path: &str) -> bool {
    let Ok(relative) = safe_relative(path) else {
        return false;
    };
    if slash_path(&relative) != path || path.contains('\\') {
        return false;
    }
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.iter().any(|part| {
        matches!(
            part.to_ascii_lowercase().as_str(),
            ".git"
                | ".ssh"
                | ".aws"
                | ".gnupg"
                | ".codex"
                | ".vibe"
                | ".claude"
                | ".venv"
                | "venv"
                | "node_modules"
                | "__pycache__"
                | ".quarto"
                | "_freeze"
                | "_site"
        ) || part.eq_ignore_ascii_case(".env")
            || part.to_ascii_lowercase().starts_with(".env.") && *part != ".env.example"
    }) {
        return false;
    }
    if path == ".mcp.json" || path == ".github/mcp.json" {
        return false;
    }
    if path.starts_with(".draftmatter/") {
        return durable_metadata(path);
    }
    if path.starts_with(".agents/") || path.starts_with(".agent/") {
        return path.starts_with(".agents/skills/") || path.starts_with(".agent/skills/");
    }
    true
}

fn allowed_directory(path: &str) -> bool {
    let leaf = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    if matches!(
        leaf.as_str(),
        ".git"
            | ".ssh"
            | ".aws"
            | ".gnupg"
            | ".codex"
            | ".vibe"
            | ".claude"
            | ".venv"
            | "venv"
            | "node_modules"
            | "target"
            | "__pycache__"
            | ".quarto"
            | "_freeze"
            | "_site"
    ) {
        return false;
    }
    if path == ".draftmatter" || path == ".draftmatter/outputs" {
        return true;
    }
    if path.starts_with(".draftmatter/") {
        return path
            .strip_prefix(".draftmatter/outputs/")
            .is_some_and(|tail| !tail.contains('/'));
    }
    for directory in [".agents", ".agent"] {
        if path == directory
            || path == format!("{directory}/skills")
            || path.starts_with(&format!("{directory}/skills/"))
        {
            return true;
        }
        if path.starts_with(&format!("{directory}/")) {
            return false;
        }
    }
    true
}

fn read_ignore(root: &Path) -> Result<Option<String>, HostError> {
    let path = root.join(".gitignore");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_IGNORE_BYTES
    {
        return Err(HostError::InvalidPath(
            "The project's .gitignore must be an ordinary UTF-8 file no larger than 1 MiB.".into(),
        ));
    }
    Ok(Some(fs::read_to_string(path)?))
}

fn proposed_ignore(original: Option<&str>) -> Result<String, HostError> {
    let block = format!("{IGNORE_START}\n{IGNORE_RULES}{IGNORE_END}\n");
    let original = original.unwrap_or("");
    match (original.find(IGNORE_START), original.find(IGNORE_END)) {
        (Some(start), Some(end)) if end >= start => {
            let after = end + IGNORE_END.len();
            let after = after + usize::from(original.as_bytes().get(after) == Some(&b'\n'));
            Ok(format!("{}{}{}", &original[..start], block, &original[after..]))
        }
        (None, None) => Ok(if original.is_empty() { block } else { format!("{block}\n{original}") }),
        _ => Err(HostError::Conflict("The managed .gitignore block is incomplete. Repair its markers before initializing Git.".into())),
    }
}

fn scan(
    root: &Path,
    directory: &Path,
    depth: usize,
    visited: &mut usize,
    entries: &mut Vec<GitInitializationEntry>,
    truncated: &mut bool,
) -> Result<(), HostError> {
    if depth > 10 {
        *truncated = true;
        return Ok(());
    }
    // Even a single directory may contain millions of files. Bound collection
    // before sorting, with one extra entry solely to detect truncation.
    let remaining = MAX_PLAN_ENTRIES.saturating_sub(*visited);
    let mut children = fs::read_dir(directory)?
        .take(remaining + 1)
        .collect::<Result<Vec<_>, _>>()?;
    if children.len() > remaining {
        children.pop();
        *truncated = true;
    }
    children.sort_by_key(|entry| entry.file_name());
    for entry in children {
        if *visited >= MAX_PLAN_ENTRIES || entries.len() >= MAX_PLAN_FILES {
            *truncated = true;
            break;
        }
        *visited += 1;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let relative =
            slash_path(entry.path().strip_prefix(root).map_err(|_| {
                HostError::InvalidPath("A project file escaped its folder.".into())
            })?);
        if file_type.is_dir() {
            if allowed_directory(&relative) {
                scan(root, &entry.path(), depth + 1, visited, entries, truncated)?
            }
        } else if file_type.is_file() && permitted_path(&relative) {
            let metadata = entry.metadata()?;
            let reason = if relative == ".draftmatter/project.json" {
                "Project configuration; review its environment paths and collaboration settings before committing."
            } else if infrastructure(&relative) {
                "Portable project infrastructure."
            } else {
                "Additional project file; include it only when wanted."
            };
            entries.push(GitInitializationEntry {
                suggested: infrastructure(&relative),
                path: relative,
                bytes: metadata.len(),
                modified_ms: crate::modified_ms(&metadata),
                reason: reason.into(),
            });
        }
    }
    Ok(())
}

struct PreviewRepository(PathBuf);
impl Drop for PreviewRepository {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Git itself evaluates existing ignore rules, without initializing or modifying the project.
fn visible_files(root: &Path, managed_ignore: &str) -> Result<BTreeSet<String>, HostError> {
    let directory =
        std::env::temp_dir().join(format!("draftmatter-git-preview-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&directory)?;
    let temporary = PreviewRepository(directory);
    let metadata = temporary.0.join("metadata");
    require_success(
        run_git(
            root,
            &["init", "--bare", "--template=", &metadata.to_string_lossy()],
        )?,
        "prepare the read-only Git preview",
    )?;
    // info/exclude is lower priority than the user's .gitignore, matching a managed
    // block prepended before their untouched rules in the proposed .gitignore.
    fs::create_dir_all(metadata.join("info"))?;
    fs::write(metadata.join("info/exclude"), managed_ignore)?;
    let git_directory = format!("--git-dir={}", metadata.to_string_lossy());
    let work_tree = format!("--work-tree={}", root.to_string_lossy());
    let output = require_success(
        run_git(
            root,
            &[
                &git_directory,
                &work_tree,
                "ls-files",
                "--others",
                "--exclude-standard",
                "-z",
            ],
        )?,
        "read the Git initialization preview",
    )?;
    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .map(|value| String::from_utf8_lossy(value).to_string())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn command(root: &Path, arguments: &[&str]) -> Output {
        require_success(run_git(root, arguments).unwrap(), "run a Git test command").unwrap()
    }

    fn write(root: &Path, path: &str, content: &str) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn empty_repository(root: &Path) {
        command(root, &["init", "-b", "main"]);
        command(root, &["config", "user.name", "DraftMatter Test"]);
        command(
            root,
            &["config", "user.email", "draftmatter@example.invalid"],
        );
    }

    fn project(root: &Path) {
        for (path, content) in [
            ("paper.qmd", "# A portable paper\n"),
            ("references.bib", "@article{test,title={Test}}\n"),
            ("data/private.csv", "value\n42\n"),
            ("AGENTS.md", "Keep these human instructions.\n"),
            ("CLAUDE.md", "@AGENTS.md\n"),
            (".agents/skills/draftmatter-authoring/SKILL.md", "Portable skill\n"),
            (".agent/skills/team/SKILL.md", "Another portable skill\n"),
            (".agents/sessions/private.json", "private session"),
            (".draftmatter/project.json", "{\"schemaVersion\":1,\"name\":\"Study\",\"mainDocument\":\"paper.qmd\",\"execution\":{\"python\":{\"environment\":\"/local/python\"}},\"collaboration\":{\"schemaVersion\":1,\"serviceUrl\":\"https://sync.example.invalid\",\"workspaceId\":\"lab\",\"projectId\":\"paper\"}}"),
            (".draftmatter/ai-integration.json", "{\"schemaVersion\":2,\"protocolVersion\":\"1.0\",\"enabled\":true,\"localAdapters\":[]}"),
            (".draftmatter/citations.lock.json", "{}\n"),
            (".draftmatter/cited-records.json", "{}\n"),
            (".draftmatter/outputs/figure--abc/manifest.json", "{\"schemaVersion\":2}\n"),
            (".draftmatter/outputs/figure--abc/intermediate.tmp", "not portable"),
            (".draftmatter/recovery/old.qmd", "private recovery"),
            (".draftmatter/cache/cached.bin", "cache"),
            (".draftmatter/runtime/private.json", "private runtime"),
            (".draftmatter/execution/private.json", "private execution"),
            (".draftmatter/sync/account.json", "private sync"),
            (".draftmatter/sync-staging/pending.bin", "private staged transfer"),
            (".draftmatter/agent-audit.jsonl", "private audit"),
            (".draftmatter/agent-idempotency.json", "private replay state"),
            (".env", "TOKEN=never-commit"),
            (".codex/config.toml", "machine connection"),
            (".mcp.json", "machine connection"),
            ("node_modules/large.txt", "dependency"),
        ] { write(root, path, content) }
    }

    fn request(plan: &GitInitializationPlan, additional: &[&str]) -> GitInitializeRequest {
        let mut paths = plan
            .entries
            .iter()
            .filter(|entry| entry.suggested)
            .map(|entry| entry.path.clone())
            .collect::<Vec<_>>();
        paths.extend(additional.iter().map(|path| path.to_string()));
        paths.sort();
        paths.dedup();
        let expected_files = plan
            .entries
            .iter()
            .filter(|entry| paths.contains(&entry.path))
            .map(|entry| GitInitializationExpectedFile {
                path: entry.path.clone(),
                bytes: entry.bytes,
                modified_ms: entry.modified_ms,
            })
            .collect();
        GitInitializeRequest {
            root: plan.repository_root.clone(),
            paths,
            message: "Initialize portable project".into(),
            expected_ignore: plan.original_ignore_content.clone(),
            expected_files: Some(expected_files),
        }
    }

    #[test]
    fn preview_is_read_only_and_suggests_portable_infrastructure_only() {
        let directory = tempdir().unwrap();
        project(directory.path());
        let plan = git_initialization_plan_impl(&directory.path().to_string_lossy()).unwrap();
        assert!(!directory.path().join(".git").exists());
        assert!(!directory.path().join(".gitignore").exists());
        assert!(!plan.repository_exists);
        assert!(!plan.has_commits);
        assert!(!plan.truncated);
        let suggested = plan
            .entries
            .iter()
            .filter(|entry| entry.suggested)
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();
        for path in [
            ".gitignore",
            "AGENTS.md",
            "CLAUDE.md",
            ".agents/skills/draftmatter-authoring/SKILL.md",
            ".agent/skills/team/SKILL.md",
            ".draftmatter/project.json",
            ".draftmatter/ai-integration.json",
            ".draftmatter/citations.lock.json",
            ".draftmatter/cited-records.json",
            ".draftmatter/outputs/figure--abc/manifest.json",
        ] {
            assert!(suggested.contains(&path), "missing {path}")
        }
        for path in ["paper.qmd", "references.bib", "data/private.csv"] {
            assert!(plan
                .entries
                .iter()
                .any(|entry| entry.path == path && !entry.suggested));
        }
        assert!(!plan
            .entries
            .iter()
            .any(|entry| entry.path.contains("private.json")
                || entry.path == ".env"
                || entry.path.starts_with(".codex/")
                || entry.path == ".mcp.json"));
        assert!(plan
            .entries
            .iter()
            .find(|entry| entry.path == ".draftmatter/project.json")
            .unwrap()
            .reason
            .contains("environment paths"));
    }

    #[test]
    fn directory_preview_respects_its_remaining_entry_budget_before_sorting() {
        let directory = tempdir().unwrap();
        for index in 0..8 {
            write(directory.path(), &format!("file-{index}.csv"), "value\n");
        }
        let mut visited = MAX_PLAN_ENTRIES - 2;
        let mut entries = Vec::new();
        let mut truncated = false;
        scan(
            directory.path(),
            directory.path(),
            0,
            &mut visited,
            &mut entries,
            &mut truncated,
        )
        .unwrap();
        assert!(truncated);
        assert_eq!(visited, MAX_PLAN_ENTRIES);
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn new_project_folder_initializes_and_commits_with_explicit_user_identity() {
        const CHILD: &str = "DRAFTMATTER_BOOTSTRAP_IDENTITY_TEST";
        if std::env::var_os(CHILD).is_none() {
            // Isolate a configured user identity in a child test process. Never
            // mutate the real user's Git config or a parallel test's environment.
            let config = tempdir().unwrap();
            let path = config.path().join("gitconfig");
            fs::write(
                &path,
                "[user]\nname = Bootstrap Test\nemail = bootstrap@example.invalid\n",
            )
            .unwrap();
            let output = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "git_adapter::initialization::tests::new_project_folder_initializes_and_commits_with_explicit_user_identity", "--nocapture"])
                .env(CHILD, "1")
                .env("GIT_CONFIG_GLOBAL", path)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env_remove("GIT_AUTHOR_NAME")
                .env_remove("GIT_AUTHOR_EMAIL")
                .env_remove("GIT_COMMITTER_NAME")
                .env_remove("GIT_COMMITTER_EMAIL")
                .output().unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let directory = tempdir().unwrap();
        project(directory.path());
        let plan = git_initialization_plan_impl(&directory.path().to_string_lossy()).unwrap();
        assert!(!plan.repository_exists);
        let initialized =
            git_initialize_with_commit_impl(request(&plan, &["paper.qmd", "references.bib"]))
                .unwrap();
        assert!(initialized.created_ignore);
        assert!(initialized.initial_commit.is_some());
        assert!(directory.path().join(".git").is_dir());
        assert_eq!(
            command(directory.path(), &["rev-list", "--count", "HEAD"]).stdout,
            b"1\n"
        );
    }

    #[test]
    fn reviewed_first_commit_clones_to_a_reopenable_project_and_excludes_local_state() {
        let directory = tempdir().unwrap();
        project(directory.path());
        empty_repository(directory.path());
        write(directory.path(), ".gitignore", "# My manual rules\ndata/\n");
        let project_config = fs::read(directory.path().join(".draftmatter/project.json")).unwrap();
        let plan = git_initialization_plan_impl(&directory.path().to_string_lossy()).unwrap();
        assert_eq!(
            plan.original_ignore_content.as_deref(),
            Some("# My manual rules\ndata/\n")
        );
        assert!(plan.ignore_content.ends_with("# My manual rules\ndata/\n"));
        assert!(!plan
            .entries
            .iter()
            .any(|entry| entry.path.starts_with("data/")));
        let initialized =
            git_initialize_with_commit_impl(request(&plan, &["paper.qmd", "references.bib"]))
                .unwrap();
        let commit = initialized.initial_commit.unwrap();
        assert_eq!(
            command(directory.path(), &["rev-list", "--count", "HEAD"]).stdout,
            b"1\n"
        );
        assert!(commit
            .files
            .contains(&".draftmatter/ai-integration.json".into()));
        assert_eq!(
            fs::read(directory.path().join(".draftmatter/project.json")).unwrap(),
            project_config
        );
        for path in [
            ".draftmatter/recovery/old.qmd",
            ".draftmatter/cache/cached.bin",
            ".draftmatter/runtime/private.json",
            ".draftmatter/execution/private.json",
            ".draftmatter/sync/account.json",
            ".draftmatter/sync-staging/pending.bin",
            ".draftmatter/agent-audit.jsonl",
            ".draftmatter/agent-idempotency.json",
            ".draftmatter/outputs/figure--abc/intermediate.tmp",
            ".agents/sessions/private.json",
            ".env",
            ".codex/config.toml",
            ".mcp.json",
            "node_modules/large.txt",
        ] {
            assert!(
                git_command(directory.path())
                    .env_remove("GIT_LITERAL_PATHSPECS")
                    .args(["check-ignore", "--quiet", path])
                    .output()
                    .unwrap()
                    .status
                    .success(),
                "not ignored {path}"
            );
        }
        let clone_parent = tempdir().unwrap();
        let clone = clone_parent.path().join("cloned-study");
        command(
            clone_parent.path(),
            &[
                "clone",
                &directory.path().to_string_lossy(),
                &clone.to_string_lossy(),
            ],
        );
        let reopened = crate::open_project_impl(&clone.to_string_lossy()).unwrap();
        assert_eq!(reopened.config.main_document, "paper.qmd");
        assert_eq!(
            fs::read(clone.join(".draftmatter/project.json")).unwrap(),
            project_config
        );
        assert!(clone.join("AGENTS.md").is_file());
        assert!(clone
            .join(".agents/skills/draftmatter-authoring/SKILL.md")
            .is_file());
        assert!(clone
            .join(".draftmatter/outputs/figure--abc/manifest.json")
            .is_file());
        assert!(!clone.join("data/private.csv").exists());
        assert!(!clone.join(".draftmatter/runtime/private.json").exists());
    }

    #[test]
    fn init_rejects_private_files_and_changed_preview_before_modifying_any_files() {
        let directory = tempdir().unwrap();
        project(directory.path());
        let plan = git_initialization_plan_impl(&directory.path().to_string_lossy()).unwrap();
        let mut invalid = request(&plan, &[".draftmatter/sync/account.json"]);
        assert!(git_initialize_with_commit_impl(invalid.clone()).is_err());
        assert!(!directory.path().join(".git").exists());
        assert!(!directory.path().join(".gitignore").exists());
        invalid
            .paths
            .retain(|path| path != ".draftmatter/sync/account.json");
        write(
            directory.path(),
            "AGENTS.md",
            "Instructions changed after review\n",
        );
        assert!(git_initialize_with_commit_impl(invalid).is_err());
        assert!(!directory.path().join(".git").exists());
        assert!(!directory.path().join(".gitignore").exists());
    }

    #[test]
    fn ignore_preview_conflicts_are_rejected_and_manual_rule_precedence_is_preserved() {
        let directory = tempdir().unwrap();
        project(directory.path());
        write(
            directory.path(),
            ".gitignore",
            "# Keep this\n.draftmatter/\n",
        );
        let plan = git_initialization_plan_impl(&directory.path().to_string_lossy()).unwrap();
        assert!(!plan
            .entries
            .iter()
            .any(|entry| entry.path.starts_with(".draftmatter/")));
        write(directory.path(), ".gitignore", "# A new user rule\ndata/\n");
        assert!(git_initialize_with_commit_impl(request(&plan, &["paper.qmd"])).is_err());
        assert_eq!(
            fs::read_to_string(directory.path().join(".gitignore")).unwrap(),
            "# A new user rule\ndata/\n"
        );
        assert!(!directory.path().join(".git").exists());
    }

    #[test]
    fn missing_identity_keeps_reviewed_files_unchanged_and_can_retry_in_unborn_repo() {
        let directory = tempdir().unwrap();
        project(directory.path());
        empty_repository(directory.path());
        command(directory.path(), &["config", "user.name", ""]);
        command(directory.path(), &["config", "user.email", ""]);
        let plan = git_initialization_plan_impl(&directory.path().to_string_lossy()).unwrap();
        assert!(git_initialize_with_commit_impl(request(&plan, &["paper.qmd"])).is_err());
        assert!(!directory.path().join(".gitignore").exists());
        assert!(
            !run_git(directory.path(), &["rev-parse", "--verify", "HEAD"])
                .unwrap()
                .status
                .success()
        );
        command(
            directory.path(),
            &["config", "user.name", "DraftMatter Test"],
        );
        command(
            directory.path(),
            &["config", "user.email", "draftmatter@example.invalid"],
        );
        let result = git_initialize_with_commit_impl(request(&plan, &["paper.qmd"])).unwrap();
        assert!(result.initial_commit.is_some());
    }

    #[test]
    fn self_ignored_gitignore_is_reported_before_repository_initialization() {
        let directory = tempdir().unwrap();
        project(directory.path());
        write(directory.path(), ".gitignore", "*\n!paper.qmd\n");
        let error = git_initialization_plan_impl(&directory.path().to_string_lossy()).unwrap_err();
        assert!(error.to_string().contains("Add !/.gitignore"));
        assert_eq!(
            fs::read_to_string(directory.path().join(".gitignore")).unwrap(),
            "*\n!paper.qmd\n"
        );
        assert!(!directory.path().join(".git").exists());
    }

    #[test]
    fn existing_history_and_parent_repository_cannot_receive_a_new_bootstrap_commit() {
        let directory = tempdir().unwrap();
        project(directory.path());
        empty_repository(directory.path());
        let plan = git_initialization_plan_impl(&directory.path().to_string_lossy()).unwrap();
        git_initialize_with_commit_impl(request(&plan, &["paper.qmd"])).unwrap();
        assert!(git_initialization_plan_impl(&directory.path().to_string_lossy()).is_err());
        assert!(git_initialize_with_commit_impl(request(&plan, &["paper.qmd"])).is_err());
        let nested = directory.path().join("nested");
        fs::create_dir(&nested).unwrap();
        assert!(git_initialization_plan_impl(&nested.to_string_lossy()).is_err());
        assert_eq!(
            command(directory.path(), &["rev-list", "--count", "HEAD"]).stdout,
            b"1\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_and_incomplete_managed_ignore_are_preserved_without_following_them() {
        use std::os::unix::fs::symlink;
        let directory = tempdir().unwrap();
        let outside = tempdir().unwrap();
        write(outside.path(), "instructions.md", "outside instructions");
        symlink(
            outside.path().join("instructions.md"),
            directory.path().join("AGENTS.md"),
        )
        .unwrap();
        let plan = git_initialization_plan_impl(&directory.path().to_string_lossy()).unwrap();
        assert!(!plan.entries.iter().any(|entry| entry.path == "AGENTS.md"));
        write(directory.path(), ".gitignore", IGNORE_START);
        assert!(git_initialization_plan_impl(&directory.path().to_string_lossy()).is_err());
        assert_eq!(
            fs::read_to_string(directory.path().join(".gitignore")).unwrap(),
            IGNORE_START
        );
    }
}

pub fn git_initialization_plan_impl(raw_root: &str) -> Result<GitInitializationPlan, HostError> {
    let root = canonical_root(raw_root)?;
    let _guard = crate::project_guard(&root)?;
    let repository = repository_context(raw_root)?;
    if repository
        .as_ref()
        .is_some_and(|context| context.repository_root != root)
    {
        return Err(HostError::Conflict("This project is already inside a parent Git repository. Use its existing history instead.".into()));
    }
    let has_commits = repository.is_some()
        && run_git(&root, &["rev-parse", "--verify", "HEAD"])?
            .status
            .success();
    if has_commits {
        return Err(HostError::Conflict("This project already has Git commits. Select files in its existing repository instead.".into()));
    }
    let original = read_ignore(&root)?;
    let proposed = proposed_ignore(original.as_deref())?;
    let visible = visible_files(&root, &format!("{IGNORE_RULES}"))?;
    if original.is_some() && !visible.contains(".gitignore") {
        return Err(HostError::Conflict(
            "Your .gitignore ignores itself. Add !/.gitignore to your rules, then review again."
                .into(),
        ));
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    scan(&root, &root, 0, &mut 0, &mut entries, &mut truncated)?;
    entries.retain(|entry| visible.contains(&entry.path));
    entries.retain(|entry| entry.path != ".gitignore");
    entries.push(GitInitializationEntry { path: ".gitignore".into(), bytes: proposed.len() as u64, modified_ms: 0, suggested: true, reason: "Required ignore rules keep local caches, recovery and synchronization state out of Git; existing rules are preserved.".into() });
    entries.sort_by(|left, right| {
        right
            .suggested
            .cmp(&left.suggested)
            .then(left.path.cmp(&right.path))
    });
    Ok(GitInitializationPlan {
        repository_root: root.to_string_lossy().to_string(),
        existing_ignore: original.is_some(),
        ignore_will_change: original.as_deref() != Some(&proposed),
        original_ignore_content: original,
        ignore_content: proposed,
        entries,
        truncated,
        repository_exists: repository.is_some(),
        has_commits,
    })
}

pub fn git_initialize_with_commit_impl(
    request: GitInitializeRequest,
) -> Result<GitInitializeResult, HostError> {
    let root = canonical_root(&request.root)?;
    let _guard = crate::project_guard(&root)?;
    let message = validate_commit_message(&request.message)?;
    if request.paths.is_empty()
        || request.paths.len() > MAX_SELECTED_PATHS
        || !request.paths.iter().any(|path| path == ".gitignore")
    {
        return Err(HostError::InvalidProject(
            "Select the required .gitignore and up to 511 other files for the first commit.".into(),
        ));
    }
    let plan = git_initialization_plan_impl(&request.root)?;
    if plan.original_ignore_content != request.expected_ignore {
        return Err(HostError::Conflict("The project's .gitignore changed after the preview. Refresh the initialization plan before committing.".into()));
    }
    let available = plan
        .entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect::<std::collections::HashMap<_, _>>();
    for path in &request.paths {
        if !permitted_path(path) || !available.contains_key(path.as_str()) {
            return Err(HostError::InvalidPath(format!("{path} is no longer available or is local/private state. Refresh the first-commit preview.")));
        }
        if let Some(expected) = &request.expected_files {
            if path != ".gitignore" {
                let state = expected
                    .iter()
                    .find(|entry| &entry.path == path)
                    .ok_or_else(|| {
                        HostError::Conflict(format!("Refresh the first-commit preview for {path}."))
                    })?;
                let current = available[path.as_str()];
                if state.bytes != current.bytes || state.modified_ms != current.modified_ms {
                    return Err(HostError::Conflict(format!("{path} changed after the preview. Refresh before creating the first commit.")));
                }
            }
        }
    }
    // Never invent a user identity, and fail before creating files so the reviewed
    // plan remains usable after the user configures their normal Git identity.
    for identity in ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"] {
        require_success(run_git(&root, &["-c", "user.useConfigOnly=true", "var", identity])?, "check your Git name and email; configure user.name and user.email in your Git client, then retry")?;
    }
    if !plan.repository_exists {
        require_success(run_git(&root, &["init"])?, "initialize the repository")?;
    }
    let ignore_path = root.join(".gitignore");
    if plan.ignore_will_change {
        crate::write_atomic(&ignore_path, plan.ignore_content.as_bytes(), false)?;
    }
    let commit = git_create_checkpoint_impl(GitCheckpointRequest {
        root: request.root.clone(),
        paths: request.paths.clone(),
        message,
    });
    match commit {
        Ok(commit) => Ok(GitInitializeResult {
            repository_root: root.to_string_lossy().to_string(),
            created_ignore: !plan.existing_ignore,
            status: git_status_impl(&request.root)?,
            initial_commit: Some(commit),
        }),
        Err(error) => {
            // Restore the reviewed ignore text after failure. No existing history
            // is reset, and selected staging remains available in this unborn repo.
            if plan.ignore_will_change
                && read_ignore(&root)?.as_deref() == Some(plan.ignore_content.as_str())
            {
                match &plan.original_ignore_content {
                    Some(content) => crate::write_atomic(&ignore_path, content.as_bytes(), false)?,
                    None => fs::remove_file(&ignore_path)?,
                }
            }
            Err(error)
        }
    }
}

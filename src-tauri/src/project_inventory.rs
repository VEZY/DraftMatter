use crate::{
    canonical_root, ignored_discovery_directory, modified_ms, project_guard, slash_path, HostError,
};
use serde::Serialize;
use std::{fs, path::Path};

const MAX_FILES: usize = 2_000;
const MAX_ENTRIES: usize = 10_000;
const MAX_DEPTH: usize = 8;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileInfo {
    path: String,
    bytes: u64,
    modified_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileInventory {
    files: Vec<ProjectFileInfo>,
    truncated: bool,
}

fn collect(
    root: &Path,
    directory: &Path,
    depth: usize,
    visited: &mut usize,
    result: &mut ProjectFileInventory,
) -> Result<(), HostError> {
    if depth > MAX_DEPTH {
        result.truncated = true;
        return Ok(());
    }
    for entry in fs::read_dir(directory)? {
        if *visited >= MAX_ENTRIES || result.files.len() >= MAX_FILES {
            result.truncated = true;
            break;
        }
        *visited += 1;
        let entry = entry?;
        let kind = entry.file_type()?;
        // Listing never follows links, reads file contents, or uploads anything.
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            if !ignored_discovery_directory(&entry.file_name())
                && !matches!(
                    entry.file_name().to_str(),
                    Some(".Rproj.user" | "library" | "cache" | "staging")
                )
            {
                collect(root, &path, depth + 1, visited, result)?;
            }
        } else if kind.is_file() {
            let metadata = entry.metadata()?;
            result.files.push(ProjectFileInfo {
                path: slash_path(path.strip_prefix(root).map_err(|_| {
                    HostError::InvalidPath("Project file escaped its folder.".into())
                })?),
                bytes: metadata.len(),
                modified_ms: modified_ms(&metadata),
            });
        }
    }
    Ok(())
}

pub fn list_project_files_impl(raw_root: &str) -> Result<ProjectFileInventory, HostError> {
    let root = canonical_root(raw_root)?;
    let _guard = project_guard(&root)?;
    let mut result = ProjectFileInventory {
        files: Vec::new(),
        truncated: false,
    };
    collect(&root, &root, 0, &mut 0, &mut result)?;
    result.files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_unused_figures_and_data_without_private_or_dependency_directories() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        for folder in ["figures", "data", ".draftmatter", ".git", ".venv"] {
            fs::create_dir(root.join(folder)).unwrap();
        }
        for path in [
            "paper.qmd",
            "figures/unused.png",
            "data/observations.csv",
            ".draftmatter/private.json",
            ".git/config",
            ".venv/large.bin",
        ] {
            fs::write(root.join(path), b"test").unwrap();
        }
        let inventory = list_project_files_impl(root.to_str().unwrap()).unwrap();
        assert_eq!(
            inventory
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["data/observations.csv", "figures/unused.png", "paper.qmd"]
        );
        assert!(!inventory.truncated);
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_file_or_directory_links() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("private.txt"), b"secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.path().join("outside")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("private.txt"),
            directory.path().join("private.txt"),
        )
        .unwrap();
        assert!(list_project_files_impl(directory.path().to_str().unwrap())
            .unwrap()
            .files
            .is_empty());
    }
}

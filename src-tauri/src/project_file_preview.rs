//! Inert, bounded file previews; no project trust or runtime is required.
use crate::{
    canonical_root, checked_path, is_link, modified_ms, project_guard, project_sync::sync_relative,
    slash_path, HostError,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, fs::OpenOptions, io::Read};

const MAX_PREVIEW_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFilePreview {
    path: String,
    bytes: Vec<u8>,
    size: u64,
    modified_ms: u64,
    hash: Option<String>,
    truncated: bool,
}

fn read_preview(
    raw_root: &str,
    relative: &str,
    maximum: u64,
) -> Result<ProjectFilePreview, HostError> {
    if maximum == 0 || maximum > MAX_PREVIEW_BYTES {
        return Err(HostError::InvalidProject(
            "Choose a preview limit between 1 byte and 32 MiB.".into(),
        ));
    }
    let root = canonical_root(raw_root)?;
    let _guard = project_guard(&root)?;
    let relative = sync_relative(relative)?;
    let path = checked_path(&root, &relative, false)?;
    let metadata = fs::symlink_metadata(&path)?;
    if is_link(&metadata) || !metadata.is_file() {
        return Err(HostError::InvalidPath(
            "Only ordinary project files can be previewed.".into(),
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&path)?;
    let before = file.metadata()?;
    let mut bytes = Vec::new();
    (&mut file).take(maximum + 1).read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err(HostError::Conflict(
            "The file changed while its preview was being read. Open it again.".into(),
        ));
    }
    let truncated = bytes.len() as u64 > maximum || after.len() > maximum;
    bytes.truncate(maximum as usize);
    let hash = (!truncated).then(|| format!("sha256:{:x}", Sha256::digest(&bytes)));
    Ok(ProjectFilePreview {
        path: slash_path(&relative),
        bytes,
        size: after.len(),
        modified_ms: modified_ms(&after),
        hash,
        truncated,
    })
}

#[tauri::command]
pub async fn read_project_file_preview(
    root: String,
    path: String,
    max_bytes: Option<u64>,
) -> Result<ProjectFilePreview, HostError> {
    tauri::async_runtime::spawn_blocking(move || {
        read_preview(&root, &path, max_bytes.unwrap_or(262144))
    })
    .await
    .map_err(|error| HostError::Io(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_hidden_text_and_fingerprints_only_complete_files() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::write(root.join(".gitignore"), b"target\n").unwrap();
        let result = read_preview(root.to_str().unwrap(), ".gitignore", 1024).unwrap();
        assert_eq!(result.bytes, b"target\n");
        assert_eq!(result.size, 7);
        assert_eq!(
            result.hash,
            Some(format!("sha256:{:x}", Sha256::digest(b"target\n")))
        );
        assert!(!result.truncated);
        let result = read_preview(root.to_str().unwrap(), ".gitignore", 3).unwrap();
        assert_eq!(result.bytes, b"tar");
        assert_eq!(result.hash, None);
        assert!(result.truncated);
    }

    #[test]
    fn huge_sparse_files_have_bounded_prefixes_and_no_full_file_hash() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("huge.csv");
        let file = fs::File::create(&path).unwrap();
        #[cfg(windows)]
        {
            use std::{os::windows::io::AsRawHandle, ptr};
            use windows_sys::Win32::System::{Ioctl::FSCTL_SET_SPARSE, IO::DeviceIoControl};

            // NTFS needs an explicit sparse flag before extending a file without allocating it.
            let mut returned = 0;
            // SAFETY: the file stays open throughout this synchronous call. The null buffers
            // request the default set-sparse operation and the byte-count pointer is writable.
            let ok = unsafe {
                DeviceIoControl(
                    file.as_raw_handle(),
                    FSCTL_SET_SPARSE,
                    ptr::null(),
                    0,
                    ptr::null_mut(),
                    0,
                    &mut returned,
                    ptr::null_mut(),
                )
            };
            assert_ne!(
                ok,
                0,
                "Could not mark sparse: {}",
                std::io::Error::last_os_error()
            );
        }
        file.set_len(100_000_000_000).unwrap();
        drop(file);
        let result = read_preview(directory.path().to_str().unwrap(), "huge.csv", 128).unwrap();
        assert_eq!(result.size, 100_000_000_000);
        assert_eq!(result.bytes.len(), 128);
        assert!(result.truncated);
        assert_eq!(result.hash, None);
    }

    #[test]
    fn pdf_previews_can_exceed_the_text_and_image_limits() {
        let directory = tempfile::tempdir().unwrap();
        let mut bytes = vec![0; 9 * 1024 * 1024];
        bytes[..8].copy_from_slice(b"%PDF-1.7");
        fs::write(directory.path().join("article.pdf"), &bytes).unwrap();
        let result = read_preview(
            directory.path().to_str().unwrap(),
            "article.pdf",
            MAX_PREVIEW_BYTES,
        )
        .unwrap();
        assert_eq!(result.bytes, bytes);
        assert!(!result.truncated);
        assert!(result.hash.is_some());
    }

    #[test]
    fn rejects_private_paths_escapes_and_invalid_limits() {
        let directory = tempfile::tempdir().unwrap();
        for path in [
            "../outside",
            ".git/config",
            ".env",
            ".draftmatter/project.json",
        ] {
            assert!(read_preview(directory.path().to_str().unwrap(), path, 128).is_err());
        }
        assert!(read_preview(
            directory.path().to_str().unwrap(),
            "paper.qmd",
            MAX_PREVIEW_BYTES + 1
        )
        .is_err());
        assert!(read_preview(directory.path().to_str().unwrap(), "paper.qmd", 0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_file_and_directory_symlinks() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("real.txt"), b"secret").unwrap();
        symlink("real.txt", directory.path().join("linked.txt")).unwrap();
        symlink(directory.path(), directory.path().join("linked-folder")).unwrap();
        for path in ["linked.txt", "linked-folder/real.txt"] {
            assert!(read_preview(directory.path().to_str().unwrap(), path, 128).is_err());
        }
    }
}

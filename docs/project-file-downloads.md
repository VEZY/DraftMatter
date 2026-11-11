# Resumable project file downloads

Project data files are separate binary objects, not Yjs document content. `downloadProjectFile` accepts the immutable `ProjectFile` manifest and a `readPart(partNumber, signal)` transport. It validates each part's size and SHA-256 hash before persisting it. The current file limit is 1,000,000,000 bytes, with 8 MiB parts.

Use `projectFileScopeKey({serviceUrl, userId, workspaceId, projectId, fileId})` for every call. The cache identifier hashes that complete scope and the canonical immutable manifest. Changing the service, signed-in account, workspace, project, or file version selects a different cache. No credentials are stored in the cache key or manifest. Cached progress alone never authorizes skipping a part: existing bytes are hashed again after reopening.

## Browser

When OPFS is available, each received part is persisted and its progress committed separately. A dropped connection, cancelled request, or page reload preserves completed parts. Corrupted parts are removed and fetched again. The final file is assembled through an OPFS writable stream, then handed to the browser as a disk-backed `File` object and object URL. The helper never calls `arrayBuffer()` on the complete file. An already assembled file is verified through bounded slices and reused without rewriting it.

The first assembly can temporarily need about twice the file size in browser disk storage (parts plus complete file). Browser quotas and user-cleared site storage can prevent or remove a cache. Quota failures preserve earlier verified parts and report an actionable error. Without OPFS, files up to 32 MiB may use a bounded Blob fallback; larger files require a browser with OPFS or the desktop app. A browser result of `download-started` confirms the download handoff, not that the user completed its Save dialog.

## Desktop

The Tauri host stores parts under its private application cache, using only opaque SHA-256 session directory names. IPC accepts at most one 8 MiB part per write. Reopening an application download checks the on-disk manifest and hashes each existing part in 64 KiB read buffers. Cache directories and files reject links/reparse points and use private permissions on Unix.

An opaque, process-local operation ID controls cancellation independently from the persistent cache key. Cancellation stops hashing/copying before final publication and retains resumable parts. New operations after restart receive fresh IDs. The native save command accepts no destination path from JavaScript: the user chooses one in the OS Save dialog. Cancelling that dialog retains the download cache.

Final assembly streams and verifies every part into a new temporary file in the selected destination directory. The host flushes it before atomic publication. New destinations use exclusive publication, refusing a file created in the meantime; existing destinations require the explicit Save-dialog selection and are checked again before replacement. A filesystem without atomic hard-link publication for a new destination returns an error and keeps the cached download. Corrupt parts and cancelled copies leave an existing destination untouched.

## Verification scope

- `src/collaboration/projectFileDownload.test.ts`: resumed parts, corrupt bytes, forged progress hints, all account/scope boundaries, cancellation, bounded fallback, and native IPC selection.
- `tests/e2e/project-file-download.spec.ts`: real Chromium OPFS across reload, same-size corruption, untrusted progress, account separation, and a guard rejecting whole-file `arrayBuffer()` reads.
- `src-tauri/src/project_file_download.rs`: real temporary files for restart, hashing, scope collisions, permissions, links, output integrity, cancellation, and 1 GB manifest bounds.
- The explicit ignored test `one_gigabyte_assembly_uses_bounded_streams` assembles a real 1,000,000,000-byte destination from disk parts. On the development Mac its debug run used 21,413,888 bytes maximum RSS (about 20.4 MiB). This measures the native assembly test process, not browser/IPC/network memory or production throughput. Run it explicitly when qualifying the size limit; ordinary native tests skip its large disk write.

OS dialog behavior and installer registration still need the normal platform installation smoke tests. The automated browser test uses a file slightly larger than one part; the 1 GB physical assembly test covers the native path.

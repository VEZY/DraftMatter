# Private project data files

The collaboration dialog's data-files panel lets invited collaborators share
research data independently of the manuscript. Files are inert downloads: never
extracted, executed, or included in the live Yjs document.

## Access and quota

The server checks current workspace/project membership on every request. Owners
and editors can upload and delete versions. Readers and commenters can list and
download. Upload sessions belong to their creator; another collaborator cannot
resume or complete that person's transfer. Workspace membership remains the
existing access boundary: use separate workspaces for private research teams.
There are no public file links.

Each project has a **1 GB quota (1,000,000,000 bytes)** for data files. It includes
all retained completed versions and the full declared size of unfinished uploads.
Reserving that size before transferring prevents overruns from concurrent uploads.
Manuscript history keeps its separate workspace entitlement limit. No billing is
enabled by this feature.

Each upload becomes an immutable version. Reusing a name adds a version rather
than replacing another collaborator's data. Delete unneeded versions or cancel
unfinished uploads to recover logical quota. Physical bucket usage can be higher
because of provider versioning, retention and backups. Configure noncurrent
version retention and lifecycle accordingly.

The catalogue is bounded to 1,000 active versions/uploads, including empty files.
An unfinished upload expires after seven days of inactivity; maintenance aborts
its multipart storage before releasing the reservation. A failed cleanup keeps
the reservation and is retried, so storage failures cannot create unaccounted data.

## Pause and resume

Transfers use **8 MiB binary parts**, verified with SHA-256. Accepted parts are
persisted in PostgreSQL metadata and S3 multipart storage. After interruption or
restarting DraftMatter, refresh the panel and resume by choosing the source file
again. Previously accepted parts are verified against that file before sending
missing parts. A same-name/same-size file with different content is not silently
mixed into the transfer.

Only one part is read or transferred at a time per client operation. The server
never assembles a dataset in memory. Every request uses the current token and
rechecks membership; role changes and revocation apply on the next request.

Downloads verify each part and retain progress in an account/service/project/
version-specific local cache. Desktop uses disk-backed application cache and a
native Save dialog. Browsers use the origin-private file system (OPFS) in a secure
context, with a small bounded Blob fallback. Large downloads without OPFS produce
an actionable error instead of allocating a whole dataset in RAM. A browser
download-start notification does not certify its final save.

Staging can temporarily need twice the file size on the client's disk. Cancelling
the final Save dialog preserves downloaded parts for retry. Local caches and
copies already downloaded cannot be retracted by revoking server access.

## Deployment and operations

Routes are authenticated below
`/api/workspaces/{workspace}/projects/{project}/files`. Only PUT to an upload's
`/parts/{number}` route allows an 8 MiB body. JSON requests retain a 64 KiB limit.
The production Caddy template has that exception. CORS allows PUT and
`x-draftmatter-sha256`; no public object URLs or bucket credentials reach clients.

The object store must support encrypted multipart create/upload/complete/abort,
multipart listing, HeadObject and ranged GetObject. Data objects live beneath the
workspace/project prefix. File requests have a separate bounded rate budget from
administration and a process-wide cap on simultaneous binary requests.

Back up **PostgreSQL file metadata and private objects together**. Manuscript
checkpoints, ZIP exports and application manuscript backups do not embed datasets
or become complete research-directory backups. Restore drills must verify a data
file against its stored hashes. Workspace deletion aborts multipart uploads and
removes data objects before metadata. Maintenance cleans expired uploads; also
configure a compatible provider lifecycle for orphaned multipart uploads.

Workspace deletion is protected by a PostgreSQL session advisory lock and resumes
after a worker crash without reclaiming a still-running purge. Use a direct
database connection or a session-mode pooler; transaction-mode pooling is not
compatible with this lock. Cleanup failures retain data-file quota until an
operator retry or an owner cancellation/resubmission succeeds.

The initial quota is a pilot limit, not a qualification for 100 GB/terabyte files.
Increasing it later needs part sizing, client storage, retention, usage accounting
and billing qualification. No automatic deposit to a research repository occurs.

## Verification recorded on 2026-11-11

The local complete TypeScript suite passed 990 tests (one Windows-only test skipped
on macOS); native tests passed 120 (the large disk smoke is skipped by default),
and all 42 browser scenarios passed. PostgreSQL/S3 integration tests ran against
real disposable local services, including cross-pool quota races and multipart
recovery. The explicit native 1 GB disk smoke also passed; see
[download verification boundaries](project-file-downloads.md#verification-scope).
Application, CLI, service, website and both production Docker images built.

The new Rust module passes its formatting check. The repository-wide
`cargo fmt --check` still reports formatting differences in pre-existing modules;
those unrelated files were not reformatted as part of this feature. No live server
or production identity provider has been deployed or qualified by these checks.

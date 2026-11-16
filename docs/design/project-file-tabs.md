# Project file tabs and previews

Implemented in the main checkout, following the file-tab proposal in the
`alpha-deployment-legal` worktree. The separate **Set as manuscript** implementation
is outside this change; opening a file never changes the manuscript selection.

## Interaction

Files opens a dock beside the document area, temporarily replacing the outline.
A single click opens a temporary preview; double click or **Keep open** retains
it. Editing retains the tab automatically. Every file has a close action, and
arrow keys/Home/End navigate the tab strip. Duplicate filenames show folder paths.
The manuscript editor remains mounted, preserving its source, selection and
scroll position. Its comments and citation controls appear only on its tab.

Retained paths and immutable online version IDs are saved separately from the
manuscript. File text and unsaved drafts are never written to this UI preference.
Leaving the project is blocked while file drafts remain; closing a dirty tab
requires an explicit discard. Browser reload/close uses the native unsaved-work
prompt. Up to twelve file tabs can remain open.

## Available views

- PNG, JPEG, GIF, WebP and sanitized SVG: fit/zoom, dimensions and figure insertion.
- CSV/TSV: headers, original row numbers, filtering and raw source. Tables show at
  most 500 data rows, 100 columns and 10,000 characters per cell.
- Markdown/Quarto notes: rendered text and source. HTML, links and image references
  are inert; previews neither execute code nor fetch embedded resources.
- Scripts, plain text and configuration, including `.gitignore` and
  `.gitattributes`: syntax-highlighted source, explicit **Edit source**, save,
  discard and undo/redo. UTF-8 BOM and the original newline convention are retained.
- Unsupported/binary content: file details and explanation. Complete bounded
  snapshots can be downloaded; the shared version panel supports full downloads.

## File copies and saves

Desktop projects use bounded native filesystem reads without requiring execution
trust or a runtime. Text previews and editing are limited to 1 MiB; images to
8 MiB. Larger content has a visible truncation notice and cannot be edited.
Private paths and symlinks are rejected. A local save compares the complete-file
SHA-256 fingerprint and uses the existing atomic project-sync write/recovery path.

Browser collaborators use the authenticated file catalogue and preview endpoint
for a specific immutable version. The service reads and verifies at most one
8 MiB storage part and returns the requested bounded prefix. The viewer reports
the version ID and its online location. Owners/editors can save a new immutable
text version; server-side path-head checks reject concurrent replacements. Earlier
versions remain accessible. Viewers can read and download but cannot save.

A connected desktop project can open its local copy and an online version in
separate tabs. Local saving and publishing an online version remain distinct;
selective synchronization continues to decide which files are followed. Tabs
opened for a different account/project are hidden and cannot save until their
original context is restored. Local drafts survive connection/disconnection.
Browser-only examples and saved browser images have read-only previews.

## Implementation and validation

`ProjectDocumentWorkspace` owns tabs and copy identities; `ProjectFileViewer`
owns safe rendering and persistent CodeMirror drafts. `ProjectFilesWorkspace`
and `ProjectFilesPanel` provide local/current/earlier-version entry points.
The new native command is `read_project_file_preview`; the authenticated route
is `GET /api/workspaces/:workspace/projects/:project/files/:version/preview`.
Older collaboration servers must be upgraded before online previews work.

Coverage includes browser/desktop/connected copy selection, dirty drafts,
concurrent saves, permission changes, immutable version restoration, stale
async responses, manuscript state, StrictMode image URLs and a sparse 100 GB
file read. Browser E2E tests exercise actual CodeMirror editing and the Files
dock on desktop/mobile layouts. No preview starts an interpreter or executes
the selected file.

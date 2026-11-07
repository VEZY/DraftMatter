# Performance and recovery budgets

DraftMatter treats a 50–100 page research manuscript as an ordinary working document, not an exceptional import. The automated `DM-P5-07` fixture models 90 pages (more than 250 KB of source) with prose, citations, headings, and tables.

The release CI ceilings are deliberately above typical developer-machine timings so they catch algorithmic regressions without turning normal runner variance into noise:

| Operation | CI ceiling |
| --- | ---: |
| Lossless source and review parse | 2.5 s |
| Rendered structured-editor mount | 5.0 s |
| Structured edit + deterministic serialization | 1.5 s |
| Native semantic HTML export | 2.5 s |
| Native DOCX package export | 3.5 s |

The interactive gate mounts all 90 sections and tables in the real ProseMirror editor, inserts a labeled section through an editor transaction, and measures the complete portable-source serialization. Expensive publication exports still run only after an explicit action. Product-specific release profiling may tighten these conservative cross-platform CI ceilings without weakening them.

The home/account router loads the manuscript editor on demand. In the 2026-11-06 locked production build, entry JavaScript is approximately 301 kB (90 kB gzip), compared with 2,103 kB (624 kB gzip) before that split. The editor is a separate approximately 1,801 kB chunk. This reduces the initial transfer for Home; it does not assert a corresponding startup-latency gain or reduce the whole editor's dependency size.

## Recovery invariants

- Browser recovery uses a schema-versioned journal and reads the legacy array format.
- Opening a portable manuscript writes its exact source bytes to the first recovery snapshot; it does not rebuild the file through the legacy draft model, so unknown sections and raw extensions remain recoverable.
- Unchanged snapshots are deduplicated.
- At most eight snapshots are retained, with a second 4 MB encoded-size ceiling for long manuscripts.
- If storage rejects a write, the previous valid journal remains untouched and the editor keeps the live draft.
- Desktop saves use atomic replacement, expected hashes, and a bounded on-disk recovery history. Interrupted-save tests assert that the prior manuscript and a valid recovery remain readable.
- Git checkpoints are separate, named user actions. Recovery never commits, pushes, switches branches, or executes manuscript code.

These mechanisms are complementary: browser/on-disk recovery protects unsaved work, while Git records deliberate project milestones.

The desktop host and assistant clients use one interprocess project-write protocol. Revision checks run under that lock; multi-file transactions fsync their backup and prepared journal before replacing targets, and either host can recover an interrupted transaction. Unknown or ambiguous legacy journals are preserved with an actionable error, never silently deleted. This also prevents two assistants from successfully replacing the same inspected revision.

Collaborative recovery separately journals CRDT state in IndexedDB, scoped by server, project and account. It preserves offline updates across reloads, and warns if local persistence or server synchronization is pending. This cache is not an infrastructure backup.

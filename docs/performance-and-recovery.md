# Performance and recovery budgets

DraftMatter treats a 50–100 page research manuscript as an ordinary working document, not an exceptional import. The automated `DM-P5-07` fixture models 90 pages (more than 250 KB of source) with prose, citations, headings, and tables.

The release CI ceilings are deliberately above typical developer-machine timings so they catch algorithmic regressions without turning normal runner variance into noise:

| Operation | CI ceiling |
| --- | ---: |
| Lossless source and review parse | 2.5 s |
| Rendered structured-editor mount | 5.0 s |
| Structured edit + deterministic serialization | 1.5 s |
| Full-application warm typing, 70 KB source and 2,552 references (browser p95) | 0.5 s |
| Native semantic HTML export | 2.5 s |
| Native DOCX package export | 3.5 s |

The interactive gate mounts all 90 sections and tables in the real ProseMirror editor, inserts a labeled section through an editor transaction, and measures the complete portable-source serialization. Expensive publication exports still run only after an explicit action. Product-specific release profiling may tighten these conservative cross-platform CI ceilings without weakening them.

## Full-application typing regression

The standalone editor gate does not include application analyses or CSL formatting. The browser typing regression therefore loads a full manuscript with a large bibliography, types through real keyboard events, checks citation stability, and verifies undo/redo and saved-source reload.

On 2026-11-15, a private, read-only copy of an approximately 8,000-word manuscript (67,474 source bytes) and its complete 2,552-record bibliography reproduced the reported lag. Chromium 149 on macOS arm64 measured keydown to two animation frames, after initial loading and two warm-up characters. Each comparison used the same eight measured characters, caret, viewport, references and animations. Both versions produced identical final saved-source hashes.

| Full application | Before, median / p95 | After, median / p95 |
| --- | ---: | ---: |
| Development build | 1,735 / 1,766 ms | 261 / 268 ms |
| Production build | 731 / 758 ms | 43 / 48 ms |

These are local browser measurements, not a native WebKit or CI timing guarantee. An equivalent control disabling SVG filters showed no improvement (development median 1,749 ms), so the visual treatment was retained.

The fixes avoid rebuilding the CSL processor when ordered citation semantics, reference metadata, style and locale are unchanged; remap formatted labels to the current source-derived IDs; initialize the editor's review index once; reuse exact-source executable-cell analysis in a bounded four-entry cache; and memoize application output/cell analyses. Cache results remain independent mutable copies. Actual source edits invalidate cell positions and syntax, while citation edits still update formatting and bibliography ordering. No typing, persistence or history updates are delayed to achieve the improvement.

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

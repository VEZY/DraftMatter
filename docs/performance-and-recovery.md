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

- Browser recovery uses separate schema-three journals for each project and manuscript path. Repeated manuscript/envelope text is pooled without changing the restored source or draft metadata. Older unassigned arrays/schema-one/schema-two journals remain intact; they are never guessed to belong to the current project.
- Opening a portable manuscript writes its exact source bytes to the first recovery snapshot; it does not rebuild the file through the legacy draft model, so unknown sections and raw extensions remain recoverable.
- Unchanged automatic snapshots are deduplicated. Explicit saved, pre-restoration and restored versions are immutable events with distinct IDs, including for identical source text; timeline merging uses identity rather than content.
- Up to 100 unprotected automatic snapshots remain per manuscript. The latest eight changes have priority, followed by representatives in fixed UTC five-minute, hourly and daily activity buckets. At pressure, older copies between two manual checkpoints have lower priority than copies outside those intervals. Named/manual events, selected origins and unknown earlier kinds are outside automatic cleanup. A browser journal has a 4 MiB UTF-16 ceiling; quota retries may reduce the automatic count using the same priorities, while keeping the newest working copy. If protected events cannot fit, the prior journal remains intact and a capacity error is shown.
- Automatic capture follows changed source after a 1.8-second pause, with a one-minute maximum wait during continuous pending edits. Unchanged text does not create a new event. On desktop, the deadline also preserves unsaved source on disk if the normal file-save debounce has not fired. Naming historical text is not an edit to the working draft and must not trigger a duplicate autosave.
- A pending capture is checked against its captured document key, current source and native session before any write, including before React's timer cleanup runs during a project switch. A later pre-overwrite copy of an older on-disk source must retain its earlier source time rather than appear newer than a pending-work checkpoint.
- Browsing history uses a read-only rendered/source/diff preview. It never invokes restoration, Git or a runtime, and the automatic recovery timer pauses while the window is open. Restoring is a separate explicit action that preserves the current draft and selected original before changing the editor. A restored copy is a new event; later saved versions remain available.
- Desktop saves use atomic replacement, expected hashes, and a bounded on-disk history per document. New backups live under a SHA-256 document-path directory with an exact path manifest. The read-only history API verifies contained paths, regular files, size, content fingerprints and exact document identity. Unambiguous older flat backups are included; ambiguous path encodings remain untouched. Interrupted-save tests assert that the prior manuscript and a valid recovery remain readable.
- Desktop saved events use a separate immutable archive, independently of automatic cleanup. Publication writes source first and commits metadata last. Listing reads metadata only; selecting a version reads and SHA-256-verifies its source. Naming an old version creates a distinct manual event with its original source time and protects its origin; naming never restores it. The explicit 1,000-event and 5 MiB-per-event limits fail without deleting older events. Browser quota failures cannot evict these on-disk saved events. Native automatic cleanup verifies a new copy before pruning and preserves old copies if checkpoint metadata cannot be verified.
- Git checkpoints are separate, named user actions. Recovery never commits, pushes, switches branches, or executes manuscript code.

These mechanisms are complementary: browser/on-disk recovery protects unsaved work, while Git records deliberate project milestones.

The desktop host and assistant clients use one interprocess project-write protocol. Revision checks run under that lock; multi-file transactions fsync their backup and prepared journal before replacing targets, and either host can recover an interrupted transaction. Unknown or ambiguous legacy journals are preserved with an actionable error, never silently deleted. This also prevents two assistants from successfully replacing the same inspected revision.

Collaborative recovery separately journals CRDT state in IndexedDB, scoped by server, project and account. It preserves offline updates across reloads, and warns if local persistence or server synchronization is pending. This cache is not an infrastructure backup.

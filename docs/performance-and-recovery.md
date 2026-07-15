# Performance and recovery budgets

DraftMatter treats a 50–100 page research manuscript as an ordinary working document, not an exceptional import. The automated `DM-P5-07` fixture models 90 pages (more than 250 KB of source) with prose, citations, headings, and tables.

The release CI ceilings are deliberately above typical developer-machine timings so they catch algorithmic regressions without turning normal runner variance into noise:

| Operation | CI ceiling |
| --- | ---: |
| Lossless source and review parse | 2.5 s |
| Native semantic HTML export | 2.5 s |
| Native DOCX package export | 3.5 s |

Interactive editing remains section-oriented; expensive publication exports run only after an explicit action. A later profiling pass should tighten these ceilings using release builds on each supported OS.

## Recovery invariants

- Browser recovery uses a schema-versioned journal and reads the legacy array format.
- Opening a portable manuscript writes its exact source bytes to the first recovery snapshot; it does not rebuild the file through the legacy draft model, so unknown sections and raw extensions remain recoverable.
- Unchanged snapshots are deduplicated.
- At most eight snapshots are retained, with a second 4 MB encoded-size ceiling for long manuscripts.
- If storage rejects a write, the previous valid journal remains untouched and the editor keeps the live draft.
- Desktop saves use atomic replacement, expected hashes, and a bounded on-disk recovery history. Interrupted-save tests assert that the prior manuscript and a valid recovery remain readable.
- Git checkpoints are separate, named user actions. Recovery never commits, pushes, switches branches, or executes manuscript code.

These mechanisms are complementary: browser/on-disk recovery protects unsaved work, while Git records deliberate project milestones.

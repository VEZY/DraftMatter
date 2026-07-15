# Local MVP gate evidence

The `DM-P5-GATE` automated dogfood path starts from the same portable reviewed QMD used by the rendered application. It verifies that a close/reopen cycle retains citation keys, an executable cell, its portable retained-output block, two overlapping suggestions, a comment thread, and author attribution.

One alternative is then selected through the conflict-aware projector. The resulting bytes are the single clean publication source used for:

- clean final Markdown/QMD;
- native semantic HTML;
- browser-print PDF styling;
- native OOXML DOCX.

All four projections reject or assert the absence of DraftMatter anchors, review records, and Word tracked-change elements. Re-rendering the same selection produces the same source hash. Reopening the clean Markdown retains title, citation keys, and executable-cell identity without executing it.

The native Git suite completes the remaining gate step in real temporary repositories: it creates a root checkpoint when needed, commits only selected paths, preserves unrelated staged and unstaged work, disables repository hooks/filesystem monitors, and exercises fetch/pull/push plus divergence against local bare remotes.

Run the full local gate with:

```sh
npm run check
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run compliance:check
```

Manual release QA still includes opening the built application on each target, inspecting the representative HTML/print/DOCX output, and completing the signing/notarization checklist in `release-compliance.md`.

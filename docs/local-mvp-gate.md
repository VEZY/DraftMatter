# Local MVP gate evidence

The `DM-P5-GATE` automated dogfood path starts from the same portable reviewed QMD used by the rendered application. It verifies that a close/reopen cycle retains citation keys, an executable cell, its portable retained-output block, two overlapping suggestions, a comment thread, and author attribution.

One alternative is then selected through the conflict-aware projector. The resulting bytes are the single clean publication source used for:

- clean final Markdown/QMD;
- native semantic HTML;
- browser-print PDF styling;
- native OOXML DOCX.

All four projections reject or assert the absence of DraftMatter anchors, review records, and Word tracked-change elements. Re-rendering the same selection produces the same source hash. Reopening the clean Markdown retains title, citation keys, and executable-cell identity without executing it.

The native Git suite completes the remaining gate step in real temporary repositories: it creates a root checkpoint when needed, commits only selected paths, preserves unrelated staged and unstaged work, disables repository hooks/filesystem monitors, and exercises fetch/pull/push plus divergence against local bare remotes.

The rendered DM-P4-02 browser path switches a generic portable manuscript from Editing to Suggesting, then types a replacement, pastes a second replacement, deletes a selection, and inserts at a caret. The short grouping window emits exactly one attributed portable proposal per gesture, restores the unchanged accepted prose after each capture, and verifies the resulting replace/delete/insert records in the autosaved source.

The rendered DM-P4-04 rebase path accepts one of two identical alternatives, opens the preserved `Needs rebase` proposal, and anchors revised wording to the accepted manuscript. The transaction materializes accepted decisions into the portable base once, marks old records `applied`/`rebased` for audit, preserves independent review anchors, appends a `rebased` decision, and leaves exactly one new open proposal linked by `data-rebased-from`.

The rendered DM-P5-01/02 publication path opens an arbitrary structured manuscript and routes those authoritative bytes through clean Markdown, native HTML/PDF, DOCX, and optional external export preparation. Its browser test downloads HTML and DOCX, rejects demo-source substitution and review leakage, verifies multi-author metadata, math, configured CSL citations and bibliography, cross-references, figures, tables, and inert executable cells, then renders the HTML in Chromium against the committed screen and print visual baselines. It also exercises the actual Print/PDF control and generates a tagged A4 PDF attachment for rendered-page inspection; the representative Poppler render is one clean page with extractable title, authors, figure, table, bibliography, and inert code.

Run the full local gate with:

```sh
npm run check
npm test
npm run test:e2e
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run compliance:check
```

Manual release QA still includes opening the built application on each target, inspecting the representative HTML/print/DOCX output, and completing the signing/notarization checklist in `release-compliance.md`.

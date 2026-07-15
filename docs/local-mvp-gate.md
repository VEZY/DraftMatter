# Local MVP gate evidence

The `DM-P5-GATE` automated dogfood path starts from the same portable reviewed QMD used by the rendered application. It verifies that a close/reopen cycle retains citation keys, an executable cell, its portable retained-output block, two overlapping suggestions, a comment thread, and author attribution.

One alternative is then selected through the conflict-aware projector. The resulting bytes are the single clean publication source used for:

- clean final Markdown/QMD;
- native semantic HTML;
- browser-print PDF styling;
- native OOXML DOCX.

All four projections reject or assert the absence of DraftMatter anchors, review records, and Word tracked-change elements. Re-rendering the same selection produces the same source hash. Reopening the clean Markdown retains title, citation keys, and executable-cell identity without executing it.

Display-equation details can rename an `eq-…` label while editing TeX; duplicate targets and referenced-label removal are rejected, unrelated Pandoc attributes survive, and matching equation references retarget atomically.

Focused footnote editing keeps repeated references rendered as deterministic first-use numbers while allowing the portable label and Markdown definition to change together; duplicate definitions are rejected and every matching `[^label]` reference retargets in the same transaction.

Rendered cross-references remain real semantic links and expose a compact target editor only on request; invalid target families are rejected, while a valid `fig-`, `tbl-`, `eq-`, or `sec-` change updates the portable source without revealing `@` punctuation in normal writing.

The rendered DM-P1-03 manuscript path treats figure, table, equation, and section references as semantic links: ordinary writing shows labels such as **Section background** instead of `@sec-background`, while autosave retains the exact portable identifier. Section titles remain directly editable, while a quiet details dialog creates or renames `sec-…` labels, rejects duplicate targets and referenced-label removal, preserves unrelated heading attributes, and retargets matching references atomically. Inline and display TeX are rendered offline as KaTeX HTML plus accessible MathML with trusted commands disabled and expansion/size bounds; focused editors expose TeX only on request, preserve display attributes, and replace malformed or privileged input with a generic editable diagnostic. Semantic figures expose their portable label as a real link target and provide a focused source, alternative-text, title, and label editor; label changes update matching `@fig-…` references atomically, referenced labels cannot be removed, and unrelated Pandoc attributes remain byte-stable. Semantic tables keep cells directly editable while rendering their caption and `#tbl-…` target without source punctuation; the focused details editor preserves custom attributes, retargets matching references atomically, and retains left, center, and right column alignment through unrelated edits and reopen cycles. Executable cells appear as compact language, identity, freshness, line-count, and output-kind cards during normal writing; source is absent from the accessibility tree until the author explicitly expands it, remains read-only for non-editing roles, and autosaves back to the ordinary fenced block when edited. Footnote references receive deterministic first-use numbers, navigate to quiet definition cards, and keep definition Markdown hidden until the author explicitly opens the focused note editor; saving or reopening retains the original portable `[^label]` syntax. Heading and display-equation attribute blocks remain hidden, survive unrelated edits byte-for-byte, and provide real link targets. Typing `/` in an empty rendered paragraph opens the structured command menu without writing punctuation into the portable source; ordinary slashes in prose remain ordinary text. The same palette filters labels, descriptions, and related terms as the author types, exposes its active result, supports wrapping arrow navigation and Enter execution, keeps unavailable commands inert, and reports an explicit no-results state. A missing equation close is preserved as visible raw source with a diagnostic instead of consuming later manuscript content. Native HTML and DOCX apply the same label vocabulary and bounded equation parsing, including punctuation-safe link targets.

The native Git suite completes the remaining gate step in real temporary repositories: it creates a root checkpoint when needed, commits only selected paths, preserves unrelated staged and unstaged work, disables repository hooks/filesystem monitors, and exercises fetch/pull/push plus divergence against local bare remotes.

The rendered DM-P4-02 browser path switches a generic portable manuscript from Editing to Suggesting, then types a replacement, pastes a second replacement, deletes a selection, and inserts at a caret. The short grouping window emits exactly one attributed portable proposal per gesture, restores the unchanged accepted prose after each capture, and verifies the resulting replace/delete/insert records in the autosaved source.

The rendered DM-P4-04 rebase path accepts one of two identical alternatives, opens the preserved `Needs rebase` proposal, and anchors revised wording to the accepted manuscript. The transaction materializes accepted decisions into the portable base once, marks old records `applied`/`rebased` for audit, preserves independent review anchors, appends a `rebased` decision, and leaves exactly one new open proposal linked by `data-rebased-from`.

The rendered DM-P5-01/02 publication path opens an arbitrary structured manuscript and routes those authoritative bytes through clean Markdown, native HTML/PDF, DOCX, and optional external export preparation. Its browser test downloads HTML and DOCX, rejects demo-source substitution and review leakage, verifies multi-author metadata, math, configured CSL citations and bibliography, cross-references, semantic footnotes, figures, tables, and inert executable cells, then renders the HTML in Chromium against the committed screen and print visual baselines. HTML footnotes use linked noteref/endnote semantics and deterministic first-use numbering instead of exposing Markdown punctuation. It also exercises the actual Print/PDF control and generates a tagged A4 PDF attachment for rendered-page inspection; the representative Poppler render is one clean page with extractable title, authors, figure, table, footnote, bibliography, and inert code. The preserved DOCX attachment contains a native `word/footnotes.xml` part with matched body and definition IDs, and renders through LibreOffice as a clean one-page A4 document with the numbered footnote at the page bottom, a human-readable CSL citation and bibliography, a real table, inert code, and a concise diagnostic in place of an unsupported embedded data image.

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

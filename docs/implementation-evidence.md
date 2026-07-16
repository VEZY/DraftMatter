# DraftMatter implementation evidence

This ledger consolidates the implementation and verification evidence for the
task register in `draftmatter-app-design.md`. It intentionally does not change
that canonical register: the design document currently contains uncommitted
user edits and must be reconciled separately. The evidence below is suitable
for copying into its completion log once those edits are approved.

## Certification snapshot

The implementation tree was last audited on 2026-07-16 from a clean
`git archive` of commit `41b1083`, followed by a fresh `npm ci`.

| Verification | Result |
| --- | --- |
| `npm run test:release` | Passed from the clean export: release identity, TypeScript, 109 Vitest files / 545 tests, 25 Chromium end-to-end tests, browser/service/CLI builds, real-process CLI checks, and 572-component compliance lock. |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | Passed from the same clean export: 60 native-host tests. |
| `docker compose config --quiet` | Passed from the same clean export: portable collaboration topology is valid. |
| `npm run desktop:build -- --debug --bundles app` | Passed: macOS application bundle built and ad-hoc signed. |
| `codesign --verify --deep --strict --verbose=2 DraftMatter.app` | Passed for the locally built macOS application. |
| `.github/workflows/desktop-portability.yml` | Defines locked Windows, macOS, and Linux type, compliance, frontend, CLI, Rust, and application-build gates. |
| `.github/workflows/desktop-release.yml` | Defines release verification, platform packaging, CLI packaging, checksums, SBOM/notices, and tag-only signing/notarization policy. |

## Task evidence

### DM-P0 — Portable format and editor-risk spike

| Task | Automated or reproducible evidence | Implementation commit |
| --- | --- | --- |
| DM-P0-01 | `src/portableFixtures.test.ts` enumerates `src/portableFixtureManifest.ts` and all 30 `.md`/`.qmd` fixtures. | `a73977c` |
| DM-P0-02 | `src/portableFixtures.test.ts` and `src/portableSource.test.ts` repeat parse/serialize/reopen cycles and preserve raw bytes. | `ffceb28` |
| DM-P0-03 | `src/structuredManuscript.test.ts`, `src/StructuredManuscriptEditor.test.tsx`, and `src/genericManuscriptApp.test.tsx` exercise stable semantic citations, cells, outputs, review anchors, and raw nodes through edits and reopen. | `a197571` |
| DM-P0-04 | `src/reviewMarkup.test.ts` round-trips versioned authors, proposals, threads, decisions, and point/range anchors, including identical, nested, and crossing records. | `a2c6e11` |
| DM-P0-05 | `src/reviewProjector.test.ts`, `src/reviewExport.test.ts`, and `src/document.test.ts` prove clean Original/Final projection, reserved-markup removal, and fail-closed conflicts. | `c90bd9e` |
| DM-P0-06 | `src/verticalSlice.test.tsx` and `tests/e2e/phase0-vertical-slice.spec.ts` cover the rendered semantic slice and its visual snapshot. | `023109f` |
| DM-P0-GATE | `src/portableFixtures.test.ts` certifies the full fixture corpus and `tests/e2e/phase0-vertical-slice.spec.ts` certifies the rendered boundary. | `6fff187` |

### DM-P1 — Manuscript foundation

| Task | Automated or reproducible evidence | Implementation commit |
| --- | --- | --- |
| DM-P1-01 | `src/desktopHost.test.ts`, the Rust host tests, Tauri capability allowlist, and `.github/workflows/desktop-portability.yml` cover narrow typed commands and Windows/macOS/Linux builds. | `b39552e` |
| DM-P1-02 | `src/projectPaths.test.ts`, `src/storage.test.ts`, `src/phase1LocalGate.test.tsx`, and Rust temporary-project tests cover create/open/discovery/configuration/reopen without execution. | `936836d` |
| DM-P1-03 | `src/structuredManuscript.test.ts`, `src/StructuredManuscriptEditor.test.tsx`, `src/genericManuscriptApp.test.tsx`, and `tests/e2e/generic-manuscript.spec.ts` edit every supported semantic node in the rendered surface. | `4b5c9e0` |
| DM-P1-04 | `src/storage.test.ts`, `src/draftHistory.test.ts`, `src/phase1LocalGate.test.tsx`, and Rust atomic-write/recovery tests cover interrupted writes, undo/redo, and bounded recovery. | `e39ef93` |
| DM-P1-05 | `src/phase1LocalGate.test.tsx` and Rust watcher/conflict tests cover external edits, renames, deletions, safe reload, and dirty-buffer snapshots. | `4e560d0` |
| DM-P1-06 | `src/manuscriptOutline.test.ts`, raw-node editor tests, `tests/e2e/outline-options.spec.ts`, and `tests/e2e/generic-manuscript.spec.ts` cover structural navigation and byte-preserving source inspection. | `b8a726c` |
| DM-P1-07 | `src/accessibility.test.ts`, `src/accessibility.test.tsx`, `tests/e2e/accessibility.spec.ts`, and `docs/accessibility-smoke-test.md` cover keyboard access, focus, labels, contrast, and reduced motion. | `f6a9577` |
| DM-P1-GATE | `src/phase1LocalGate.test.tsx` covers create/open/edit/save/reopen/recover as one local lifecycle. | `f6dd589` |

### DM-P2 — Citations and bibliography

| Task | Automated or reproducible evidence | Implementation commit |
| --- | --- | --- |
| DM-P2-01 | `src/citationIntake.test.ts`, `src/bibliography.test.ts`, and the RIS/EndNote fixtures cover BibTeX/BibLaTeX, CSL JSON, RIS/RefMan, EndNote, Unicode, duplicates, missing fields, and malformed records. | `94af06f` |
| DM-P2-02 | `src/zotero.test.ts` and `src/citationAcquisitionApp.test.tsx` cover local API discovery, search, identity, attachments, unavailable service, and version changes. | `8b740c1` |
| DM-P2-03 | `src/crossref.test.ts` and `src/crossrefApp.test.tsx` cover debounce, cancellation, fallback, reranking, cache/offline/429 behavior, and the DynACof DOI ranking. | `a60b421` |
| DM-P2-04 | `src/citationIntake.test.ts` and `src/citationIntakeApp.test.tsx` cover keyboard paste, drop, files, preview, multi-record errors, size bounds, offline imports, and original-payload retention. | `2c08072` |
| DM-P2-05 | `src/citationPicker.test.tsx`, `src/citationAcquisitionApp.test.tsx`, and `src/citationDetails.test.tsx` cover grouped local/Zotero/Crossref results, Scholar handoff, multi-insert, locators, affixes, and author suppression. | `a33dcd1` |
| DM-P2-06 | `src/citationAcquisition.test.ts` and `src/citationLock.test.ts` inject transaction failures and prove atomic, deterministic, idempotent bibliography/lock/manuscript acquisition with collision-safe citekeys. | `9b4e173` |
| DM-P2-07 | `src/cslRenderer.test.ts`, `src/cslApp.test.tsx`, `src/citation.test.ts`, and `src/bibliography.test.ts` cover configured styles/locales, locators, author counts, and disambiguation. | `8cfbb3c` |
| DM-P2-08 | `src/citationLock.test.ts`, `src/citationCache.test.ts`, `src/citationDetails.test.tsx`, and `src/ProjectDiagnostics.test.tsx` cover offline snapshots plus missing, duplicate, alias, rename, and provider diagnostics. | `488c148` |
| DM-P2-GATE | `src/phase2CitationGate.test.ts` certifies Crossref DynACof, every interchange family, Zotero editing, offline reopen, and stable CSL output. | `2a308a3` |

### DM-P3 — Execution, figures, and tables

| Task | Automated or reproducible evidence | Implementation commit |
| --- | --- | --- |
| DM-P3-01 | `src/executionCells.test.ts` and `src/fixtures/execution/adversarial-cells.qmd` prove AST-aware extraction, adversarial fence handling, and stable cell IDs. | `a90f58d` |
| DM-P3-02 | `src/runtimeDiscovery.test.ts`, `src/executionProvider.test.ts`, and Rust runtime tests cover independent Python/R/Julia executable and kernel discovery without project-open side effects. | `65a1476` |
| DM-P3-03 | `src/kernelExecutionTransport.test.ts`, `src/directExecutionTransport.test.ts`, and Rust Jupyter/direct-provider tests assert normalized status, streams, errors, MIME, artifacts, hashes, and fingerprints. | `3f4560e` |
| DM-P3-04 | `src/executionLifecycle.test.ts`, `src/executionApp.test.tsx`, and `src/executionWorkspaceApp.test.tsx` cover explicit run/run-above/language-run-all, interrupt, restart, terminate, ordering, and isolation. | `137a91b` |
| DM-P3-05 | `src/outputRenderer.test.tsx` and `src/executionBrowserApp.test.tsx` cover image, HTML, Markdown, text, table, and error MIME while blocking malicious HTML from privileged APIs. | `43fcae9` |
| DM-P3-06 | `src/outputMaterializer.test.ts` proves ordinary artifact/output-block materialization is byte-stable, idempotent, confined to reserved markers, and diagnostic on missing artifacts. | `d4cd7e8` |
| DM-P3-07 | `src/executionFreshness.test.ts`, `src/executionLifecycle.test.ts`, and `src/cleanExecution.test.ts` cover code/input/environment/artifact invalidation and restoration by clean run-all. | `7190509` |
| DM-P3-08 | `src/retainedOutputs.test.tsx`, `src/outputRenderer.test.tsx`, and `src/executionWorkspaceApp.test.tsx` cover current/stale/missing retained outputs independently from runtime availability. | `a75b38a` |
| DM-P3-09 | `src/executionTrust.test.ts`, `src/executionBrowserApp.test.tsx`, Rust trust tests, and `src/sharedEditor/browserBoundary.test.ts` prove explicit trust and a browser build without execution capability. | `ed8827e` |
| DM-P3-GATE | `src/cleanExecution.test.ts`, `src/fixtures/execution/phase3-clean-restart.qmd`, provider conformance tests, and retained-output tests certify clean cross-language reproduction and unavailable-runtime reopen. | `7f4d388` |

### DM-P4 — Comments and tracked suggestions

| Task | Automated or reproducible evidence | Implementation commit |
| --- | --- | --- |
| DM-P4-01 | `src/PortableReviewItems.test.tsx`, `src/reviewOperations.test.ts`, `src/reviewBalloonAlignment.test.ts`, and comment/thread end-to-end specs cover point/range threads, replies, lifecycle actions, attribution, persistence, and aligned balloons. | `74889b8` |
| DM-P4-02 | `src/reviewSuggestionCapture.test.ts` and `tests/e2e/suggestion-capture.spec.ts` cover grouped typing, paste, delete, and replace transactions without mutating accepted base text. | `ba75677` |
| DM-P4-03 | `src/reviewConflicts.test.ts` enumerates deterministic identical, nested, crossing, and alternative-range conflict components. | `3e0ec9c` |
| DM-P4-04 | `src/reviewOperations.test.ts`, `src/sharedEditor/reviewDecisions.test.ts`, `tests/e2e/review-batch-decisions.spec.ts`, and `tests/e2e/review-rebase.spec.ts` prove exactly-once decisions and preserved conflicts/Needs rebase. | `7a603d2` |
| DM-P4-05 | `src/reviewPresentation.test.ts`, `src/PortableReviewItems.test.tsx`, and `tests/e2e/markup-navigation.spec.ts` cover Simple/All/Original/Final, author filters, and change navigation over one proposal set. | `ac0b370` |
| DM-P4-06 | `src/reviewReanchor.test.ts` and `tests/e2e/review-reanchoring.spec.ts` cover successful, ambiguous, and failed context recovery plus the manual unplaced queue. | `63ab604` |
| DM-P4-07 | `src/reviewExport.test.ts`, `src/draftmatterCli.test.ts`, and the real-process CLI verifier cover Original, resolved Final, review report, reserved-markup removal, and fail-closed conflicts. | `23cb4a8` |
| DM-P4-GATE | `src/phase4ReviewGate.test.ts` certifies two-author identical/crossing persistence, external-edit recovery, exactly-once acceptance, and retained alternatives. | `db90150` |

### DM-P5 — Export, Git, and release hardening

| Task | Automated or reproducible evidence | Implementation commit |
| --- | --- | --- |
| DM-P5-01 | `src/nativeHtmlExport.test.ts` and `tests/e2e/publication-export.spec.ts` cover semantic clean HTML structure, citations, equations, references, figures/tables, safe styling, and visual snapshots. | `24809c3` |
| DM-P5-02 | `src/docxExport.test.ts` and `tests/e2e/publication-export.spec.ts` cover clean DOCX structure, browser-print PDF, representative rendered pages, and actionable diagnostics. | `f76434a` |
| DM-P5-03 | `src/ExternalExportDialog.test.tsx` and Rust export-adapter tests prove separate Pandoc/Quarto discovery, clean-only input, no review leakage, and disabled execution. | `b7a1af4` |
| DM-P5-04 | `src/semanticGitDiff.test.ts`, `src/GitHistoryPanel.test.tsx`, and Rust Git-adapter fixtures cover repository detection, rendered/source diffs, modified/added/deleted/renamed/binary/conflicted files. | `09a3ab3` |
| DM-P5-05 | `src/GitHistoryPanel.test.tsx` and Rust Git-adapter integration tests inspect selected staging and named commits while preserving unrelated working-tree changes. | `8ff2c9f` |
| DM-P5-06 | Rust local-bare-remote tests and `src/GitHistoryPanel.test.tsx` cover explicit branch/fetch/pull/push actions, divergence, authentication failure, merge conflicts, and work preservation. | `6ba99a7` |
| DM-P5-07 | `src/performanceGate.test.ts`, `src/performanceEditorGate.test.tsx`, recovery/fault tests, and `docs/performance-and-recovery.md` enforce article-size, mount, edit/serialization, and recovery budgets. | `122fd1a` |
| DM-P5-08 | `src/releasePipeline.test.ts`, `scripts/generate-compliance.mjs`, generated notices/SBOM, licence allowlist, both desktop workflows, standalone CLI packaging, and runtime diagnostics cover release compliance. | `04c77cb` |
| DM-P5-GATE | `src/phase5LocalGate.test.ts`, `npm run test:release`, native host tests, real-process CLI checks, application packaging, and `docs/release-compliance.md` certify the local release workflow. | `22f33cb` |

### DM-P6 — Paid online collaboration beta

DM-P6 does not block the local-MVP goal, but its repository implementation is
also covered here.

| Task | Automated or reproducible evidence | Implementation commit |
| --- | --- | --- |
| DM-P6-01 | `src/sharedEditor/browserBoundary.test.ts` and `src/collaborationBrowserEntryApp.test.tsx` prove the shared editor omits filesystem, process, Git, and execution privileges. | `c412e05` |
| DM-P6-02 | `src/sharedEditor/collaboration.test.ts`, `src/sharedEditor/prosemirrorCollaboration.test.ts`, `src/sharedEditor/hocuspocusClient.test.ts`, and `services/collaboration/hocuspocusNetwork.test.ts` prove attributed multi-client/offline convergence. | `e995724` |
| DM-P6-03 | `src/sharedEditor/reviewDecisions.test.ts` and `src/sharedEditor/collaborativeReview.test.ts` cover state-vector/base-revision decision conflicts instead of last-write-wins loss. | `313f556` |
| DM-P6-04 | Workspace/OIDC/invitation tests, `services/collaboration/hocuspocusServer.test.ts`, `services/collaboration/postgresWorkspaceService.test.ts`, and HTTP tests cover roles, guests, revocation, tenant isolation, limits, and audit. | `888ca3f` |
| DM-P6-05 | File/PostgreSQL persistence, maintenance, HTTP, restore, deletion, dashboard, load/cost-model tests and `docs/collaboration-operations.md` cover durable affordable operations. | `dfa4b6c` |
| DM-P6-06 | `src/sharedEditor/collaborationCheckpoint.test.ts`, `src/collaborationCheckpointApp.test.tsx`, and the phase gate prove byte-identical owner-controlled checkpoints with no automatic Git action. | `551092f` |
| DM-P6-GATE | `services/collaboration/phase6CollaborationGate.test.ts` and `services/collaboration/hocuspocusNetwork.test.ts` certify offline overlap, reconnect, explicit decision conflict resolution, attribution, checkpoint, revocation, restore, deletion, and metrics. | `2a7ed24` |

## Acceptance-criterion evidence

### Local MVP

| Criterion | Evidence | Implementation commit |
| --- | --- | --- |
| AC-L01 | Rendered editing is covered by `src/StructuredManuscriptEditor.test.tsx`, `src/genericManuscriptApp.test.tsx`, and `tests/e2e/generic-manuscript.spec.ts`. | `4b5c9e0` |
| AC-L02 | Portable projection/export is covered by portable-fixture gates, `src/nativeHtmlExport.test.ts`, `src/draftmatterCli.test.ts`, and optional external-adapter tests. | `24809c3` |
| AC-L03 | Unified citation acquisition and rendering is covered by `src/phase2CitationGate.test.ts` plus citation intake, Zotero, Crossref, picker, lock, and CSL tests. | `2a308a3` |
| AC-L04 | Python/R/Julia kernel and direct execution contracts are covered by transport/provider tests, native-host tests, `src/cleanExecution.test.ts`, and the clean-restart fixture. | `7f4d388` |
| AC-L05 | Idempotent ordinary figure/table artifacts and reserved output blocks are covered by `src/outputMaterializer.test.ts`. | `d4cd7e8` |
| AC-L06 | Current/stale/failed state and clean-run behavior are covered by `src/executionFreshness.test.ts`, `src/executionLifecycle.test.ts`, and `src/cleanExecution.test.ts`. | `7190509` |
| AC-L07 | Visible retained output with unavailable-runtime provenance is covered by `src/retainedOutputs.test.tsx` and `src/outputRenderer.test.tsx`. | `a75b38a` |
| AC-L08 | Orthogonal stale/current/missing output and runtime availability are covered by `src/retainedOutputs.test.tsx` and `src/executionWorkspaceApp.test.tsx`. | `a75b38a` |
| AC-L09 | Persistent attributed review UI is covered by portable review component/operation tests and comment/thread/balloon end-to-end specs. | `74889b8` |
| AC-L10 | Deterministic anchors/records and exactly-once decisions are covered by `src/reviewMarkup.test.ts` and `src/reviewOperations.test.ts`. | `7a603d2` |
| AC-L11 | Independent identical/nested/crossing proposals are covered by `src/reviewMarkup.test.ts` and `src/reviewConflicts.test.ts`. | `3e0ec9c` |
| AC-L12 | Needs-rebase/explicit-conflict preservation is covered by `src/reviewOperations.test.ts`, shared decision tests, and batch/rebase end-to-end specs. | `7a603d2` |
| AC-L13 | Clean Markdown/HTML/PDF/DOCX is covered by review/CLI/native HTML/DOCX tests and `tests/e2e/publication-export.spec.ts`; reserved review structures are rejected. | `22f33cb` |
| AC-L14 | No implicit execution is covered by project lifecycle, execution trust, runtime discovery, browser boundary, and native-host tests. | `936836d` |
| AC-L15 | Unknown syntax preservation/flagging is covered by fixture 28, portable round-trip tests, and raw-node editor tests. | `6fff187` |
| AC-L16 | Repository detection, rendered/source diff, and explicit local checkpoint are covered by semantic diff, Git panel, and native Git-adapter tests. | `8ff2c9f` |
| AC-L17 | Explicit, non-destructive remotes and conflict retention are covered by native local-bare-remote fixtures and Git panel tests. | `6ba99a7` |

### Collaboration beta

| Criterion | Evidence | Implementation commit |
| --- | --- | --- |
| AC-C01 | Role-aware desktop/browser co-edit/comment/suggest behavior is covered by workspace authorization, Hocuspocus, collaborative review, access panel, and browser-entry tests. | `888ca3f` |
| AC-C02 | Attributed offline convergence is covered by shared-editor collaboration, ProseMirror collaboration, Hocuspocus client, and real-network tests. | `e995724` |
| AC-C03 | Independent overlapping alternatives and explicit concurrent-decision conflicts are covered by review decision, collaborative review, and phase-six gate tests. | `313f556` |
| AC-C04 | Deterministic portable collaboration checkpoint plus explicit owner Git boundary is covered by checkpoint library/app tests and the phase-six gate. | `551092f` |
| AC-C05 | Browser collaborators lack filesystem/process/Git/execution access, covered by `src/sharedEditor/browserBoundary.test.ts` and browser execution UI tests. | `c412e05` |
| AC-C06 | Tenant isolation, revocation, history, deletion, verified backup/restore, and privacy-safe monitoring are covered by workspace, persistence, maintenance, HTTP, network, and phase-six gate tests. | `dfa4b6c` |

## External launch gates

The repository implements and tests the release and collaboration mechanisms,
but a public paid launch still requires environment-owned inputs: production
signing/notarization credentials, operated OIDC/billing/TLS and secret
management, provider-level database/object backups, alert routing,
privacy/data-processing and external security review, and production load/soak
tests. These are deployment gates documented in
`docs/collaboration-beta-gate.md` and `docs/release-compliance.md`; they are not
silently represented as locally completed production operations.

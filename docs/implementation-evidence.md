# DraftMatter implementation evidence

This ledger consolidates the implementation and verification evidence for the
task register in `draftmatter-app-design.md`. The canonical register and this
ledger were reconciled on 2026-07-18: DM-P0 through DM-P7, AC-L01 through
AC-L17, and AC-C01 through AC-C06 are checked. Repository implementation gates
are complete; installed-app field trials and external release/operations gates
remain outside this ledger.
The design document carries the product-level status and interaction decisions;
this file remains the task-level source for tests, fixtures, and implementation
commits.

The provider-neutral local AI integration is certified separately in
[`agent-integration-evidence.md`](agent-integration-evidence.md). That record
covers the headless service, JSON and MCP interfaces, Agent Skill and client
adapters, separate device connection and project enablement, real-kernel
workflows, safety boundaries, publication output, and cross-client
verification.

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
| `.github/workflows/desktop-release.yml` | Defines release verification, platform packaging, CLI packaging, checksums, SBOM/notices, and GitHub draft releases without paid publisher signing. |

### Shared Jupyter-kernel audit

The Jupyter-only execution and published-value work was audited on 2026-07-17.
At `17e11a0`, `npm run test:release` passed release identity, TypeScript, 117
Vitest files / 571 tests, 31 Chromium end-to-end tests, browser/service/CLI
builds, real-process CLI checks, and the 612-component compliance lock.
`cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast` passed 65 native
host tests. An explicit temporary `ipykernel` integration run additionally
verified shared state, rich artifacts and private published-value MIME,
single-lane contention, restart generation and state clearing, interrupt, and
post-interrupt recovery. Repository-wide removal checks found no legacy
scalar-output protocol, namespaced value markup, alternative execution runner,
execution-mode selector, or Python-side Jupyter control bridge.

### Post-gate authoring audit

Hands-on product review after the formal phase gates exposed several ordinary
writing and reproducible-output issues that broad subsystem tests did not make
prominent. The resulting refinements were verified through commit `597fc3c` on
2026-07-18:

| Verification | Result |
| --- | --- |
| `npm run check` plus the numbering, structured-manuscript, editor, CairoMakie, materializer, native-HTML, and DOCX suites | Passed: 7 files / 79 tests after automatic numbering, captions, and unified output controls. |
| `npm test -- --run` plus an isolated permitted rerun of `services/collaboration/hocuspocusNetwork.test.ts` | Passed in aggregate: 124 files / 614 tests. The three network tests required loopback permission and then passed. |
| `npm run build` | Passed for the collaboration service, clean-export CLI, TypeScript application, and browser bundle. |
| Focused overlap follow-up | `npm run check`, 2 editor/CairoMakie files / 44 tests, and `npm run build` passed after the responsive control-shelf repair. |
| Rendered visual inspection | Verified quiet at-rest figures, compact reference controls, the ProseMirror drag-handle adjacency case, and non-overlapping wide/narrow control geometry. |

## Post-gate product refinements

These changes were driven by direct use of the application. They refine already
certified phase requirements without redefining their original gates.

| Product decision or repair | Evidence | Implementation commit |
| --- | --- | --- |
| Structured publication authors support reusable profiles, ORCID, email, and affiliations rather than name-only metadata. | `src/authorBank.test.ts`, `src/publicationMetadata.test.ts`, `tests/e2e/author-settings.spec.ts`, and native HTML/DOCX export tests. | `b719d11` |
| Starter sections remain conventional but sections and individual blocks can be added and reordered; rendered prose remains editable. | `src/StructuredManuscriptEditor.test.tsx`, `src/structuredManuscript.test.ts`, and `tests/e2e/generic-manuscript.spec.ts`. | `b719d11`, `e44eaea`, `250cea5` |
| Track changes is an explicit editing mode; contextual comments and anchored-text markers connect manuscript text to the review rail. | Suggestion-capture, portable-review, balloon-alignment, and review end-to-end tests. | `9384409`, `4696f03`, `d483fd9` |
| Project creation treats the chosen location as a parent and creates a sanitized project-name child directory. | Native temporary-directory tests in `src-tauri/src/lib.rs`. | `dc9e8d2` |
| Export dialogs choose directory and filename; native PDF is bridged through desktop printing; DOCX/HTML/PDF/Markdown remain clean and output-only. | `tests/e2e/publication-export.spec.ts`, `src/nativeHtmlExport.test.ts`, `src/docxExport.test.ts`, and native export tests. | `e3b9637`, `db60044`, `39b4872`, `577da90` |
| Executable code is supporting provenance, not publication content. Figures, tables, and named in-text values are published while source stays hidden by default. | `src/publishedValues.test.ts`, `src/executionWorkspaceApp.test.tsx`, `src/outputMaterializer.test.ts`, and exporter tests. | `347c174`, `d2443f2`, `0c2c134` |
| CairoMakie HTML/base64 wrappers are recovered as retained image figures instead of exposed source text. | `src/cairoMakieOutput.test.tsx` and `src/outputMaterializer.test.ts`. | `5f2b254`, `0d85304` |
| Figures, tables, and equations number independently; captions follow scientific placement conventions; references use current numbers across editor, HTML/PDF, and DOCX. | `src/numberedObjects.test.ts`, editor tests, `src/nativeHtmlExport.test.ts`, and `src/docxExport.test.ts`. | `15e4b63` |
| Code and retained output form one quiet manuscript object with hover/focus controls, touch fallback, compact references, and responsive non-overlapping rows. | `src/cairoMakieOutput.test.tsx`, `src/StructuredManuscriptEditor.test.tsx`, rendered geometry inspection, and the focused authoring build. | `15e4b63`, `597fc3c` |
| The White Graphite visual system and focused research/review surfaces replace the broad prototype styling. | Browser visual regression coverage and the application accessibility suites. | `a22554e`, `5920675`, `d483fd9` |

## Release-readiness corrections — 2026-11-06

These corrections follow a code and failure-path review of the local application and optional collaboration service. They do not certify a deployed service or installation on every supported OS.

| Correction | Regression evidence |
| --- | --- |
| Edits preserve unchanged portable blocks; escaping remains stable over reopen cycles; nested lists and hard breaks keep their meaning. | `structuredManuscript.test.ts`, portable corpus, rendered editor/reordering tests. |
| Node and Rust coordinate project writes and share durable recovery journals; competing revisions cannot both succeed. | `agentProjectStore.test.ts` and native `project_transactions` tests use independent processes and abrupt termination before commit, during rollback, and after the commit marker. See `project-transactions.md`. |
| Full local collaboration checkpoints atomically save source, figure bytes and CSL bibliography with expected hashes. Opening another manuscript is blocked while a live room is active. | Native `collaboration_checkpoint` tests, `collaborationCheckpointApp.test.tsx`, `collaborationProjectSnapshot.test.ts`. |
| Deferred Yjs structures/delete sets cannot evade role validation; writes are persisted before acknowledgement, and storage failures remain retryable. | `hocuspocusServer.test.ts`, `transportDurability.test.ts`, live `hocuspocusNetwork.test.ts`. |
| Shared figures/references reach browser reviewers; reconnecting an older local copy does not automatically replace current server resources. | `projectResources.test.ts`, `collaborationBrowserEntryApp.test.tsx`, client/dialog tests and authenticated WebSocket test. Updated figures/references require an explicit publish action; newly accepted citations publish their metadata with the live editing workflow. |
| Offline CRDT recovery merges concurrent tabs and compacts deleted image payloads. Failed persistence preserves the old journal and blocks unsafe navigation. | `collaborationJournal.test.ts`, `tests/e2e/collaboration-recovery.spec.ts` with real IndexedDB and reload. |
| Desktop sign-in uses a system-browser PKCE return, rotating memory-only tokens, and exact callback validation. CSP permits encrypted collaboration without remote scripts or unrestricted HTTP. | `oidcDesktop.test.ts`, native `oidc_desktop` tests, `desktopCsp.test.ts`, local desktop build. Installed OS callback behavior still needs platform smoke checks. |
| Native HTML/PDF contains static MathML and embedded figures; Word contains Office Math, images, formatting and hyperlinks. Submission ZIP and CLI image paths stay confined. | `publicationExportIntegrity.test.ts`, `publicationAssetReader.test.ts`, submission tests and `tests/e2e/publication-export.spec.ts`. A representative DOCX was converted with LibreOffice, rendered with Poppler and visually checked. |
| Publication formatting is derived from the exact source snapshot; freshness checks code hashes, dependencies, missing figure/table outputs and the actual exported artifact bytes. | `publicationCitations.test.ts`, `publicationFreshness.test.ts`, browser export tests. Input-file and runtime availability still use the existing execution provenance checks; this is not a scientific validation of results. |
| Production PostgreSQL TLS cannot be downgraded through a connection URL; exact desktop origins and a separate realtime rate budget are supported. | Configuration/workspace service tests and the complete service suite. Deployment remains separate work. |
| Home/account routes defer loading the manuscript editor and publication engines. | Production entry JavaScript decreased from approximately 2,103 kB to 301 kB (gzip approximately 624 kB to 90 kB) in the locked local build. Router/desktop-launch tests and rendered navigation checks verify the loading boundary. These are byte measurements, not a measured startup-latency claim. |

Verification on the local macOS arm64 checkout: 170 Vitest files / 900 tests passed (one Windows-only installer test skipped), 111 native Rust tests passed, all 40 application Chromium tests and 15 website Chromium tests passed. Type checks, production application/service/CLI/website builds, CLI/MCP/assistant gates, 689-component compliance inventory and release identity passed. The final macOS debug app bundled successfully and passed strict ad hoc signature verification. The routing/title follow-up also passed its focused unit and browser suites. No deployment was performed, and no actual Julia runtime was started.

Remaining scope limits: complex bibliography YAML is preserved and rejected explicitly when a checkpoint cannot rewrite it safely; unsupported Word math structures fail clearly; older interrupted AI journals without process ownership need explicit recovery rather than destructive automatic cleanup. The clean-export CLI does not acquire or format an external bibliography automatically. These limits must not be presented as verified end-to-end publication/deployment support.

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
| DM-P3-02 | `src/runtimeDiscovery.test.ts`, `src/desktopHost.test.ts`, and Rust runtime tests cover independent Python/R/Julia discovery, project-persisted kernel environments, selected-runtime repair, and explicit integration setup without project-open side effects. | `807192f`, `0b21e9c`, `fa6f4ae` |
| DM-P3-03 | `src/kernelExecution.ts`, `src/kernelExecutionTransport.test.ts`, and Rust native Jupyter-client tests assert one normalized Jupyter-only contract for status, streams, errors, MIME, display updates, artifacts, hashes, session generation, execution sequence, and recoverable single-lane contention. | `a71cd0d`, `0b21e9c` |
| DM-P3-04 | `src/executionLifecycle.test.ts`, `src/cleanExecution.test.ts`, `src/KernelConsole.test.tsx`, `src/executionWorkspaceApp.test.tsx`, and the real ipykernel integration test cover shared sessions, setup-first execution, console reuse and persistence, interrupt, restart, terminate, ordering, and isolation. | `807192f`, `a71cd0d`, `0b21e9c` |
| DM-P3-05 | `src/outputRenderer.test.tsx` and `src/executionBrowserApp.test.tsx` cover image, HTML, Markdown, text, table, and error MIME while blocking malicious HTML from privileged APIs. | `43fcae9` |
| DM-P3-06 | `src/outputMaterializer.test.ts` proves ordinary artifact/output-block materialization is byte-stable, idempotent, confined to reserved markers, and diagnostic on missing artifacts. | `d4cd7e8` |
| DM-P3-07 | `src/executionFreshness.test.ts`, `src/executionLifecycle.test.ts`, and `src/cleanExecution.test.ts` cover code/input/environment/artifact invalidation and restoration by clean run-all. | `7190509` |
| DM-P3-08 | `src/retainedOutputs.test.tsx`, `src/publishedValues.test.ts`, `src/publicationFreshness.test.ts`, `src/StructuredManuscriptEditor.test.tsx`, and `src/executionWorkspaceApp.test.tsx` cover current/stale/missing retained outputs and explicitly published scalar values independently from runtime availability. | `a75b38a`, `d2443f2`, `0b21e9c` |
| DM-P3-09 | `src/executionTrust.test.ts`, `src/executionBrowserApp.test.tsx`, Rust trust tests, and `src/sharedEditor/browserBoundary.test.ts` prove explicit trust and a browser build without execution capability. | `ed8827e` |
| DM-P3-GATE | `src/cleanExecution.test.ts`, `src/fixtures/execution/phase3-clean-restart.qmd`, native shared-kernel lifecycle tests, publication tests, retained-output tests, and the full release gate certify setup-first clean reproduction, state reuse, in-text values, and unavailable-runtime reopen. | `807192f`, `d2443f2`, `a71cd0d`, `0b21e9c`, `fa6f4ae`, `17e11a0` |

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

### DM-P7 — Alpha authoring polish and semantic-object workflow

DM-P7 was added on 2026-07-18 after the MVP evidence was reconciled with
hands-on product review. DM-P7-01 through DM-P7-05 and the alpha authoring gate
are complete in the canonical register.

| Task | Automated or reproducible evidence | Implementation commit |
| --- | --- | --- |
| DM-P7-01 | `src/semanticObjects.test.ts`, `src/StructuredManuscriptEditor.test.tsx`, `src/outputMaterializer.test.ts`, `src/numberedObjects.test.ts`, and table/serializer/export regressions cover friendly creation, deterministic duplicate suffixes, section/object numbering, rename compatibility, reorder, reopen, captionless table identities, legacy machine-label preservation, and quiet UUID-free normal controls. `npm run check` and 9 focused files / 88 tests passed. The full run passed 621 non-network tests; all 3 loopback collaboration tests then passed in an isolated permitted rerun (125 files / 624 tests in aggregate). | `6b489fd` |
| DM-P7-02 | `src/crossReferencePicker.test.ts`, `src/InsertBlockDialog.test.tsx`, and `src/StructuredManuscriptEditor.test.tsx` cover grouped current-number/caption choices, searching, Arrow-key focus transfer, insertion for figures/tables/equations/sections, retargeting, legacy-label concealment, and atomic labeling of older unlabeled targets. `npm run check`, 6 focused files / 66 tests, `npm run build`, and all 3 generic-manuscript Chromium tests passed. Wide and narrow rendered inspection verified non-overlapping geometry, visible focus, filtered selection, and a clean browser console. | `50f8f13` |
| DM-P7-03 | `src/semanticObjectInspector.test.ts`, `src/StructuredManuscriptEditor.test.tsx`, and `src/cairoMakieOutput.test.tsx` cover a shared object-details model for sections, figures, tables, equations, and reproducible outputs; caption and accessible-description edits; portable labels and `.unnumbered`; duplicate prevention; secondary UUID-free computation provenance; cross-reference retargeting; and atomic source-cell reference updates. Native HTML, PDF print-projection, and DOCX tests verify matching captions, descriptions, labels, numbering choices, and hidden computation source. All 127 Vitest files / 635 tests passed with bounded concurrency, `npm run check` and `npm run build` passed, and all 3 generic-manuscript Chromium tests passed against refreshed visual baselines. Rendered inspection confirmed consistent hierarchy, keyboard focus, and unobstructed actions after moving the status bar out of the manuscript overlay plane. | `d3915b1` |
| DM-P7-04 | `src/referenceIntegrity.test.ts` and `src/StructuredManuscriptEditor.test.tsx` cover valid, missing, duplicate, wrong-kind, and reproducible-orphan diagnoses; explicit non-linking failure states; atomic rename repair; external deletion; live numbering after block reorder; and keyboard-focus-preserving navigation from reference to object and back. Reference diagnostics feed the project checks. All 128 Vitest files / 641 tests passed with loopback collaboration enabled, `npm run check` and `npm run build` passed, and all 3 generic-manuscript Chromium tests passed against refreshed visual baselines. Rendered inspection verified the new reference-count controls do not collide with figure, table, or equation actions. | `9634582` |
| DM-P7-05 | `src/fixtures/projects/alpha-article` stores a structured-author/citation/review project with Python, R, and Julia figure, table, and published-value cells. `src/phase7AlphaDogfood.test.ts` proves exact round-trip, nine retained outputs, clean HTML/DOCX, a named-child copy, real Git checkpoint, close, and byte-identical reopen. `tests/e2e/alpha-dogfood.spec.ts` proves quiet source, review decisions, the freshness safety gate and override, HTML/PDF publication, and reload in the rendered app. `docs/alpha-dogfood-matrix.md` documents the Linux x64, Windows x64, macOS ARM, and macOS Intel gate now named in desktop CI. The focused unit gate (3 tests), Chromium dogfood (1 test), and `npm run check` passed locally on Darwin arm64. The dogfood also added a regression preventing collapsed code source from leaking through drag-handle accessible labels. | `3ebc0fa` |
| DM-P7-GATE | `src/phase7AlphaAuthoringGate.test.ts` accepts and resolves the stored article review, proves friendly non-machine labels, exact numbering/captions, six valid current-number references, unchanged retained outputs and values, deterministic serialize/reopen state, and matching clean HTML/DOCX semantics. `tests/e2e/alpha-dogfood.spec.ts` supplies the rendered workflow boundary. Final verification passed `npm run check`; 130 Vitest files / 645 tests; 32 Chromium tests; the collaboration/service/CLI/browser production build; release identity; real-process CLI projection; the 612-component compliance lock; and 75 native-host tests. Browser gate repairs in `4f7bf5b` replaced obsolete machine-label, color, shortcut, and pre-numbering assertions while retaining drag, keyboard, hover-control, citation-boundary, and visual checks. | `16b15d1`, `4f7bf5b` |

## Acceptance-criterion evidence

### Local MVP

| Criterion | Evidence | Implementation commit |
| --- | --- | --- |
| AC-L01 | Rendered editing is covered by `src/StructuredManuscriptEditor.test.tsx`, `src/genericManuscriptApp.test.tsx`, and `tests/e2e/generic-manuscript.spec.ts`. | `4b5c9e0` |
| AC-L02 | Portable projection/export is covered by portable-fixture gates, `src/nativeHtmlExport.test.ts`, `src/draftmatterCli.test.ts`, and optional external-adapter tests. | `24809c3` |
| AC-L03 | Unified citation acquisition and rendering is covered by `src/phase2CitationGate.test.ts` plus citation intake, Zotero, Crossref, picker, lock, and CSL tests. | `2a308a3` |
| AC-L04 | Python/R/Julia use one Jupyter-only shared-kernel contract, covered by transport tests, native-host protocol and real-kernel tests, `src/cleanExecution.test.ts`, publication tests, and the clean-restart fixture. | `807192f`, `d2443f2`, `a71cd0d`, `0b21e9c` |
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
but a public paid launch still requires environment-owned inputs: operated OIDC/billing/TLS and secret
management, provider-level database/object backups, alert routing,
privacy/data-processing and external security review, and production load/soak
tests. These are deployment gates documented in
`docs/collaboration-beta-gate.md` and `docs/release-compliance.md`; they are not
silently represented as locally completed production operations.

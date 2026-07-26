# DraftMatter

**Write the paper. Keep it reproducible.**

DraftMatter is a local-first research writing application that brings the manuscript, citations, executable results, review, collaboration, and version history into one calm workspace. Underneath the rendered writing experience, the manuscript remains a portable Markdown or Quarto text file that can live beside its code, data, and bibliography in an ordinary Git repository.

> [!IMPORTANT]
> DraftMatter has a certified local MVP and a repository-owned collaboration beta foundation. It is still an alpha product: signed public desktop releases and an operated hosted collaboration service have not completed their external deployment, security, privacy, and support gates. See the [product register](./draftmatter-app-design.md) and [implementation evidence](./docs/implementation-evidence.md).

## Why DraftMatter?

A reproducible paper often ends up scattered across a word processor, analysis notebooks, a reference manager, review copies, and a source repository. The prose may be polished, but the path from evidence to published figure or number becomes difficult to retrace.

DraftMatter puts the readable paper back at the center of the project:

| The usual disconnect | In DraftMatter |
| --- | --- |
| Figures, tables, and values are copied out of analysis files | Python, R, and Julia cells publish results directly into the manuscript |
| Citations are collected and formatted in separate tools | Crossref, Zotero, bibliography import, in-text citations, and the reference section share one workflow |
| Comments and tracked changes live in another review copy | Attributed suggestions and discussion stay anchored to portable manuscript source |
| The document format hides or fragments version history | The manuscript is plain text with rendered/source Git diffs and explicit checkpoints |
| Code makes the working file hard to read | Authors see a calm paper; code stays collapsed and publication exports contain results, not machinery |

DraftMatter does not replace your languages, IDE, Git client, or project structure. It gives the research manuscript the writing and review experience it deserves without severing it from those tools.

## Features

### A focused scholarly writing surface

- Edit a calm rendered manuscript while preserving ordinary `.md` or `.qmd` source.
- Structure and navigate sections, equations, figures, tables, footnotes, citations, and executable cells.
- Number figures, tables, equations, and sections automatically, with searchable semantic cross-references that stay current after reordering.
- Manage publication authors, reusable affiliations, email addresses, and ORCID identifiers.
- Preserve unfamiliar portable syntax rather than silently discarding it.

### Citations without leaving the draft

- Search and acquire references from the web through Crossref, with a Google Scholar handoff.
- Search a local Zotero library and bring its metadata into the project.
- Import BibTeX/BibLaTeX, CSL JSON, RIS/RefMan, and EndNote records by paste, drop, or file.
- Build a portable project bibliography with stable, collision-safe citekeys and offline metadata snapshots.
- Insert single citations or citation clusters with locators, prefixes, suffixes, and author suppression.
- Inspect the saved metadata from an in-text citation.
- Format in-text citations and the References section automatically using CSL styles and locales.
- Diagnose missing, duplicate, renamed, or otherwise inconsistent references before export.

### Reproducible figures, tables, and in-text values

- Execute Python, R, and Julia through shared Jupyter kernels in the desktop app.
- Mix all three languages in the same manuscript.
- Publish figures, tables, and named scalar values into the prose while keeping code collapsed during normal writing.
- Track whether outputs are current, stale, missing, or produced by a different code, input, or environment state.
- Retain outputs and their provenance so collaborators can read the paper even when their machine does not have the runtime.
- Run an explicit clean reproduction workflow with setup-first execution, interrupt, restart, and diagnostics.
- Never execute code merely because a project was opened; execution requires an explicitly trusted desktop project.

### AI integration, on your terms

- Use DraftMatter fully without AI, or connect Codex, Claude Code, GitHub Copilot, and Mistral Vibe once at device/client scope.
- Enable AI separately for each project; a connected assistant cannot use DraftMatter tools in an unenabled folder.
- Let assistants propose tracked rewrites and use typed semantic tools for figures, tables, values, citations, and validation instead of inventing managed IDs or editing internal markup.
- Keep assistant connection, project AI enablement, session-only code trust, and request-scoped network approval as four independent controls.
- Use the MCP server, execution host, and canonical authoring skill bundled with the desktop app—there is no separate MCP executable to install.

### Track changes, comments, and decisions

- Turn on Track changes for grouped insertions, deletions, paste, and replacements.
- Add point or range comments, reply in threads, resolve and reopen discussions, and keep attribution.
- Accept or reject individual or selected suggestions with an auditable decision history.
- Preserve overlapping alternatives and surface decision conflicts instead of silently choosing a last writer.
- Switch between simple review, all markup, original, and clean final views.
- Re-anchor review items after external edits and place ambiguous items manually.
- Export a standalone review report or deterministic original/final source from the app or CLI.

### Online collaboration without giving up project control

- Co-edit and review live with owner, editor, commenter, and viewer roles.
- Converge offline edits after reconnecting, including explicit handling of concurrent review decisions.
- Use one-use guest invitations, project-level role overrides, revocation, and an owner activity audit.
- Create an owner-controlled portable checkpoint before writing collaborative state back to the local project.
- Keep browser collaborators away from filesystem, process, execution, Git, and external-renderer capabilities by design.
- Run the collaboration service on the included self-hosted stack; the service boundary remains provider-neutral.

### Plain text and real version control

- Keep the manuscript, code, data, bibliography, and generated assets in one repository.
- Open the same text file in DraftMatter, your preferred IDE, or any Markdown/Quarto-aware tool.
- Recover from interrupted writes and keep bounded local draft history.
- Detect external edits, renames, deletions, and dirty-buffer conflicts without overwriting work.
- Inspect source or rendered semantic Git diffs.
- Stage selected paths, create named checkpoints, and use guarded branch, fetch, pull, push, and remote workflows.
- Keep Git actions explicit: opening or saving a manuscript never commits or contacts a remote.

### Clean publication outputs

- Export clean Markdown, HTML, print/PDF, and DOCX containing the paper, formatted references, cross-references, equations, and retained results.
- Keep code, review markup, and DraftMatter’s internal structures out of publication outputs.
- Prepare inert clean input for installed Pandoc or Quarto without allowing those adapters to execute manuscript code.
- Check output freshness and reference integrity before publication.
- Preserve accessible document structure, equation alternatives, figure descriptions, footnotes, and keyboard workflows.

## How the pieces fit together

```text
research-project/
├── paper.qmd              # the portable manuscript
├── references.bib         # project bibliography
├── data/                  # inputs
├── analysis.py
├── model.R
├── figures.jl
└── figures/               # retained publication outputs
```

DraftMatter renders `paper.qmd` as the everyday writing surface. On desktop, trusted cells can use the project’s Python, R, and Julia environments and materialize publication-ready outputs. Review and citation metadata round-trip with the portable source. Git can version the entire project, and clean export removes the authoring machinery from the deliverable.

The browser and desktop surfaces intentionally have different boundaries:

| Surface | Intended use |
| --- | --- |
| Browser build | Portable manuscript editing and review, the complete example, and optional online collaboration. No local filesystem, process execution, Git, or external renderers. |
| Tauri desktop | Local project folders, citation acquisition, explicitly trusted Python/R/Julia execution, retained outputs, recovery, Git, and optional Pandoc/Quarto adapters. |

## Run locally

The browser build requires Node.js 20 or newer.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. The browser implementation runs on macOS, Windows, and Linux and needs no backend for local demonstration.

The portable desktop build additionally requires the stable Rust toolchain and the platform prerequisites for Tauri 2:

```sh
npm run desktop:dev
```

See [collaboration self-hosting](./docs/self-hosting.md) to run the optional collaboration service locally.

## Explore the complete research project

Choose **Explore complete example** on the home page, or **Open complete example** from the project menu, to open an editable browser copy of [`src/fixtures/projects/alpha-article`](src/fixtures/projects/alpha-article/README.md).

The synthetic article exercises:

- complete IMRAD manuscript structure and publication metadata;
- citations, bibliography, an equation, footnotes, and semantic cross-references;
- Python, R, and Julia figures, tables, and in-text values;
- retained outputs with freshness and provenance;
- one tracked suggestion and one comment thread;
- clean HTML, PDF, DOCX, and Markdown projection.

Opening the example never executes its code. Copy the fixture folder elsewhere and open it as a trusted desktop project when you want to run the cells.

## Clean export CLI

The build produces a dependency-free Node.js command and minimal package in `dist-cli`. It uses the same review projector and inert native HTML renderer as the app and never executes manuscript code.

```sh
npm run build:cli
node dist-cli/draftmatter.js render paper.qmd --view original -o original.qmd
node dist-cli/draftmatter.js render paper.qmd --view final --select dm-change-id -o final.qmd
node dist-cli/draftmatter.js render paper.qmd --view final --format html -o article.html
node dist-cli/draftmatter.js review-report paper.qmd -o review-report.md
npm run pack:cli
```

Final rendering exits with status `2` and writes no output when overlapping proposals still need a choice. The diagnostic lists every conflict and candidate; pass one `--select` ID from each conflict. Use `-` for standard input or output. Installing the generated `draftmatter-<version>.tgz` archive globally exposes the command as `draftmatter`.

## Verification

```sh
npm run check
npm test
npm run test:e2e
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run compliance:check
npm run release:verify
```

Production desktop installers are built from version tags as signed/notarized draft releases for Windows x64, Linux x64, and both macOS architectures. Manual workflow runs produce unsigned release candidates only; see the [release gate](./docs/release-compliance.md).

## Project documentation

- [Product and architecture brief](./draftmatter-app-design.md)
- [Implementation evidence](./docs/implementation-evidence.md)
- [Complete example and dogfood matrix](./docs/alpha-dogfood-matrix.md)
- [Performance and recovery budgets](./docs/performance-and-recovery.md)
- [Release, diagnostics, and compliance](./docs/release-compliance.md)
- [Collaboration boundary](./docs/collaboration-boundary.md)
- [Collaboration persistence and operations](./docs/collaboration-operations.md)
- [Collaboration beta core gate](./docs/collaboration-beta-gate.md)
- [Collaboration service and self-hosting](./docs/self-hosting.md)
- [Collaboration operations runbook](./docs/collaboration-runbook.md)

## License

DraftMatter is available under the [MIT License](./LICENSE).

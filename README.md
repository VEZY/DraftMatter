# DraftMatter

DraftMatter is a local-first research writing application: a calm rendered manuscript with citations, executable-cell provenance, review suggestions, comments, and portable Markdown/Quarto source.

## Run locally

The browser build requires Node.js 20 or newer. The portable desktop build additionally requires the stable Rust toolchain and the platform prerequisites listed by Tauri 2.

```sh
npm install
npm run dev
```

The browser implementation runs on macOS, Windows, and Linux and needs no backend. The Tauri desktop host adds project-folder persistence, citation acquisition, explicitly trusted Python/R/Julia execution, retained output manifests, local Git checkpoints, and optional system Pandoc/Quarto adapters. Opening a project never executes manuscript code or performs a Git/network action.

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

The local MVP supports opening and creating `.md`/`.qmd` projects; deterministic, portable comments and suggestions; BibTeX/CSL JSON/RIS/EndNote citation intake; Crossref and local Zotero acquisition; explicit trusted execution with retained outputs; recovery history; native clean Markdown/HTML/print-PDF/DOCX exports; optional inert Pandoc/Quarto exports; rendered/source Git diffs; selected local checkpoints; and guarded branches and remotes.

## Clean export CLI

The build also produces a dependency-free Node.js command and minimal package in `dist-cli`. It uses the same review projector and inert native HTML renderer as the app and never executes manuscript code.

```sh
npm run build:cli
node dist-cli/draftmatter.js render paper.qmd --view original -o original.qmd
node dist-cli/draftmatter.js render paper.qmd --view final --select dm-change-id -o final.qmd
node dist-cli/draftmatter.js render paper.qmd --view final --format html -o article.html
node dist-cli/draftmatter.js review-report paper.qmd -o review-report.md
npm run pack:cli
```

Final rendering exits with status `2` and writes no output when overlapping proposals still need a choice. The diagnostic lists every conflict and candidate; pass one `--select` ID from each conflict. Use `-` for standard input or output. Install the generated `draftmatter-<version>.tgz` archive globally to expose the command as `draftmatter`; tagged releases attach the same platform-neutral archive.

Useful implementation notes:

- [Performance and recovery budgets](./docs/performance-and-recovery.md)
- [Release, diagnostics, and compliance](./docs/release-compliance.md)
- [Collaboration persistence and operations](./docs/collaboration-operations.md)
- [Collaboration beta core gate](./docs/collaboration-beta-gate.md)
- [Collaboration service and self-hosting](./docs/self-hosting.md)
- [Collaboration operations runbook](./docs/collaboration-runbook.md)
- [Product and architecture brief](./draftmatter-app-design.md)

The collaboration path includes a tested browser-safe editor/reviewer, offline-capable Yjs state, OIDC and tenant-scoped PostgreSQL authorization, authenticated Hocuspocus transport, S3-compatible immutable snapshots, durable entitlements, and a portable self-hosted service image. Browser builds intentionally have no filesystem, process, execution, Git, or external-renderer capability. See [the collaboration boundary](docs/collaboration-boundary.md).

Production desktop installers are built from version tags as signed/notarized draft releases for Windows x64, Linux x64, and both macOS architectures. Manual workflow runs produce unsigned release candidates only; see [the release gate](docs/release-compliance.md).

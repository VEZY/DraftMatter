# DraftMatter

DraftMatter is a local-first research writing prototype: a calm rendered manuscript with citations, executable-cell provenance, review suggestions, comments, and portable Markdown/Quarto source.

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
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run compliance:check
```

The local MVP supports opening and creating `.md`/`.qmd` projects; deterministic, portable comments and suggestions; BibTeX/CSL JSON/RIS/EndNote citation intake; Crossref and local Zotero acquisition; explicit trusted execution with retained outputs; recovery history; native clean Markdown/HTML/print-PDF/DOCX exports; optional inert Pandoc/Quarto exports; rendered/source Git diffs; selected local checkpoints; and guarded branches and remotes.

Useful implementation notes:

- [Performance and recovery budgets](./docs/performance-and-recovery.md)
- [Release, diagnostics, and compliance](./docs/release-compliance.md)
- [Collaboration persistence and operations](./docs/collaboration-operations.md)
- [Product and architecture brief](./draftmatter-app-design.md)

Paid browser collaboration is a later phase. Its shared editor/reviewer surface now has a tested browser-safe entrypoint, an offline-capable Yjs state model, and a tenant-isolated authorization core; browser builds intentionally have no filesystem, process, execution, Git, or external-renderer capability. See [the collaboration boundary](docs/collaboration-boundary.md).

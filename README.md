# DraftMatter

DraftMatter is a local-first research writing prototype: a calm rendered manuscript with citations, executable-cell provenance, review suggestions, comments, and portable Markdown/Quarto source.

## Run locally

Requires Node.js 20 or newer.

```sh
npm install
npm run dev
```

The browser implementation runs on macOS, Windows, and Linux. It needs no backend. Edits and a bounded recovery journal stay in local browser storage, while reviewed or clean `.qmd` projections can be downloaded at any time.

## Verification

```sh
npm run check
npm test
npm run build
```

The current vertical slice supports opening `.md`/`.qmd` manuscripts, deterministic review parsing and projection, preservation of unsupported top-level sections, semantic citation UI, mocked explicit code execution, overlapping proposal decisions, comments, recovery history, and reviewed/original/final downloads.

The live Zotero API, filesystem-backed desktop projects, real Python/R/Julia execution, Git host commands, and Tauri shell remain subsequent implementation milestones described in [the product and architecture brief](./draftmatter-app-design.md).

# Complete DraftMatter example

This folder is a self-contained, synthetic research article that demonstrates DraftMatter's portable authoring model end to end.

Open the folder as a project and use `paper.qmd` as the main manuscript. It includes:

- a complete scientific article from abstract through declarations, followed by DraftMatter's automatically generated bibliography;
- three authors, three deduplicated affiliations, and an example ORCID;
- clustered author–date citations and a project bibliography;
- a numbered equation, footnote, semantic figure/table identities, and cross-references;
- dependency-free Python, base R, and Julia cells, each producing a figure, table, and published scalar value;
- retained outputs, so opening and exporting never execute code;
- one attributed replacement suggestion with rationale and one two-message comment thread;
- small CSV inputs and accessible, publication-ready SVG figures.

The paper, data, institutions, people, and references are deliberately synthetic. The example is suitable for UI demonstrations, export checks, portability tests, and learning the source format; it is not a scientific dataset.

The example is already prepared for a connected AI assistant. Opening it does not contact a model or run code; DraftMatter still asks separately before code execution or an online reference search.

## Local-agent acceptance coverage

The complete example is also the publication-side fixture for the
provider-neutral AI integration. It contains the same classes of durable state
that an agent can create through the DraftMatter service: project-scoped assistant access, attributed review,
Python/R/Julia computations, retained figures and tables, named in-text values,
citations, provenance, and freshness manifests. `src/phase7AlphaAuthoringGate.test.ts`
proves that this state reopens and produces clean HTML and DOCX, while
`scripts/verify-agent-e2e.mjs` creates the corresponding state from agent
requests over MCP, performs a real R clean run, reconnects, and verifies clean
Markdown and HTML publication output. Browser publication tests cover the PDF
path without executing manuscript code.

## Runtime notes

The code cells avoid third-party packages. Re-execution requires Python 3, R, or Julia only for the cells written in that language. DraftMatter will ask for explicit trust before starting a local kernel, and it will mark retained results stale when their code or inputs change.

## Useful review path

1. Read the rendered manuscript with computation source collapsed.
2. Follow each figure, table, and equation cross-reference.
3. Open the Review panel, inspect the quantitative suggestion and threaded comment, then accept or resolve them.
4. Export a clean HTML, PDF, DOCX, or Markdown copy and confirm that review metadata and executable source are absent.
5. Reopen the project and confirm that the retained outputs and review decisions persist.

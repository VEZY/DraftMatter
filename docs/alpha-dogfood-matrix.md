# Alpha article dogfood matrix

This document is the reproducible operating-system matrix for **DM-P7-05**.
The stored project at
`src/fixtures/projects/alpha-article` is the canonical article-sized dogfood
manuscript. It is copied before every lifecycle test; the fixture itself is
never repaired or rewritten by a test.

## Representative project

The project deliberately combines the ordinary workflows that had previously
been tested in isolation:

- two structured publication authors, two affiliations, and one ORCID;
- two cached citations and a portable project bibliography;
- Python, R, and Julia figure, table, and published-value cells;
- three retained figures, three retained tables, and the published values
  `18.4 cm`, `0.032`, and `0.91`;
- six valid cross-references with friendly figure and table identities;
- one attributed suggestion and one point-anchored comment;
- a DraftMatter project descriptor and normal relative figure assets.

The fixture represents an article after its computations have been retained.
Opening or exporting it never executes code. Runtime discovery and live shared
kernel execution remain covered by the DM-P3 gate; this gate verifies that
results from every supported language survive the authoring, review,
publication, checkpoint, and reopen lifecycle.

## Automated matrix

`.github/workflows/desktop-portability.yml` runs `npm run test:alpha` as a named
step on every supported desktop target. The test uses Node's platform path APIs
and the installed Git executable, so the same assertions exercise native path
and process behavior on each runner.

| Platform | Target | Article lifecycle | Native coverage |
| --- | --- | --- | --- |
| Linux x64 | `x86_64-unknown-linux-gnu` | `npm run test:alpha` | Full frontend suite, Rust host tests, CLI process test, and debug application build |
| Windows x64 | `x86_64-pc-windows-msvc` | `npm run test:alpha` | Full frontend suite, Rust host tests, CLI process test, and debug application build |
| macOS Apple Silicon | `aarch64-apple-darwin` | `npm run test:alpha` | Full frontend suite, Rust host tests, CLI process test, and debug application build |
| macOS Intel | `x86_64-apple-darwin` | `npm run test:alpha` | Full frontend suite, Rust host tests, CLI process test, and debug application build |

The article lifecycle gate asserts exact parse/serialize bytes, authors,
citations, semantic-object numbering, reference integrity, all nine retained
outputs, all three published values, review records, output-only HTML/DOCX,
deterministic clean projection, named-child project creation, a real Git
checkpoint, clean status, close, and byte-identical reopen.

`.github/workflows/browser-e2e.yml` additionally runs
`tests/e2e/alpha-dogfood.spec.ts` in Chromium on Linux. That rendered test:

1. opens the stored project with code collapsed and no computation source in
   accessible block labels;
2. verifies the authors, citations, figures, tables, values, and six live
   cross-references;
3. accepts a suggestion and resolves a comment;
4. proves the default publication-freshness block, then uses the explicit
   author override for retained results;
5. downloads clean HTML, invokes the system PDF-print bridge, reloads, and
   verifies the review decisions and Final preview.

## Local verification record

On 2026-07-18 the focused gate passed on Darwin arm64 with Node 24:

- `npm run test:alpha`: 2 files / 4 tests;
- `npx playwright test tests/e2e/alpha-dogfood.spec.ts --reporter=line`:
  1 Chromium test;
- `npm run check`: passed.

The completed DM-P7 certification also passed 130 Vitest files / 645 tests,
all 32 Chromium tests, the production browser/service/CLI build, release
identity, real-process CLI projection, the 612-component compliance lock, and
75 native-host tests on the same machine.

The rendered dogfood found one real privacy/accessibility defect: a collapsed
code block's drag-handle label repeated its source. The block label now names
only the language and reproducible-output role, and the editor regression test
forbids source leakage. Test-harness findings about reload seeding and review
presentation were fixed in the gate itself rather than treated as product
defects.

## Manual installed-app smoke

Before distributing an alpha installer, run this short check on one installed
build for each operating system. It complements, but does not replace, the
automated matrix:

1. Copy `src/fixtures/projects/alpha-article` outside the repository and open
   the copy in DraftMatter.
2. Confirm all three figures and tables render, all three in-text values are
   ordinary prose, and source stays closed until explicitly requested.
3. Open each reference and return from its target; no machine cell identifier
   should be the primary label.
4. Accept the suggestion, resolve the comment, and create a local checkpoint.
5. Export HTML, DOCX, and PDF to author-chosen names and locations. Confirm the
   documents contain outputs but no Python, R, or Julia source.
6. Quit, reopen the project, and confirm numbering, captions, references,
   outputs, citations, authors, and review state match without source edits.

Record any platform-specific loss, blocked action, accessibility problem, or
visual collision as a reproducible fixture/test before changing this matrix.

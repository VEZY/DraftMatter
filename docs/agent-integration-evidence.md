# Local AI integration evidence

Status: complete for integration schema `1` and agent protocol `1.0`.

This page is the permanent verification record for DraftMatter's
provider-neutral local-agent integration. The implementation goal was developed
under the temporary `DM-AI-P0` through `DM-AI-P8` register and certified on
2026-07-25.

## Shipped architecture

- The headless service owns semantic manuscript, review, computation,
  reference, validation, transaction, audit, and idempotency behavior.
- `draftmatter agent` exposes the same protocol as one JSON request or a
  bounded sequential session envelope.
- `draftmatter mcp --stdio --project-root <project>` exposes six strict MCP
  tools and targeted resources without opening a network listener.
- `draftmatter-authoring` is the canonical provider-neutral skill.
- Project `AGENTS.md`/`CLAUDE.md` blocks and Codex, Claude, Copilot, and Vibe
  adapters are generated from one versioned integration source.
- The Codex plugin packages the same MCP command and skill; it contains no
  Codex-specific manuscript operations.

Detailed design and safety rationale are in
[agent-integration.md](architecture/agent-integration.md),
[local-agent-protocol.md](architecture/local-agent-protocol.md), and
[agent-integration.md](security/agent-integration.md).

## Acceptance evidence

| Scenario | Evidence |
| --- | --- |
| Attributed tracked prose review | `src/agentService.test.ts`; `scripts/verify-agent-e2e.mjs`; ordinary review UI and reopen tests |
| Generated reproducible figure | Generic MCP creates an R figure without a caller ID, label, filename, or path; the real Jupyter run returns progress, provenance, freshness, and image content; reconnect reopens the manifest and artifact |
| Generated table and named value | Generic MCP creates/runs the R table and `sample_size`, retains CSV/table/value state, inserts the semantic value reference, clean-runs, and reopens it |
| Reference acquisition and citation | Service tests cover local records and explicitly approved Crossref acquisition, deduplication, CSL JSON, citation lock/cache, and atomic add-and-cite; Rust tests cover bounded Zotero and Crossref protocols; generic MCP inserts a saved project citation |
| Clean reproduction and recovery | Real R clean-run, progress, cancellation, interruption status, timeout unit test, kernel lifecycle controls, and persistent manifests |
| Concurrent external edit | External-edit stale rejection, simultaneous-client serialization, expected revisions, idempotent retry after reconnect, and rebase-oriented diagnostics |
| Missing integration | Preview-only `ai init/configure/update/remove`, doctor repairs, managed instruction pointers, and structured CLI fallback |
| Cross-client portability | Codex and Vibe matrix below; generic MCP SDK drives the complete workflow without provider extensions |
| Publication output | Agent-created state produces clean Markdown and HTML; the complete scientific fixture verifies clean HTML/DOCX and browser PDF with figures, tables, values, citations, references, equations, and cross-references but no code or agent/review protocol state |

## Client compatibility matrix

| Client | Verified behavior | Limitation |
| --- | --- | --- |
| Codex CLI `0.146.0-alpha.3.1` from the unified desktop app | Loads trusted project `AGENTS.md` and the project canonical skill; accepts the DraftMatter stdio MCP registration shape through its real config parser | No model/API call was made. Project-local `.codex/config.toml` MCP discovery varies by release, so the validated thin plugin is the recommended unified-app registration path |
| Mistral Vibe `2.2.1` | Loads `AGENTS.md`, canonical skill, project MCP server, and all six tools; directly invokes its MCP proxy to persist and reinspect a tracked suggestion | No Mistral model/API call was needed |
| Claude Code | Generated `.mcp.json`, `CLAUDE.md` forwarding block, and byte-identical `.claude/skills/` copy are merge/update/remove tested | Client executable was not installed on the verification host |
| GitHub Copilot | Generated repository MCP JSON and shared `AGENTS.md`/skill path are merge/update/remove tested against the documented adapter shape | Copilot CLI was not installed on the verification host |
| Generic MCP SDK `1.29.0` | Initializes over stdio, discovers tools/resources, drives the full scientific workflow, cancels, closes, and reconnects | Provider-neutral reference client rather than a model host |

Client versions are detected by `scripts/verify-installed-agent-clients.mjs`;
missing locally installed clients are reported rather than simulated.

## Security and recovery evidence

- Traversal, absolute paths, symlink escapes, moved/replaced roots, stale
  revisions, simultaneous writers, and malformed generated state fail closed.
- A deterministic interrupted multi-file transaction restores every replaced
  file and leaves a `rolled-back` journal.
- Execution requires exact session trust, supports deadlines/cancellation, and
  never runs while opening or exporting.
- Manuscript prompt injection remains readable data and cannot grant trust,
  change the root, authorize network access, or bypass the path boundary.
- Request validation covers unknown generated IDs, malformed objects, deep
  nesting, oversized text, and bounded output.
- The audit records actor/provenance/revisions/references without request
  bodies, prompts, model reasoning, manuscript text, secrets, or logs.
- Durable artifact fingerprints make direct or interrupted artifact changes
  stale and recoverable by an explicit rerun even though kernel code writes the
  artifact before the retained-output/manifest transaction.

## Release verification

The certification run on 2026-07-25 passed:

| Command | Result |
| --- | --- |
| `npm run check` | TypeScript application check passed |
| `npm test` | 154 files / 759 tests passed, including permitted loopback collaboration tests |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 89 native tests passed |
| `npm run test:e2e` | 50 Chromium desktop tests passed |
| `npm run build` | Collaboration service, CLI, TypeScript app, and browser bundle built |
| `npm run test:cli` | Clean export plus JSON request/session protocol passed |
| `npm run test:mcp` | Initialization, six tools, resources, bounds, invalid input, close, and reconnect passed |
| `npm run test:agent-adapters` | Preview/configure/doctor/update/remove and preservation passed |
| `npm run test:agent-host` | Persistent real R Jupyter host passed |
| `npm run test:agent-e2e` | Real R MCP and JSON-session scientific workflow passed |
| `npm run test:agent-clients` | Installed Codex boundary and direct Vibe MCP mutation passed |
| `npm run test:agent-performance` | All five budgets passed; measured startup/discovery 81.13 ms, inspect 5.67 ms, read 8.20 ms, preview 10.74 ms, artifact 2.53 ms |
| `npm run validate:agent-skill` | Canonical sync, plugin metadata, isolated marketplace install/uninstall, and generated-copy checks passed |
| Official skill/plugin validators | Skill and plugin both passed |
| `npm run compliance:check` | 694 locked components passed the target license/SBOM inventory |
| `npm run release:verify` | npm/Cargo/Tauri/plugin versions, MCP SDK pin, and scoped dependency exception passed |
| `npm pack ./dist-cli --dry-run --json` | 19-file package contains CLI, canonical skill, personal marketplace, and plugin dotfiles |

`npm audit` reported two moderate entries for the SDK's unused Hono HTTP
adapter path and no high or critical findings. The stdio-only, time-bounded
exception is recorded in `compliance/security-exceptions.json` and must be
reviewed by 2026-08-25.

The Playwright certification refreshed three visually inspected semantic-editor
baselines for the pinned Chromium release; the table change was a one-pixel
empty-edge crop, not a product-layout change. Publication export also waits for
the bibliography title before initiating export, removing an asynchronous test
race without weakening output assertions.

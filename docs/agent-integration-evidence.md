# Local AI integration evidence

Status: implemented for project enablement schema `2`, connection receipt schema
`1`, and agent protocol `1.0`.

This is the permanent verification record for DraftMatter's provider-neutral
local-agent integration, including the 2026-07-26 architecture correction that
separates device/client connection from project enablement.

## Shipped architecture

### Device/client-wide connection

- **Home** and **application settings** expose **Connect AI assistants** without
  requiring an open project.
- `src/assistantIntegration.ts` detects Codex, Claude Code, GitHub Copilot, and
  Mistral Vibe; inspects MCP and skill state; previews and applies
  Install/Update/Repair/Remove; records managed revisions; and preserves
  unrelated configuration.
- Codex uses the DraftMatter plugin when `codex plugin list` proves the installed
  unified client supports plugin management. Older clients receive equivalent
  user-wide `~/.codex/config.toml` and skill registration.
- `src-tauri/src/assistant_connections.rs` locates the bundled MCP sidecar and
  invokes connection actions with no project state.
- `.github/workflows/desktop-release.yml` builds and bundles target-native
  `draftmatter-mcp` and `draftmatter-agent-host` sidecars for Windows, Linux,
  and both macOS architectures.

### Project-wide enablement

- Project creation, the Project menu, project AI status, and the post-open
  prompt expose **Enable AI for this project**.
- `src/agentIntegration.ts` merges managed `AGENTS.md`/`CLAUDE.md` pointers,
  optionally installs the portable `.agents/skills/` fallback, and writes
  `.draftmatter/ai-integration.json` schema `2`.
- Supported clients require no project-local MCP adapter. Schema-1 adapters are
  removed only when the legacy DraftMatter manifest proves ownership.
- Disable removes only unchanged DraftMatter-managed enablement files and does
  not touch manuscripts, references, outputs, review history, audit, or
  idempotency data.

### Project gate and pinned MCP root

- `draftmatter mcp --stdio` resolves the startup project from `cwd` by default;
  `--project-root` remains startup-only for compatibility.
- `src/agentProjectEnablement.ts` rejects absent, disabled, malformed, or
  unsupported project manifests before MCP or JSON-agent access.
- `src/agentMcpServer.ts` and `src/agentProjectStore.ts` canonicalize and pin
  the project path and filesystem identity.
- Tool schemas contain no project-root field. Strict validation rejects later
  injection, traversal, symlink escape, and root replacement.

### Independent sensitive approvals

The UI and protocol keep four states distinct:

1. assistant connected to DraftMatter;
2. AI enabled for this project;
3. project trusted for code execution;
4. network approved for this specific request.

Setup does not contact a model, execute manuscript code, grant execution trust,
enable Zotero/Crossref access, or approve future client tool calls.

## Acceptance evidence

| Requirement | Evidence |
| --- | --- |
| Device scope works without a project | `src/assistantIntegration.test.ts`; `src-tauri/src/assistant_connections.rs`; `src/AssistantConnectionsDialog.tsx` |
| Detect/current/preview/Install/Update/Repair/Remove | `src/assistantIntegration.ts`; device connection tests; advanced CLI `draftmatter assistants …` |
| Preserve unrelated client config | Claude/Copilot/TOML merge tests, Codex marketplace preservation test, modified-file Repair gate |
| Bundled MCP and execution host | `scripts/build-desktop-sidecars.mjs`; desktop release target matrix and `externalBin` configuration |
| Codex plugin with safe fallback | plugin capability probe, generated local marketplace/plugin files, fallback status note, canonical plugin validator |
| Project creation/menu/status/post-open surfaces | `src/NewLocalProjectDialog.tsx`; `src/ProjectNavigationMenu.tsx`; `src/AgentIntegrationDialog.tsx`; app post-open banner |
| Schema-2 enable/update/disable | `src/agentIntegration.test.ts`; native project creation/migration/rollback tests |
| Legacy migration only with ownership | schema-1 migration tests plus unowned project-client preservation tests in TypeScript and Rust |
| Disabled projects rejected | MCP startup and post-disable rejection tests |
| Root pinning/injection rejection | in-memory MCP test starts from `cwd`, injects another enabled root, and verifies strict failure |
| Traversal/symlink/root replacement | `src/agentProjectStore.test.ts` and agent security/service suites |
| Reversible without content/history damage | project disable test and adapter verification script |
| Four states remain separate | `src/AgentIntegrationDialog.tsx`; `/learn/ai`; phase gate UI fixtures; doctor result |
| Home feature and linked monochrome brands | `src/Home.tsx`, `src/Home.css`, `public/ai-openai.svg`, `public/ai-anthropic.svg`, `public/ai-mistral.svg`, browser visual QA |
| Provider-neutral semantic workflow | service/MCP/CLI tests and `scripts/verify-agent-e2e.mjs` |

## Client compatibility

| Client | User/device registration | Project-local requirement |
| --- | --- | --- |
| Codex unified app/CLI | DraftMatter plugin where supported; otherwise user MCP config and canonical skill | `AGENTS.md` pointer only; optional portable skill |
| Claude Code | `~/.claude.json` and user skill | `CLAUDE.md` forwards to `AGENTS.md`; no MCP file |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` and user skill | `AGENTS.md`; no MCP file |
| Mistral Vibe Code | `~/.vibe/config.toml` and user skill | `AGENTS.md`; no MCP file |

The actual model provider is outside DraftMatter. All four clients reach the
same six strict MCP tools:

- `draftmatter_project`
- `draftmatter_manuscript`
- `draftmatter_computation`
- `draftmatter_references`
- `draftmatter_review`
- `draftmatter_validate`

## Reproducible verification

```sh
npm run check
npm test
npm run build
npm run test:cli
npm run test:mcp
npm run test:agent-adapters
npm run test:agent-e2e
npm run test:agent-performance
npm run validate:agent-skill
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

The tests and setup previews use local fixtures only. Installed-client probes
do not send a prompt to a model or make an API request.

## Implementation checkpoints

- `927c882` — separate assistant connections from project AI access
- `4f83089` — bundle device-wide assistant connections and Codex plugin
  fallback

The canonical user guide is [AI integration, on your terms](ai-integration.md).
The design and threat model are
[Local agent integration architecture](architecture/agent-integration.md),
[Local agent protocol](architecture/local-agent-protocol.md), and
[Local agent integration security](security/agent-integration.md).

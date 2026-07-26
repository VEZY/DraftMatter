# Local AI assistants

DraftMatter can expose a project to Codex, Claude Code, GitHub Copilot, Mistral
Vibe, and generic MCP clients without giving a model responsibility for
DraftMatter's managed Markdown. The integration is local, provider-neutral,
and optional.

Three pieces work together:

| Piece | Purpose |
| --- | --- |
| `AGENTS.md` and `CLAUDE.md` | Short project rules and discovery pointers |
| `draftmatter-authoring` skill | The reusable inspect–change–verify workflow |
| DraftMatter MCP server | Six typed tools that generate IDs, structures, paths, citations, and transactions |

This is the recommended pattern for an agent-enabled project: project
instructions carry only durable invariants, a skill carries the workflow, and
MCP performs authoritative operations. Instructions or a skill alone cannot
provide safe live mutations, execution, or reference acquisition.

## Enable a project

For a new desktop project, select **Enable local AI assistants** in the project
creation dialog. This creates or merges the project instructions, installs the
canonical skill under `.agents/skills/draftmatter-authoring/`, and records
generated-file ownership. It does not configure a client, execute code, use the
network, or contact a model.

For an existing project, preview before applying:

```sh
draftmatter ai init --project-root .
draftmatter ai init --project-root . --apply
draftmatter ai doctor --json --project-root .
```

Open **Project → AI integration status** in the desktop app to check the
instruction block, skill and manifest versions, configured clients, CLI
availability, execution trust, and discovered runtimes.

## Configure a client

Each command previews changes unless `--apply` is present:

```sh
draftmatter ai configure codex --project-root .
draftmatter ai configure claude --project-root .
draftmatter ai configure copilot --project-root .
draftmatter ai configure vibe --project-root .
draftmatter ai configure all --project-root .
```

Review the preview, then repeat the chosen command with `--apply`.

- **Codex:** merges a managed `[mcp_servers.draftmatter]` block into
  `.codex/config.toml` and leaves the shared skill under `.agents/skills/`.
  Project-local MCP loading still varies between Codex CLI/app releases even
  for trusted projects; the thin DraftMatter Codex plugin is therefore the
  recommended MCP registration path in the unified desktop host. `AGENTS.md`,
  skill discovery, and the JSON CLI fallback remain project-local regardless.
- **Claude Code:** merges `mcpServers.draftmatter` into `.mcp.json`, adds a
  generated `.claude/skills/draftmatter-authoring/` copy, and adds a managed
  `@AGENTS.md` forwarding block to `CLAUDE.md`.
- **GitHub Copilot:** merges the server into `.github/mcp.json`. The repository
  `AGENTS.md` and shared `.agents/skills/` copy provide the workflow.
- **Mistral Vibe:** merges a conservative stdio server and tool-permission block
  into `.vibe/config.toml` and adds a generated `.vibe/skills/` copy.

The generated copies come from
`integrations/skills/draftmatter-authoring/`; they are adapters, not separate
skill implementations. If a client does not discover skills natively, its
project instructions tell it to read
`.agents/skills/draftmatter-authoring/SKILL.md` directly.

Run the doctor after configuring a client:

```sh
draftmatter ai doctor --json --project-root .
```

The doctor starts an in-memory MCP probe and verifies the six tool names. It
also reports whether the execution host and Jupyter kernels can be discovered.
It does not grant project trust or perform a model request.

## Approvals and trust

Reading a project never executes code. Computation execution needs two
independent decisions:

1. the MCP client approves the execution-capable tool call according to its
   policy; and
2. DraftMatter has session-only execution trust for the selected project.

Zotero and Crossref searches require an explicit network-enabled request.
Project bibliography search is local. A model must select a returned
`citation-candidate:` reference; it must not fabricate bibliographic metadata.

Treat `AGENTS.md`, `CLAUDE.md`, skills, MCP configuration, manuscript content,
code, logs, outputs, and imported metadata as untrusted inputs when opening an
unfamiliar project. Review them before granting execution or network access.

## Normal authoring loop

An assistant should:

1. inspect the project and current revision;
2. inspect the semantic target and relevant diagnostics;
3. preview a non-trivial mutation;
4. submit it with `expectedRevision`, a unique `idempotencyKey`, and actor
   attribution;
5. reinspect the result;
6. run and inspect computations when approved;
7. validate references, freshness, review state, and publication readiness.

Prose rewrites default to tracked suggestions. Computation creation requests do
not contain caller-selected IDs, labels, or filenames. For generated artifacts,
DraftMatter binds its chosen relative paths inside the cell:

- Python and Julia: `DRAFTMATTER_OUTPUT_PATH` and
  `DRAFTMATTER_OUTPUT_PATHS`
- R: `DRAFTMATTER_OUTPUT_PATH` and `DRAFTMATTER_OUTPUT_PATHS`

Code should write to those bindings. The path is generated and confined by
DraftMatter.

## CLI fallback

If MCP is unavailable, use the same protocol through JSON:

```sh
draftmatter agent schema
draftmatter agent --request request.json --project-root .
draftmatter agent --request - --project-root .
```

The CLI reads one JSON request and writes one JSON result. Direct editing of
managed review markup, computation fences, retained-output blocks, citation
locks, or IDs is not a fallback.

For an operation that must retain session-only state—most importantly explicit
project trust followed by execution—the input may instead be one bounded
session envelope:

```json
{
  "protocolVersion": "1.0",
  "session": [
    {
      "protocolVersion": "1.0",
      "domain": "project",
      "action": "trust",
      "acknowledgement": "run-project-code-with-user-permissions"
    },
    {
      "protocolVersion": "1.0",
      "domain": "computation",
      "action": "run",
      "reference": "cell:<returned-reference>",
      "expectedRevision": "sha256:<inspected-revision>",
      "idempotencyKey": "unique-retry-key",
      "actor": { "id": "agent:local", "name": "Local assistant" }
    }
  ]
}
```

The CLI executes at most 50 requests sequentially in one service process,
stops at the first failure, closes the execution host, and never persists
trust.

## Update or remove generated integration

Preview updates and removals before applying:

```sh
draftmatter ai update all --project-root .
draftmatter ai update all --project-root . --apply
draftmatter ai remove all --project-root .
draftmatter ai remove all --project-root . --apply
```

DraftMatter changes only its marked blocks, exact MCP property, and unchanged
generated files. A locally modified generated file produces a conflict and
prevents the multi-file transaction. Removing client integration does not
remove manuscripts, results, references, audit records, or the optional Codex
plugin.

## Troubleshooting

- **`draftmatter` is not on PATH:** install the CLI or add its package binary
  directory. Packaged execution also needs the platform
  `draftmatter-agent-host` executable on PATH or in
  `DRAFTMATTER_AGENT_HOST`.
- **Client does not list tools:** verify the project is trusted by that client,
  restart the client after configuration, and run the doctor.
- **Execution is blocked:** grant DraftMatter project trust for the current
  session and approve the execution tool call. Do not edit trust files.
- **Kernel missing:** use DraftMatter's Execution environments panel to set up
  or select a project Python, R, or Julia Jupyter kernel.
- **Reference provider unavailable:** continue with saved project records or
  retry the explicitly approved provider later. Do not invent a record.
- **Stale revision:** inspect again and re-express the semantic operation
  against the returned current revision.
- **Generated-file conflict:** keep the local edit, compare it with the
  canonical skill, then resolve it deliberately before rerunning update or
  removal.

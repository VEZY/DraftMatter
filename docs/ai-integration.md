# AI integration, on your terms

DraftMatter works without AI. When AI is useful, it connects local assistants
to DraftMatter without giving a model responsibility for managed Markdown,
generated IDs, output paths, citation records, or project security.

Setup has two independent scopes:

| Scope | Frequency | What it changes |
| --- | --- | --- |
| **Connect an AI assistant** | Once per computer and client | Lets Codex, Claude Code, GitHub Copilot, or Mistral Vibe use DraftMatter's bundled authoring tools |
| **Allow assistant access** | Once per project | Lets a connected assistant work with that project through DraftMatter |

Neither operation contacts a model, runs manuscript code, grants project
execution trust, enables Zotero/Crossref network access, or pre-approves future
tool calls.

## 1. Connect assistants on this computer

Open **Home → Connect AI assistants** or **Settings → Connect AI assistants**.
This area works without an open project. For each supported client it reports:

- whether the client executable was detected;
- whether DraftMatter's MCP registration and canonical skill are installed and
  current;
- whether the registration uses the Codex plugin or the client's user
  configuration;
- the exact files and configuration entries an action would change.

**Connect**, **Update connection**, and **Reconnect** apply in one action.
**Disconnect** keeps a confirmation step. Implementation details stay collapsed
unless the user opens them. DraftMatter changes only its named entry or managed
files and preserves unrelated client configuration. The MCP executable and
execution host are sidecars in the DraftMatter application bundle; there is no
separate MCP installation. If the assistant was already running, the dialog asks
the user to reopen it once so the new tool list is refreshed.

Client registrations are user/device-wide:

| Client | Preferred registration |
| --- | --- |
| Codex | DraftMatter Codex plugin when the installed unified client exposes plugin management; otherwise `~/.codex/config.toml` plus `~/.codex/skills/draftmatter-authoring/` |
| Claude Code | `~/.claude.json` plus `~/.claude/skills/draftmatter-authoring/` |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` plus `~/.copilot/skills/draftmatter-authoring/` |
| Mistral Vibe Code | `~/.vibe/config.toml` plus `~/.vibe/skills/draftmatter-authoring/` |

These locations follow the clients' user-level discovery models. See the
official [Anthropic MCP documentation](https://docs.anthropic.com/en/docs/mcp),
[GitHub Copilot CLI configuration reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference),
and [Mistral Vibe skill documentation](https://docs.mistral.ai/vibe/code/cli/skills).

The advanced CLI fallback has the same preview/apply model:

```sh
draftmatter assistants status all --json
draftmatter assistants install codex
draftmatter assistants install codex --apply
draftmatter assistants update all
draftmatter assistants repair claude --apply
draftmatter assistants remove vibe
draftmatter assistants remove vibe --apply
```

Installing a connection records managed-file revisions but stores no client
credential, model token, project approval, or tool-approval decision. Repair is
explicit when a DraftMatter-owned path was edited outside DraftMatter.

## 2. Enable AI for one project

Choose **Allow assistant access** during project creation, from the
**Project** menu, or in the project's AI status dialog. DraftMatter also offers
this action after opening a project when at least one assistant is connected
but that project has not been enabled.

Project enablement changes only project-wide files:

- a managed DraftMatter block merged into `AGENTS.md`;
- a small `CLAUDE.md` forwarding block where useful;
- `.draftmatter/ai-integration.json` with schema version `2`;
- optionally, `.agents/skills/draftmatter-authoring/` as a portable fallback.

The manifest points to the globally installed canonical skill and records that
the project is enabled. Supported clients need no project-local MCP
configuration. Legacy schema-1 project adapters are removed only when an old
DraftMatter manifest proves ownership; unrelated or unowned files are
preserved.

CLI fallback:

```sh
draftmatter ai enable --project-root .
draftmatter ai enable --project-root . --apply
draftmatter ai doctor --json --project-root .
draftmatter ai update --project-root .
draftmatter ai update --project-root . --apply
draftmatter ai disable --project-root .
draftmatter ai disable --project-root . --apply
```

Disabling project AI removes only unchanged DraftMatter-managed pointers,
fallback files, and the enablement marker. It does not touch manuscripts,
references, retained outputs, idempotency data, audit data, or review history,
and it does not disconnect any assistant on the computer.

## Root binding and fail-closed startup

A globally registered MCP process resolves one project when it starts:

1. use the client's working directory by default, or an explicit startup root
   for a compatible adapter;
2. canonicalize the root and open the DraftMatter project store;
3. require an enabled schema-2 `.draftmatter/ai-integration.json`;
4. pin the canonical path and filesystem identity for the server lifetime.

Tool schemas contain no project-root field. Unknown fields are rejected, so a
later mutation cannot inject or switch to another root. Project-store path
checks reject absolute paths, traversal, platform prefixes, symlink escapes,
and a project directory replaced after startup. A client that cannot safely
preserve this startup working directory must use an explicitly explained
project-scoped adapter instead of the global registration.

The stdio command normally needs no project argument:

```sh
cd /path/to/enabled-project
draftmatter mcp --stdio
```

`--project-root` remains an advanced startup-only compatibility option. It is
never accepted in a tool call.

## Four separate security states

DraftMatter never collapses these into one “Ready” flag:

| State | Meaning |
| --- | --- |
| **Assistant connected to DraftMatter** | This client can discover the bundled MCP server and canonical skill on this computer |
| **AI enabled for this project** | The pinned MCP may expose DraftMatter tools for this project |
| **Project trusted for code execution** | The current DraftMatter session may run project code with the user's permissions |
| **Network approved for this request** | This specific Zotero/Crossref acquisition may contact an external source |

Execution requires both session-only DraftMatter project trust and the
assistant client's tool approval. Network-backed reference acquisition
requires an explicit request-scoped approval. Connecting or enabling never
changes either state.

## Normal authoring loop

The canonical `draftmatter-authoring` skill tells an assistant to:

1. inspect the project and current revision;
2. inspect the semantic target and diagnostics;
3. preview a non-trivial mutation;
4. submit it with an expected revision, unique idempotency key, and actor;
5. reinspect the result;
6. run and inspect computations only after both execution approvals;
7. validate references, freshness, review state, and publication readiness.

Prose rewrites default to tracked suggestions. Creation requests omit
caller-selected IDs, labels, and filenames. DraftMatter generates those values
and binds artifact paths through `DRAFTMATTER_OUTPUT_PATH` and
`DRAFTMATTER_OUTPUT_PATHS`. Citation acquisition returns short-lived
`citation-candidate:` references; an assistant selects a returned candidate
instead of fabricating metadata.

If MCP is unavailable, the project-gated JSON API exposes the same semantic
protocol:

```sh
draftmatter agent schema
draftmatter agent --request request.json --project-root .
draftmatter agent --request - --project-root .
```

Direct editing of managed review markup, computation fences, retained-output
blocks, citation locks, or generated IDs is not a fallback.

## Troubleshooting

- **Assistant is detected but disconnected:** review **Update**. If a managed
  entry was changed externally, review **Repair**.
- **Assistant is connected but tools are absent:** verify the client started in
  the enabled project directory and restart it after connection changes.
- **MCP rejects the project:** enable it in DraftMatter and check the schema-2
  manifest with `draftmatter ai doctor --json`.
- **Execution is blocked:** grant DraftMatter session trust and approve the
  execution-capable client tool call separately.
- **Reference search is blocked:** approve only the current Zotero/Crossref
  request, or continue with local saved records.
- **Generated-file conflict:** keep the local edit, compare it with the
  canonical skill, and use Repair only after reviewing the replacement.

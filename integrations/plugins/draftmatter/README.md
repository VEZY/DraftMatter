# DraftMatter Codex plugin

This convenience package exposes the provider-neutral
`draftmatter-authoring` skill and starts the same local DraftMatter MCP server
used by Claude Code, GitHub Copilot, Mistral Vibe, and generic MCP clients. It
does not implement Codex-specific manuscript behavior.

## Requirements

- Install the DraftMatter CLI and execution host so `draftmatter` is on the
  local executable path.
- Open a DraftMatter project and review its project instructions.
- Approve project execution or network-backed reference acquisition only when
  the current operation needs it.

## Personal marketplace

The repository includes `integrations/.agents/plugins/marketplace.json`. Add
the `integrations` directory as a personal marketplace in the unified
ChatGPT/Codex desktop host, select **DraftMatter**, and review the skill and MCP
command before enabling it.

For development validation:

```sh
npm run agent:sync
npm run validate:agent-skill
npm run test:mcp
```

Removing this plugin removes only the Codex package. It does not remove
project-level `AGENTS.md`, client adapters, manuscripts, references, generated
figures, or DraftMatter audit records. Use `draftmatter ai remove codex
--project-root <project> --apply` when the project adapter itself should also be
removed.

The plugin is the recommended MCP registration path for the unified Codex
desktop host. Codex project-local `.codex/config.toml` MCP discovery has varied
between host releases; the project adapter remains useful for compatible CLI
releases and as an inspectable configuration declaration, while the skill and
`AGENTS.md` do not depend on that behavior.

# DraftMatter Codex plugin

This convenience package exposes the provider-neutral
`draftmatter-authoring` skill and the MCP server bundled with the DraftMatter
desktop application. It does not implement Codex-specific manuscript behavior.

## Install from DraftMatter

Open **Home → Connect AI assistants**, select **Codex**, review the proposed
device-wide changes, and choose **Install**. On unified Codex versions that
support local plugins, DraftMatter installs this plugin through the personal
marketplace. Older Codex clients receive equivalent user-wide MCP and skill
registration.

No separate MCP executable is required. The installer rewrites the packaged
MCP command to the absolute bundled sidecar path while preserving unrelated
Codex configuration.

## Enable a project separately

Connecting Codex does not grant access to any manuscript. Open a DraftMatter
project and choose **Enable AI for this project**. That operation adds managed
instruction pointers, a schema-2 enablement manifest, and—when selected—a
portable skill fallback. It does not add a project-local MCP adapter when the
Codex plugin/global registration can safely bind from the working directory.

The MCP rejects unenabled projects and pins the canonical project root at
startup. Code execution still needs DraftMatter project trust plus Codex tool
approval. Zotero/Crossref access remains request-scoped.

Removing this plugin changes only the Codex device-wide connection. It does not
disable AI in projects or remove manuscripts, references, outputs, or review
history. Project enablement is reversed separately from DraftMatter.

For development validation:

```sh
npm run agent:sync
npm run validate:agent-skill
npm run test:mcp
```

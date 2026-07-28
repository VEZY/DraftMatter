# DraftMatter agent protocol

Use protocol `1.0`. A globally registered MCP server resolves one project from
the client working directory by default, or from an explicit root supplied only
at process startup. It accepts the project only when the versioned schema-2
`.draftmatter/ai-integration.json` manifest says AI is enabled, then
canonicalizes and pins the directory identity.

No MCP tool accepts `projectRoot`. Attempts to inject a different root into a
later inspection or mutation fail schema validation. Traversal, symlink
escapes, and moved or replaced roots fail closed.

The structured JSON CLI is an advanced fallback and includes `projectRoot` (or
uses `--project-root`) at startup alongside `protocolVersion`, `domain`, and
`action`. It applies the same project-enablement check.

## Domains and actions

| Tool/domain | Actions |
| --- | --- |
| `project` | `inspect`, `capabilities`, `trust-status`, `trust`, `untrust` |
| `manuscript` | `inspect`, `read`, `mutate` |
| `computation` | `inspect`, `create`, `update`, `move`, `remove`, `run`, `clean-run`, `status`, `logs`, `artifact`, `interrupt`, `restart`, `terminate` |
| `references` | `search`, `candidate`, `add`, `cite`, `add-and-cite`, `validate` |
| `review` | `inspect`, `suggest`, `decide`, `rebase` |
| `validate` | `project`, `references`, `freshness`, `reviews`, `publication` |

## Mutation guard

Every mutation includes:

```json
{
  "mode": "preview",
  "expectedRevision": "sha256:<returned revision>",
  "idempotencyKey": "task-specific-retry-key",
  "actor": {
    "id": "agent:local-assistant",
    "name": "Local assistant",
    "provider": "client name",
    "model": "model name"
  }
}
```

Use `preview`, then `suggest` for prose or `apply` for an explicitly approved
direct/structural mutation. Reuse an idempotency key only to retry the identical
request.

Successful non-preview mutation results survive process restart. DraftMatter
retains the last 500 idempotency records and the last 1,000 compact audit
entries inside `.draftmatter/`. Audit entries do not contain prompts, request
bodies, hidden reasoning, credentials, or runtime logs.

## Selectors

Prefer returned opaque references. Otherwise use:

```json
{"kind":"section-label","label":"sec-results"}
{"kind":"heading","text":"Results","occurrence":1}
{"kind":"paragraph","section":{"kind":"section-label","label":"sec-results"},"ordinal":2}
{"kind":"quote","quote":"selected text","prefix":"before ","suffix":" after"}
{"kind":"document-boundary","edge":"end"}
```

Occurrences and ordinals are one-based. Resolve ambiguity before writing.

## Result handling

- `stale-revision`: reinspect and rebase semantic intent.
- `ambiguous-selector`: add context or use a returned reference.
- `project-not-trusted`: obtain explicit approval/trust; do not bypass.
- `candidate-expired`: repeat authoritative search.
- `execution`: inspect logs/error and repair the computation.
- `integration`: run the doctor and stop if the capability is genuinely absent.
- `cancelled`: report cancellation; do not claim completion.

Execution `run` and `clean-run` are guarded mutations because they may retain
outputs. Include `expectedRevision`, `idempotencyKey`, and `actor`; optionally
set `timeoutMs` from 1 to 86,400,000. MCP progress moves from queued through
per-cell running/completed notifications. Successful runs atomically retain
manuscript output and schema-2 execution manifests. Reconnect preserves
freshness, provenance, and artifact discovery, but not volatile stdout/stderr.

For generated artifacts, DraftMatter injects project-confined
`DRAFTMATTER_OUTPUT_PATH` and `DRAFTMATTER_OUTPUT_PATHS` variables into Python,
R, and Julia execution. Code writes to those bindings and never invents the
filename.

CLI exit codes: success `0`, validation `2`, conflict `3`, permission `4`,
execution `5`, cancellation `6`, invalid request `64`, internal failure `70`.

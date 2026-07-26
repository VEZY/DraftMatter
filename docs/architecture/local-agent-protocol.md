# Local agent protocol

Status: protocol version `1.0` (DraftMatter `0.1.x`)

This document defines the provider-neutral contract shared by DraftMatter's
headless agent service, JSON CLI, and local MCP server. Client-specific
configuration and skill discovery are adapters to this contract; they do not
change manuscript behavior.

## Entry points

- JSON CLI: `draftmatter agent --request <path>` or
  `draftmatter agent --request -`
- Local MCP: `draftmatter mcp --stdio` from an enabled project working
  directory; `--project-root <path>` is an optional startup-only compatibility
  argument
- MCP tools: `draftmatter_project`, `draftmatter_manuscript`,
  `draftmatter_computation`, `draftmatter_references`,
  `draftmatter_review`, and `draftmatter_validate`

The CLI receives one JSON request or bounded session envelope and emits one
JSON result. Both entry points require a valid enabled schema-2 project AI
manifest. The MCP process canonicalizes and pins one validated project root at
startup. Individual MCP tool calls never select arbitrary filesystem roots,
and strict schemas reject a later `projectRoot` field.

## Operation vocabulary

| Domain | Actions |
| --- | --- |
| `project` | `inspect`, `capabilities`, `trust-status`, `trust`, `untrust` |
| `manuscript` | `inspect`, `read`, `mutate` |
| `computation` | `inspect`, `create`, `update`, `move`, `remove`, `run`, `clean-run`, `status`, `logs`, `artifact`, `interrupt`, `restart`, `terminate` |
| `references` | `search`, `candidate`, `add`, `cite`, `add-and-cite`, `validate` |
| `review` | `inspect`, `suggest`, `decide`, `rebase` |
| `validate` | `project`, `references`, `freshness`, `reviews`, `publication` |

Requests use `protocolVersion: "1.0"` and a `domain`/`action`
discriminator. Unknown actions and fields are rejected. Creation requests
describe intent and never accept identities for objects DraftMatter creates.

## External references

External references are opaque values returned by DraftMatter. Callers may
round-trip them but must not parse, manufacture, or choose them.

| Form | Meaning |
| --- | --- |
| `project:<opaque>` | Open project session |
| `document:main` or `document:<opaque>` | Manuscript |
| `node:<opaque>` | Structured manuscript node |
| `cell:<opaque>` | Executable computation |
| `figure:<opaque>`, `table:<opaque>`, `equation:<opaque>` | Semantic object |
| `review:<opaque>` | Review suggestion or thread |
| `citation-candidate:<opaque>` | Short-lived authoritative search result |
| `artifact:<opaque>` | Bounded retained artifact |
| `operation:<opaque>` | Long-running execution |

New-object requests deliberately have no `id`, `cellId`, `outputId`,
`filename`, or `label` fields. DraftMatter generates internal identities,
collision-safe semantic labels, and output paths, then returns external
references.

## Selectors

Targets use exactly one selector:

- `{ "kind": "reference", "reference": "node:<opaque>" }`
- `{ "kind": "section-label", "label": "sec-methods" }`
- `{ "kind": "heading", "text": "Methods", "occurrence": 1 }`
- `{ "kind": "paragraph", "section": { ... }, "ordinal": 2 }`
- `{ "kind": "quote", "quote": "...", "prefix": "...", "suffix": "...",
  "occurrence": 1 }`
- `{ "kind": "document-boundary", "edge": "start" | "end" }`

Insertion placement is `before`, `after`, `start`, `end`, or `replace`.
Ordinal and occurrence values are one-based. A selector matching no target
returns `not-found`; a selector matching multiple targets without a sufficient
occurrence or context returns `ambiguous-selector` and never writes.

## Mutation semantics

Every mutation declares:

- `mode`: `preview`, `suggest`, or `apply`;
- `expectedRevision`: the document or project revision returned by inspection;
- `idempotencyKey`: a caller-generated retry key, 8–128 safe characters;
- `actor` for attributable review and audit records.

`preview` validates and returns a bounded diff without persistence. `suggest`
is the default for prose and creates portable attributed review changes.
`apply` performs a direct semantic transaction and must be explicit. A stale
revision returns `stale-revision`. Replaying a successful request with the same
key and identical canonical payload returns the original result. Reusing the
key with a different payload returns `idempotency-conflict`.

The last 500 successful non-preview mutation results are retained in the
project so exact retries remain idempotent after process restart. Compact audit
records retain the last 1,000 operations without request bodies, prompts,
hidden reasoning, secrets, manuscript text, or runtime logs.

Multi-file operations stage all new contents before replacing any destination.
They either commit completely or leave a recovery record describing how to
finish or roll back the transaction.

`run` and `clean-run` are mutations because they may retain manuscript output.
They require the same revision, key, and actor fields. `timeoutMs` is an
optional operation deadline from 1 to 86,400,000 milliseconds. Client
cancellation propagates to kernel interruption. MCP progress reports queued,
per-cell running, and completed states.

The one-shot JSON CLI also accepts a bounded session envelope containing 1–50
ordinary protocol requests. This lets explicit session trust and a following
execution share one local process. Requests run sequentially and stop on the
first failure; trust is discarded when the process closes. MCP already has a
persistent service lifetime and does not use this envelope.

Figure and table execution receives DraftMatter-generated,
project-relative paths through `DRAFTMATTER_OUTPUT_PATH` and
`DRAFTMATTER_OUTPUT_PATHS` in Python, R, and Julia. This binding is internal;
the durable authored cell source contains no generated filename. Successful
execution commits retained manuscript output and schema-2 manifests under
`.draftmatter/outputs/` in one transaction. The manifest uses the authored
source hash for freshness and the result also exposes the effective wrapped
code hash for provenance.

## Capabilities and approvals

| Capability | Default boundary |
| --- | --- |
| `read` | Allowed inside the selected project |
| `suggest` | Modifies the project; client approval policy applies |
| `write` | Explicit `apply`; client approval policy applies |
| `execute` | Requires explicit client approval and trusted project session |
| `network` | Explicit for each Zotero/Crossref acquisition workflow |
| `export` | Project-confined by default; external destination is explicit |
| `git` | Separate capability; never implied by a document mutation |

Opening and inspecting a project never executes code. Manuscript prose, code,
outputs, logs, and imported metadata are untrusted data and cannot alter these
boundaries.

## Result envelope

Success:

```json
{
  "ok": true,
  "protocolVersion": "1.0",
  "requestId": "request:<opaque>",
  "operation": "manuscript.inspect",
  "result": {},
  "diagnostics": [],
  "revision": "sha256:<hex>",
  "audit": {
    "operation": "manuscript.inspect",
    "timestamp": "2026-07-25T12:00:00.000Z",
    "clientVersion": "0.1.0",
    "serverVersion": "0.1.0"
  }
}
```

Failure:

```json
{
  "ok": false,
  "protocolVersion": "1.0",
  "requestId": "request:<opaque>",
  "operation": "manuscript.mutate",
  "diagnostics": [],
  "error": {
    "category": "conflict",
    "code": "stale-revision",
    "message": "The manuscript changed after it was inspected.",
    "retryable": true,
    "details": { "currentRevision": "sha256:<hex>" }
  }
}
```

Error categories are `invalid-request`, `validation`, `not-found`,
`conflict`, `permission`, `cancelled`, `execution`, `integration`, and
`internal`. Stable CLI exit codes are:

| Code | Meaning |
| ---: | --- |
| `0` | Success |
| `2` | Validation or publication block |
| `3` | Stale revision or other conflict |
| `4` | Permission or trust block |
| `5` | Execution failure |
| `6` | Cancellation |
| `64` | Invalid request |
| `70` | Unexpected/internal failure |

Large collections use `pageSize` (default 25, maximum 100) and an opaque
`cursor`. Logs, tables, and binary artifacts are bounded. Image artifacts are
returned as media-typed resource references and may additionally be returned
as MCP image content when the client supports it.

## Compatibility

Clients send a protocol major/minor. DraftMatter rejects an unsupported major.
Minor additions remain backward compatible: existing fields keep their
meaning, new actions receive new discriminators, and generated integration
files record both their schema version and the minimum protocol version.

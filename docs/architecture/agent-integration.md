# Local agent integration architecture

Status: project enablement schema `2`, connection receipt schema `1`, agent
protocol `1.0`, DraftMatter `0.1.x`.

The local agent integration has one provider-neutral domain implementation:

```text
Client instructions → canonical skill → MCP stdio tools
                                      ↘ JSON CLI fallback
                                         ↓
                              headless agent service
                                         ↓
             parser/schema · project transactions · execution host
```

Provider adapters configure discovery only. They do not implement manuscript
behavior. Assistant connection and project enablement are separate:

```text
Device/client scope                         Project scope
DraftMatter app sidecars                    AGENTS.md / CLAUDE.md pointers
        ↓                                   schema-2 enabled manifest
user MCP + canonical skill registration             ↓
        └──────── assistant starts in project ───────┘
                              ↓
                  canonical, pinned MCP root
```

## Boundaries

- `src/agentProtocol.ts` defines the operation vocabulary, capabilities, result
  envelope, external references, and exit codes.
- `src/agentRequestValidation.ts` rejects unknown, malformed, oversized, and
  caller-owned generated-identity fields.
- `src/agentService.ts` composes semantic manuscript, review, computation,
  citation, validation, persistent idempotency, and audit operations.
- `src/agentProjectStore.ts` confines paths and commits expected-revision
  multi-file transactions with journals and rollback.
- `src/agentExecutionHost.ts` owns a long-lived, line-delimited JSON connection
  to the Rust execution host. Kernel sessions live for one service/MCP process.
- `src/agentMcpServer.ts` verifies project enablement, then maps six strict SDK
  tools and bounded resources to the service. It contains no provider-specific
  document behavior.
- `src/agentCli.ts` exposes one-request JSON operation and schema reporting.
- `src/assistantIntegration.ts` previews, merges, updates, repairs, and removes
  user/device-wide client discovery without an open project.
- `src/agentIntegration.ts` previews, enables, updates, diagnoses, and disables
  project instruction pointers, portable fallback, and the schema-2 marker.
- `src/agentProjectEnablement.ts` owns manifest validation and the fail-closed
  project gate shared by MCP and JSON CLI entry points.
- `src-tauri/src/assistant_connections.rs` locates the application-bundled MCP
  sidecar and invokes its connection installer outside project state.
- `integrations/skills/draftmatter-authoring/` is the canonical skill source.

The desktop project-creation implementation embeds the same canonical skill
files at compile time and creates the same managed instruction block and
manifest. It intentionally does not configure clients. Conversely, connecting
an assistant never creates or edits a project.

## Sessions and roots

The CLI opens one enabled project for one request. An MCP process resolves the
project from its working directory by default or from an explicit startup-only
root. Before advertising tools, it canonicalizes the directory, requires a
valid enabled schema-2 `.draftmatter/ai-integration.json`, and pins the root's
canonical path and filesystem identity.

Project roots are absent from all tool schemas. Strict validation rejects
later root injection. The project store rejects traversal, absolute paths,
platform prefixes, symlink escapes, and a root whose directory identity changes
after startup. A future transport may resolve the same startup value from an
MCP initialization-roots handshake; tool calls will remain root-free.

Execution sessions are persistent only for the MCP/server lifetime. Reconnect
creates a new session. Durable execution manifests and retained outputs allow
freshness, provenance, and artifact inspection after reconnect without
pretending that volatile stdout/stderr survived.

## Identity and targeting

Agents address returned opaque references or semantic selectors. Creation
schemas omit generated identity fields. DraftMatter generates cell IDs, node
IDs, review IDs, labels, artifact paths, citation keys, and lock records.

Selectors resolve against the inspected revision. Zero matches return
`not-found`; multiple matches return `ambiguous-selector`. Mutations never
guess.

## Mutation and transaction model

Every non-preview mutation uses:

- an exact expected revision;
- an 8–128 character idempotency key;
- an actor record;
- `suggest` or `apply` intent where relevant.

The service serializes in-process mutations. The project store stages all text
writes, fsyncs staged data, writes a transaction journal, replaces targets, and
rolls back from backups on failure. A rollback failure leaves a
`recovery-required` journal under `.draftmatter/transactions/`.

Successful idempotent results are retained in
`.draftmatter/agent-idempotency.json` (last 500 records). Replaying an
identical request returns the exact stored result after process restart.
Conflicting key reuse fails. Compact audit entries are retained in
`.draftmatter/agent-audit.jsonl` (last 1,000 records).

The semantic file transaction and the subsequent idempotency/audit transaction
are individually atomic. A process crash in the narrow interval between them
can leave a completed semantic change without its retry record. The expected
revision still prevents an automatic duplicate; the caller must inspect and
choose a new operation rather than replay blindly. A future schema may combine
these journals.

## Execution and output persistence

The Rust host discovers Jupyter kernels and executes Python, R, and Julia in
the project working directory. Trust is session-only and cannot be granted by
project files.

For figure/table cells, DraftMatter injects an internal prelude that binds the
generated project-relative artifact path as
`DRAFTMATTER_OUTPUT_PATH`/`DRAFTMATTER_OUTPUT_PATHS`. The submitted manuscript
source remains unchanged; execution provenance exposes the effective wrapped
code hash while the durable manifest's `codeHash` tracks the authored source
for freshness.

On a successful run, retained manuscript output and schema-2 execution
manifests under `.draftmatter/outputs/<cell>/manifest.json` are committed in
one project transaction. Manifests contain authored-code, input, environment,
result, artifact, session, and timing provenance. Artifact bytes are verified
against their size and SHA-256 fingerprint when freshness is inspected.

MCP progress reports queued, per-cell running, and completed states.
Cancellation interrupts the kernel. `timeoutMs` creates a bounded operation
deadline and returns `execution-timeout`; client cancellation returns
`execution-interrupted`.

## References

Project records are read locally. Zotero and Crossref require an
`allowNetwork: true` request. Search results are short-lived
`citation-candidate:` references with source and retrieval time.

Add/add-and-cite revalidates the candidate, deduplicates by source identity or
DOI, chooses a collision-safe citekey, and atomically updates the CSL JSON
bibliography, manuscript bibliography declaration, citation lock, cited-record
cache, and project configuration as needed.

## Compatibility

Protocol compatibility follows semantic-version-like rules:

- a different major protocol is rejected;
- compatible minor releases may add optional result fields, resources, or new
  action discriminators without changing existing meanings;
- device registration changes require a previewed
  `draftmatter assistants update|repair`;
- project enablement schema changes require an explicit previewed
  `draftmatter ai update`;
- the plugin, generated manifest, doctor, CLI schema result, and server all
  report versions used for diagnosis;
- an unsupported newer generated schema fails closed and preserves its files.

Protocol `1.x` is supported throughout DraftMatter `0.1.x`. Removal support is
maintained for every integration schema shipped in the current minor release.
A future incompatible major must retain migration documentation and one
release cycle of actionable mismatch diagnostics before old support is
removed.

The detailed wire contract is in
[local-agent-protocol.md](./local-agent-protocol.md).

## Performance budgets

`npm run test:agent-performance` enforces generous cold/local ceilings suitable
for shared CI:

| Operation | Budget |
| --- | ---: |
| stdio process startup, MCP initialization, and six-tool discovery | 5,000 ms |
| project inspection | 1,000 ms |
| targeted semantic read | 750 ms |
| mutation preview | 1,000 ms |
| retained image artifact inspection | 1,000 ms |

The fixture is local and deterministic. It includes a durable execution
manifest and retained SVG, and performs no kernel startup or network access.
Measurements are emitted as JSON for release evidence.

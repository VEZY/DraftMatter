# Local agent integration security

## Threat model

The local agent is an untrusted caller operating with the user's filesystem
and process permissions. Project instructions, skills, manuscripts, imported
references, code, logs, and rich output can all contain prompt injection. MCP
tool descriptions are guidance, not a sandbox.

DraftMatter therefore enforces safety in code:

- one enabled schema-2 project is required before tools are advertised;
- one canonical project root and directory identity are pinned before tool use;
- later project-root injection and root replacement are rejected;
- relative paths reject absolute paths, prefixes, `..`, and symlink escapes;
- writes verify the nearest existing parent's real path;
- strict request schemas reject unknown fields and caller-selected generated
  identities;
- every write uses expected revisions and idempotency;
- multi-file writes use a staged journal and rollback;
- execution needs session-only project trust and client approval;
- network reference search needs an explicit flag;
- output and request sizes are bounded;
- all model-visible text and runtime output is treated as data, never policy.

The execution host is not an OS sandbox. Trusted project code runs with the
user's permissions and can access resources available to that account.
DraftMatter's trust warning and client approval must say this plainly.

## Prompt-injection handling

The server never interprets manuscript or output text as a new tool policy.
Content cannot change the bound root, grant trust, authorize network access,
alter safety annotations, or select generated IDs. Agents are instructed to
ignore embedded requests to bypass the protocol, but correctness does not rely
on compliance with that instruction.

Reference metadata is authoritative only when it is already saved in the
project or returned by the local Zotero/Crossref acquisition path. Model text
cannot become a reference record through the add operation.

## Secrets and privacy

Generated project instructions contain no credentials, tokens, absolute
developer-machine paths, environment dumps, or hidden model reasoning.
Device-wide registrations necessarily contain the absolute path to the MCP
sidecar bundled with that installed DraftMatter application. Connection
receipts record managed revisions and that launch path, but never client
credentials, model tokens, project enablement, execution trust, network
approval, or saved tool approvals.

Removal is scoped independently: disconnecting a client does not alter a
project, and disabling a project does not alter any user-level client
configuration.

The compact audit stores operation name, timestamp, versions, optional actor,
input/output revisions, affected opaque references, request hash, idempotency
key, request ID, and outcome. It does not store the request body, prompt,
rationale, chain-of-thought, credentials, stdout/stderr, or manuscript text.
Audit retention is the last 1,000 JSON Lines records.

Persistent idempotency retains the last 500 exact successful results so a
restart-safe retry can return the same response. Results may contain bounded
local manuscript snippets or execution metadata and therefore remain private
project data. Both files are removed only through an explicit project-data
decision, not when a client adapter or plugin is removed.

## Dependency exception

DraftMatter pins `@modelcontextprotocol/sdk` and uses only its stdio client,
stdio server, in-memory transport, and schema support. The SDK currently
depends on Hono components also used by its optional HTTP transport. DraftMatter
does not instantiate or expose the SDK's HTTP server and opens no MCP listening
port.

Any npm audit advisory in that unused optional HTTP path is a scoped,
temporary release exception only when all of these remain true:

1. the advisory is not reachable from DraftMatter's imported stdio paths;
2. `npm audit` severity is below high;
3. the pinned SDK is the latest compatible maintained release;
4. protocol, dependency, and stdio end-to-end tests pass;
5. the exception and affected versions are reviewed at every release.

A high/critical advisory, a reachable stdio issue, or introduction of an HTTP
MCP transport blocks release.

## Verification

Security coverage includes path traversal and symlink escape tests, stale
revision conflicts, malformed/oversized persistent state, conflicting
idempotency keys, interrupted and timed-out kernels, transaction rollback,
strict unknown-field validation, offline providers, bounded logs/artifacts,
generic MCP reconnect, and installed-client discovery.

Run:

```sh
npm run test:agent-service
npm run test:mcp
npm run test:agent-e2e
npm run test:agent-adapters
npm run test:agent-clients
npm audit
```

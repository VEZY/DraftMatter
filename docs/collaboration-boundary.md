# Collaboration client boundary

DraftMatter's reusable editor/reviewer core is exposed from `src/sharedEditor/index.ts`. The desktop application consumes that same entrypoint for portable document parsing and review markup, while desktop-only adapters stay outside its dependency graph.

## Browser capability contract

The shared surface supports document editing, review, portable import, and clean client-side export. It does not expose local filesystem access, local processes, code execution, Git, or external renderers. Those capabilities are absent imports, not permissions that a browser caller can toggle.

`browserBoundary.test.ts` walks every local import reachable from the shared entrypoint. The build fails if the graph reaches a desktop adapter or references Tauri, filesystem, child-process, network-socket, or generic host-invocation APIs.

The future synchronization transport must depend on this browser-safe surface. Desktop publishing and explicit local checkpoints may call narrow host adapters outside it; receiving a collaboration session must never add a host capability to the browser package.

## Shared state model

`CollaborativeDocument` uses a Yjs text type for the live portable manuscript and keyed Yjs maps for anchors, authors, proposals, threads, and decisions. Anchors use encoded Yjs relative positions so they continue to resolve after concurrent text insertion. Awareness state carries collaborator identity and cursor presence separately from durable updates, so presence is neither checkpointed nor restored as manuscript data.

The transport seam exchanges incremental updates, state vectors, and awareness updates. It has no WebSocket or service dependency, which lets reconnect and offline convergence run in deterministic local tests before an authenticated Hocuspocus transport is attached.

Review decisions are immutable revision-checked records. A decision starts from a Yjs state-vector token; a stale sequential decision is rejected before it is written. If two offline clients decide incompatibly from the same base, both records survive the merge and the derived proposal state becomes `decision-conflict`. Resolving it requires a new decision that names the exact conflicting records and is based on the merged revision. Proposal text or status is never silently chosen by last-writer-wins behavior.

## Workspace authorization seam

The framework-independent workspace service signs short-lived HMAC session tokens only after an upstream identity provider has verified the identity. Its policy layer supports owner, editor, commenter, and viewer roles; one-use expiring guest invitations; immediate membership revocation; per-session rate limits; and an owner-only activity audit. Invitation secrets are stored only as SHA-256 digests and are never written to the audit.

Every project lookup is scoped by workspace membership before the project identifier is resolved. A missing tenant membership, an unknown workspace, and an unknown project all return the same not-found response, preventing project enumeration across tenants. The future WebSocket and HTTP adapters must call `authorizeProject` for the requested capability before loading any collaboration state.

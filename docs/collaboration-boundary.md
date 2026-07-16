# Collaboration client boundary

DraftMatter's reusable editor/reviewer core is exposed from `src/sharedEditor/index.ts`. The desktop application consumes that same entrypoint for portable document parsing and review markup, while desktop-only adapters stay outside its dependency graph.

## Browser capability contract

The shared surface supports document editing, review, portable import, and clean client-side export. It does not expose local filesystem access, local processes, code execution, Git, or external renderers. Those capabilities are absent imports, not permissions that a browser caller can toggle.

`browserBoundary.test.ts` walks every local import reachable from the shared entrypoint. The build fails if the graph reaches a desktop adapter or references Tauri, filesystem, child-process, network-socket, or generic host-invocation APIs.

The Hocuspocus synchronization client depends on this browser-safe surface. Desktop publishing and explicit local checkpoints call narrow host adapters outside it; receiving a collaboration session never adds a host capability to the browser package. Browser execution and environment controls are visibly disabled as an additional product-level guard.

## Shared state model

`CollaborativeDocument` uses a Yjs text type for the live portable manuscript and keyed Yjs maps for anchors, authors, proposals, threads, and decisions. Anchors use encoded Yjs relative positions so they continue to resolve after concurrent text insertion. Awareness state carries collaborator identity and cursor presence separately from durable updates, so presence is neither checkpointed nor restored as manuscript data.

The rendered editor binding uses `y-prosemirror` over the named `draftmatter:prosemirror` Y.XmlFragment, with collaborative undo/redo and awareness cursor plugins. Presence identity and colors are validated before entering awareness state. The binding remains inside the browser-safe package and its two-view test exercises actual ProseMirror transactions on independently offline Yjs documents before convergence.

The underlying transport seam exchanges incremental updates, state vectors, and awareness updates without a service dependency, so reconnect and offline convergence run in deterministic local tests. `HocuspocusCollaborationClient` attaches the authenticated WebSocket provider at the browser boundary and accepts a refreshable, memory-held token provider.

Review decisions are immutable revision-checked records. A decision starts from a Yjs state-vector token; a stale sequential decision is rejected before it is written. If two offline clients decide incompatibly from the same base, both records survive the merge and the derived proposal state becomes `decision-conflict`. Resolving it requires a new decision that names the exact conflicting records and is based on the merged revision. Proposal text or status is never silently chosen by last-writer-wins behavior.

## Workspace authorization seam

The framework-independent policy model and managed PostgreSQL workspace service support owner, editor, commenter, and viewer roles; one-use expiring guest invitations; immediate membership revocation; durable per-session rate limits; and an owner-only activity audit. The managed service validates short-lived OIDC access tokens. Browser sign-in uses Authorization Code + S256 PKCE, strict issuer/state/redirect checks, and memory-only rotating tokens. Invitation secrets are stored server-side only as SHA-256 digests and are never written to the audit.

Browser invitation links carry the one-use secret and collaboration service address only in the URL fragment, so neither value enters the initial HTTP request or referrer. DraftMatter removes that fragment from browser history as soon as it is read. If authentication requires a full-page identity-provider redirect, the invitation is retained in origin-scoped session storage for at most fifteen minutes, consumed once on callback, and removed before it is shown for acceptance. Desktop-only origins fall back to the raw one-use token because they cannot produce a portable browser address.

Every project lookup is scoped by workspace membership before the project identifier is resolved. A missing tenant membership, an unknown workspace, and an unknown project all return the same not-found response, preventing project enumeration across tenants. Both the WebSocket and HTTP adapters call `authorizeProject` for the requested capability before loading collaboration state.

## Owner-controlled portable checkpoints

Checkpoint serialization is a pure client operation. It normalizes line endings, materializes missing Yjs-relative anchors, sorts keyed authors/proposals/threads/decisions, preserves the complete decision audit, and emits DraftMatter Review Markup without calling Git or any desktop host. An unresolved concurrent decision blocks checkpoint creation. Two converged clients produce identical UTF-8 bytes, and reopening those bytes produces the same checkpoint again.

While a live session is active, ordinary desktop autosave is suspended. The owner must press **Checkpoint to project** to write those exact bytes with the normal expected-hash conflict guard; browser owners receive an explicit portable download. Git remains a separate deliberate action. The managed service also exposes owner-named immutable recovery checkpoints with verified identity attribution, independently of the local working tree.

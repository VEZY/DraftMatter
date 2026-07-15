# Collaboration client boundary

DraftMatter's reusable editor/reviewer core is exposed from `src/sharedEditor/index.ts`. The desktop application consumes that same entrypoint for portable document parsing and review markup, while desktop-only adapters stay outside its dependency graph.

## Browser capability contract

The shared surface supports document editing, review, portable import, and clean client-side export. It does not expose local filesystem access, local processes, code execution, Git, or external renderers. Those capabilities are absent imports, not permissions that a browser caller can toggle.

`browserBoundary.test.ts` walks every local import reachable from the shared entrypoint. The build fails if the graph reaches a desktop adapter or references Tauri, filesystem, child-process, network-socket, or generic host-invocation APIs.

The future synchronization transport must depend on this browser-safe surface. Desktop publishing and explicit local checkpoints may call narrow host adapters outside it; receiving a collaboration session must never add a host capability to the browser package.

# First-time assistant authoring dogfood

On 2026-07-28, a first-time-researcher pass copied the complete example,
enabled assistant access, revised prose, inserted one saved citation, and
inspected one retained computation result. The pass used only the public
authoring integration. This record keeps the user-facing fixes concise while
preserving the failures as regression requirements.

## Prioritized findings and regression coverage

| Priority | Observed failure or confusing step | Product outcome | Regression evidence |
| --- | --- | --- | --- |
| P0 | DraftMatter reported assistant tools as available, but an already-running assistant did not show them. | Connecting an assistant is one action. The confirmation says to reopen an already-running assistant once; file and configuration details stay collapsed. | `AssistantConnectionsDialog.test.tsx`; `verify-installed-agent-clients.mjs` |
| P0 | `draftmatter` was not available as a normal command in a development checkout; the only apparent route was `node dist-cli/draftmatter.js`. | `draftmatter` with no arguments opens the installed app, and `draftmatter open [project]` opens a project. Short help shows ordinary commands; integration internals moved to advanced help. | `draftmatterCli.test.ts`; `desktopLaunch.test.ts`; `releasePipeline.test.ts`; `verify-release.mjs` |
| P0 | Adding and citing an existing project reference without a DOI proposed a duplicate key, `chen2025-2`. | Add-and-cite now matches existing records by citekey and normalized bibliographic identity before consulting external sources. | `agentService.test.ts` — project candidate deduplication |
| P1 | The copied complete example initially needed a separate technical AI-enablement step. | The example ships assistant-ready with local-only authoring access. Code and network remain separate, explicit approvals. | `phase7AlphaAuthoringGate.test.ts`; `fixture:check` |
| P1 | A blank saved-reference query was rejected even when the user only wanted to browse the project bibliography. | Blank or omitted project searches list saved references; blank external searches return a plain-language prompt. | `agentService.test.ts` — saved-reference browsing |
| P1 | Topic search did not reliably find the known saved reference; searching an author name did. | Saved-reference search uses the complete normalized bibliographic record, while blank search provides a dependable browse path. | `agentService.test.ts` — saved-reference search and citation insertion |
| P1 | Mutation previews echoed nearly the whole manuscript for a small change. | Previews now return compact semantic summaries with bounded strings and collections. | `agentService.test.ts` — compact semantic previews |
| P1 | Text returned by `manuscript.read` could not be reused as an exact quote selector because managed atoms alter the source representation. | Selected reads return rendered text plus a reusable opaque selector; full reads return bounded semantic locations. | `agentService.test.ts` — inspect/read/quote formatting |
| P1 | Citation insertion produced `query.[@chen2025]`, requiring manual spacing and punctuation repair. | Insertion applies normal spacing and can place a citation before terminal punctuation. | `agentService.test.ts` — semantic citation insertion |
| P1 | Trusting a project and running a computation had to occur in the same assistant session, but that boundary was not clear. | Trust failures now explain that trust is session-scoped and keep approval as an explicit user action. | `agentService.test.ts` — session trust and persistent execution |
| P1 | Saving edited computation source silently waited for optional formatting and its runtime/trust checks. | Save now writes immediately. Format is a separate visible action for Python, R, and Julia. | `ManagedCodeCellEditor.test.tsx`; `StructuredManuscriptEditor.test.tsx` |
| P1 | After reconnecting, computation status and logs were empty even though a durable result existed. | Status is reconstructed from the retained manifest; logs show its retained summary and clearly distinguish unavailable live logs. | `agentService.test.ts` — persistent execution and reconnect inspection |
| P1 | Reference and review validation repeated unrelated computation warnings. | Validation diagnostics are scoped to the requested domain; publication validation intentionally aggregates all blockers. | `agentService.test.ts` — scoped diagnostics |
| P1 | The complete example claimed retained results but all nine computations opened as `never-run`. | The fixture now contains deterministic manifests for all nine cells, including code, input, output, and figure fingerprints. | `phase7AlphaAuthoringGate.test.ts`; `sync-complete-example-manifests.mjs` |
| P1 | Publication validation returned `valid: true` and `ready: false` without explaining the distinction. | The response now names publication blockers and explains readiness independently from request validity. | `agentService.test.ts` — publication readiness explanation |

## Release rule

A change to assistant discovery, citation acquisition or placement, manuscript
selectors, durable computation inspection, fixture freshness, validation
scoping, managed code saving or formatting, or terminal launch must keep the
corresponding regression above green. The complete example remains synthetic:
opening it never runs code, contacts a model, or uses the network without a
separate user approval.

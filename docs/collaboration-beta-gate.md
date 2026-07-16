# Collaboration beta core gate

The automated DM-P6 core gate exercises one owner and one editor from invitation through offline review and recovery:

1. Tenant-scoped signed sessions authorize the owner and invited editor while an outsider receives the same not-found response as an unknown project.
2. Both clients start from the same portable review manuscript, then work offline: one adds an attributed thread while the other adds an overlapping alternative.
3. They make incompatible decisions from the same base revision. Reconnect retains both immutable decisions and surfaces `decision-conflict` rather than selecting a writer.
4. The owner resolves the exact merged conflict with a new revision-checked decision. Authors, proposals, thread messages, and decision audit converge.
5. Both clients emit byte-identical portable checkpoints. No Git action occurs; the owner-controlled local Git checkpoint remains a separate explicit workflow.
6. The resolved Yjs state is snapshotted, backed up, restored into an empty store, and checkpointed to the same Markdown again.
7. Editor membership revocation takes effect immediately, audit events retain no invitation secret, project deletion removes restored state, and restore/deletion metrics remain visible.

The separate loopback Hocuspocus integration test certifies the actual authenticated WebSocket reconnect path. Two editors now create distinct attributed alternatives and manuscript edits while disconnected; reconnect retains both authors, relative anchors, proposals, and text edits, produces byte-identical portable checkpoints on both clients, and reopens the persisted service state to the same checkpoint. Because the test binds an ephemeral localhost port, restricted CI sandboxes must grant loopback bind permission; it performs no external network access.

This gate now extends through the managed PostgreSQL/S3-compatible adapters, OIDC roles and revocation, signed billing entitlements, scheduled verified backups, restore drills, retention/deletion automation, privacy-safe metrics, and a portable service deployment. A paid or broad public launch still requires environment-specific TLS and secret management, operated identity/billing configuration, provider-level database/object backups, alert routing, privacy/data-processing review, external security review, and production load/soak testing.

The product workflow now covers privacy-safe browser guest links, browser PKCE sign-in, verified author identity, authorized workspace/project discovery and creation, invitation acceptance and revocation, workspace roles with per-manuscript overrides, member/activity administration, durable in-app review notifications with optional bounded email delivery, owner-named immutable recovery, a typed-confirmation workspace deletion grace window with cancellation, live presence, and explicit owner-controlled local checkpointing. Guest-link secrets stay in the URL fragment, are removed from browser history on entry, and survive the identity-provider round trip only through bounded one-use session state. Project-role changes are audited, invalidate stale live capabilities, and cancel review assignments that a viewer downgrade would otherwise strand. Email delivery uses a provider-neutral HTTPS template webhook, stable idempotency keys, durable leasing, and bounded retry without sending review text or manuscript content. Live shared changes do not enter the desktop working tree through autosave, and browser execution controls are disabled.

## Current automated evidence

Certification on 2026-07-15 from the locked checkout completed:

- `npm test`: 74 files and 316 tests passed;
- `npm run build`: collaboration service type-check/bundle and browser type-check/bundle passed;
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 51 host tests passed;
- `npm run compliance:check`: 566 locked npm/Cargo components verified for `aarch64-apple-darwin`;
- `docker compose config --quiet`: the portable local service topology validated;
- `npm run desktop:build -- --debug --bundles app`: the native macOS application compiled, bundled, and passed strict code-signature verification.

The CI collaboration workflow independently builds the service image on Linux. Platform distribution signing/notarization, production OIDC/TLS configuration, external security review, and operated load/restore drills remain deployment gates rather than repository implementation gaps.

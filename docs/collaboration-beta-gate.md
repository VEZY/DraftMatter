# Collaboration beta core gate

The automated DM-P6 core gate exercises one owner and one editor from invitation through offline review and recovery:

1. Tenant-scoped signed sessions authorize the owner and invited editor while an outsider receives the same not-found response as an unknown project.
2. Both clients start from the same portable review manuscript, then work offline: one adds an attributed thread while the other adds an overlapping alternative.
3. They make incompatible decisions from the same base revision. Reconnect retains both immutable decisions and surfaces `decision-conflict` rather than selecting a writer.
4. The owner resolves the exact merged conflict with a new revision-checked decision. Authors, proposals, thread messages, and decision audit converge.
5. Both clients emit byte-identical portable checkpoints. No Git action occurs; the owner-controlled local Git checkpoint remains a separate explicit workflow.
6. The resolved Yjs state is snapshotted, backed up, restored into an empty store, and checkpointed to the same Markdown again.
7. Editor membership revocation takes effect immediately, audit events retain no invitation secret, project deletion removes restored state, and restore/deletion metrics remain visible.

The separate loopback Hocuspocus integration test certifies the actual authenticated WebSocket reconnect path. Because it binds an ephemeral localhost port, restricted CI sandboxes must grant loopback bind permission; it performs no external network access.

This gate certifies the open collaboration core and reference operations contract. A managed paid launch still requires deployment-specific PostgreSQL/object-storage adapters, TLS and secret management, identity-provider configuration, billing entitlements, backup schedules, alert routing, privacy/retention review, and production load testing.

# Collaboration operations contract

The server-only reference store in `services/collaboration` defines the persistence behavior required from production PostgreSQL and object-storage adapters. It is deliberately excluded from the browser bundle and is portable across Node-supported operating systems.

## Durability and recovery

- Incremental Yjs updates are written atomically and compacted with `Y.mergeUpdates` after configurable count or byte thresholds.
- Immutable snapshot identifiers cannot be overwritten. Creating a snapshot clears only the update tail that the caller certifies is represented by that snapshot.
- Owner-named recovery checkpoints merge the current persisted Yjs snapshot and update tail into a new immutable snapshot, then record the verified creator and human-readable name.
- Loads verify snapshot SHA-256 integrity before returning the latest snapshot plus ordered later updates.
- The PostgreSQL/S3 adapter creates immutable, hash-linked backup envelopes from a complete merged Yjs state. Verification checks both the object and embedded state digest before a restore can create a new recovery snapshot in an explicitly authorized target project. A successful restore disconnects that target room so its next connection loads the restored state instead of retaining a stale in-memory document.
- Project deletion removes its complete object prefix, including snapshots and backups. Workspace deletion is owner-scheduled with a one-hour to thirty-day grace period, can be cancelled before execution, disconnects live rooms, and removes database plus object state.
- Workspace policies independently bound retained snapshots and backups. Lifecycle cleanup always retains the configured newest set, even when it exceeds the age policy.

The file adapter remains a reference fallback. The managed adapter implements the same contract with transactional PostgreSQL metadata and immutable S3-compatible objects; deployment owners remain responsible for database-level backups, object replication, cross-region copies where required, and regular restore drills.

## Scale-down and cost model

Each persisted write updates `lastActivityAt`; inactive projects can therefore be disconnected from live WebSocket rooms while retaining compact recoverable state. The in-process dashboard records update/snapshot/backup bytes, compactions, verification and restore failures, deletion, and last activity. Public Prometheus output aggregates these counters and deliberately omits tenant, project, user, token, and manuscript labels.

`estimateCollaborationCapacity` keeps unit costs vendor-neutral and explicit. It estimates monthly update volume, retained storage, active service hours, and cost from configured storage, egress, and active-service rates. Before charging users, deployment owners should replace example rates with their contracted prices and validate the model against observed dashboard data.

The scheduled maintenance coordinator creates and verifies backups, applies snapshot/backup retention, delivers queued review-email templates, and executes due deletion requests without overlapping itself. In-app review notifications and their email-delivery row commit in the same PostgreSQL transaction. The provider call uses a stable idempotency key, a fifteen-minute lease, bounded exponential retry, and a generic persisted failure message; it never receives review text or manuscript content. Operational alerts should cover failed integrity checks, restore failures, notification delivery failures/backlog, unusual update size/rate, snapshot lag, backup age, storage growth, authorization denials, and sustained WebSocket saturation. Secrets, invitation tokens, manuscript text, raw Yjs updates, and tenant identifiers must not appear in public metrics or logs. See [the operations runbook](./collaboration-runbook.md).

## Hocuspocus transport

The server adapter accepts only strict `workspace:project` document names and authenticates every connection through the tenant-scoped workspace service before loading state. Viewer connections are protocol-level read-only. Commenters may create attributed threads and append attributed replies; a candidate-update comparison rejects changes to manuscript text, anchors, proposals, decisions, metadata, unknown shared roots, other authors, or existing message history. Editors and owners can submit normal Yjs updates.

Hocuspocus changes append compact update tails to the persistence contract, while debounced stores create immutable full snapshots. Unauthenticated queues, pending documents, and WebSocket payloads have explicit bounds. Every write is reauthorized against current PostgreSQL membership and entitlements; token refresh bounds long-lived read access, and a member revocation disconnects live rooms. Managed deployments must terminate TLS at the service edge.

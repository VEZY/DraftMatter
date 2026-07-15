# Collaboration operations contract

The server-only reference store in `services/collaboration` defines the persistence behavior required from production PostgreSQL and object-storage adapters. It is deliberately excluded from the browser bundle and is portable across Node-supported operating systems.

## Durability and recovery

- Incremental Yjs updates are written atomically and compacted with `Y.mergeUpdates` after configurable count or byte thresholds.
- Immutable snapshot identifiers cannot be overwritten. Creating a snapshot clears only the update tail that the caller certifies is represented by that snapshot.
- Loads verify snapshot SHA-256 integrity before returning the latest snapshot plus ordered later updates.
- Backups contain scoped metadata, update tails, and every retained snapshot. Restore verifies both the envelope and each snapshot, stages the project separately, and never overwrites an existing project.
- Project deletion removes its full scoped directory. Snapshot lifecycle cleanup always retains the configured newest set, even when those snapshots exceed the age policy.

The file adapter is a reference and self-hosting fallback, not a claim that one local filesystem is a highly available cloud database. A managed deployment should implement the same contract with transactional metadata in PostgreSQL, immutable versioned objects, cross-region backups where required, and regular restore drills.

## Scale-down and cost model

Each persisted write updates `lastActivityAt`; inactive projects can therefore be disconnected from live WebSocket rooms while retaining compact recoverable state. The operations dashboard records update/snapshot bytes, compactions, restore success/failure, deletion, and last activity per tenant-scoped project key.

`estimateCollaborationCapacity` keeps unit costs vendor-neutral and explicit. It estimates monthly update volume, retained storage, active service hours, and cost from configured storage, egress, and active-service rates. Before charging users, deployment owners should replace example rates with their contracted prices and validate the model against observed dashboard data.

Operational alerts should cover failed integrity checks, restore failures, unusual update size/rate, snapshot lag, backup age, storage growth, authorization denials, and sustained WebSocket saturation. Secrets, invitation tokens, manuscript text, and raw Yjs updates must not appear in metrics or logs.

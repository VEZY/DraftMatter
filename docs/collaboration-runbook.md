# Collaboration operations runbook

## Service checks

- Page immediately if `/health/live` fails for more than two consecutive probes.
- Treat `/health/ready` failure as a dependency incident: check PostgreSQL connectivity/TLS and the object bucket before restarting the service.
- Alert when `draftmatter_maintenance_backup_failures_total`, `draftmatter_collaboration_backup_verification_failures_total`, `draftmatter_collaboration_restore_failures_total`, or `draftmatter_maintenance_deletion_failures_total` increases.
- Alert when `time() - draftmatter_maintenance_last_successful_backup_timestamp_seconds` exceeds twice `DM_MAINTENANCE_INTERVAL_MS`. A zero timestamp is expected only before the first project backup.
- Track update/snapshot/backup byte rates and active WebSocket connections as aggregate capacity signals. Do not add workspace, project, user, filename, token, or manuscript labels.

Application logs are structured JSON and intentionally bounded. Never log authorization headers, OIDC claims, invitation tokens, webhook bodies/signatures, raw Yjs updates, snapshot/backup bodies, document names, or object keys. Send reverse-proxy access logs through the same redaction policy.

## Backup and restore drill

Run this at least quarterly and after changing PostgreSQL, object storage, encryption, retention, or the service image.

1. As the workspace owner, `POST /api/workspaces/{workspace}/projects/{project}/backups` and retain the returned backup ID in the private incident record.
2. `POST .../backups/{backup}/verify`. Stop if either digest check fails.
3. Create a new empty drill project. Never use the active source project as the drill target.
4. `POST .../backups/{backup}/restore` with `{"targetProjectId":"restore-drill"}`. The service checks owner checkpoint permission on both source and target before creating the recovery snapshot.
   Owners can perform steps 1–4 from **Workspace access & recovery → Managed backups** in the collaboration dialog. The restore action requires an explicit target-project confirmation.
5. The service disconnects the restored target room after the snapshot commits. Reopen the drill project, compare its deterministic portable checkpoint with the expected source checkpoint, then delete the drill workspace/project state according to the normal policy.
6. Separately prove restoration of the PostgreSQL provider backup and the object-store versioned/replicated backup into an isolated environment. The application backup does not replace infrastructure backups.

Record duration, byte counts, hashes, failures, operator, service version, database version, object-store version, and corrective actions. Do not put manuscript content or access tokens in the drill record.

## Deletion and retention

Only an owner can schedule workspace deletion. `DELETE /api/workspaces/{workspace}?delayHours=168` returns the execution time; `POST /api/workspaces/{workspace}/deletion/cancel` cancels a scheduled or failed request. The maintenance coordinator disconnects rooms, removes every project object prefix, and then deletes the workspace row so PostgreSQL cascades memberships, invitations, audit, entitlements, updates, snapshots, backups, and policies.

If deletion fails, the request remains `failed` with a generic bounded message. Investigate object-store permissions/availability, retry only after the cause is fixed, and let the owner cancel if required. Never mark deletion complete while scoped objects remain.

Retention defaults are 20 snapshots for 30 days and 7 backups for 90 days. The newest configured set is always retained. Reduce retention only after privacy, contractual, recovery-point, and infrastructure-backup requirements have been reconciled.

## Security response

For suspected token or invitation compromise, revoke the identity-provider session or workspace member first; live rooms are disconnected and writes are rechecked against PostgreSQL. Rotate the webhook secret if billing signatures may be compromised, and reject replays through the durable provider/event ID table. For storage or database credential compromise, rotate credentials, inspect audit/aggregate signals, verify backups, and follow the provider incident process.

Before a paid or broad public launch, complete external application and infrastructure security review, dependency/container scanning, restore evidence, privacy/data-processing review, abuse-rate validation, load/soak testing, and alert-routing exercises.

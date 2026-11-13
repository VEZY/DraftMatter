# Closed, free alpha: data operations

The public alpha documents identify Rémi Vezy as the operator. The single-VPS
initializer selects `contact@draftmatter.eu`; older unconfigured builds retain
`vezy.remi@gmail.com`. Publish and monitor the actual configured contact. The
pilot is invitation-only and free. Its commitments include handling
eligible requests to remove active data within 30 days, limiting technical backup
copies to 30 days, and giving 30 days' notice before a planned shutdown. This
runbook describes operator work; it does not claim that account erasure or all
infrastructure cleanup is automated.

## Before inviting testers

1. Record the actual VPS, database, identity, object-storage and backup locations
   and providers. Publish those facts in the legal configuration. OVH branding by
   itself does not establish a French data location. Keep the alpha closed until
   the configuration describes the deployed service accurately.
2. Apply all migrations, including `011_alpha_backup_retention.sql`. Confirm that
   the service maintenance process runs at least daily and that backup,
   lifecycle and deletion failures are monitored and addressed. Retention is a
   physical-deletion operation: a stopped service or failing bucket can delay it.
   For the pilot, configure `backup_max_age_days` to **29** or less to leave a day
   for the daily cleanup cycle within the published 30-day ceiling. Migration
   `011` caps the allowed setting at 30; it does not configure provider backups.
3. Configure PostgreSQL provider/dump backups, VPS snapshots, object-storage
   replicas and any offline copies to expire within 30 days. Disable automatic
   renewal/replication that would retain an old backup indefinitely. Do not let
   automated dumps include contact-mailbox exports or unrelated personal data.
4. Prefer a fresh private bucket with object versioning disabled for this small
   pilot. If versioning, object lock, replication or provider disaster-recovery
   copies are enabled, verify their separate deletion and noncurrent-version
   expiry. The application's S3 `DeleteObject` calls do not enumerate or remove
   old version IDs. A bucket delete marker is not evidence of complete erasure.
   Do not apply a blanket 30-day expiry to active project objects: doing that
   would destroy idle manuscripts and shared files.
5. Complete a deletion/restore exercise with a disposable workspace, including
   shared file versions and abandoned multipart sessions. Record metadata and
   verification results privately, without manuscripts, tokens or credentials.
   Use the existing [collaboration runbook](collaboration-runbook.md) for the
   owner-authenticated endpoints and restore procedure.

These read-only database checks help verify a running service. They do not prove
that provider/offline backup copies were deleted:

```sql
SELECT workspace_id, backup_max_age_days
FROM draftmatter_workspace_policies
WHERE backup_max_age_days > 29;

SELECT workspace_id, project_id, id, created_at, state
FROM draftmatter_collaboration_backups
WHERE created_at <= CURRENT_TIMESTAMP - INTERVAL '30 days';

SELECT id, workspace_id, execute_after, status
FROM draftmatter_deletion_requests
WHERE status IN ('failed', 'running')
   OR (status = 'scheduled' AND execute_after <= CURRENT_TIMESTAMP);
```

Investigate every result that indicates an overdue copy or removal. A clean
database alone is insufficient: check the corresponding object inventory and
provider retention settings too. Use an alert before the 30-day deadline, rather
than waiting for an overdue request.

## Receiving an access, export or erasure request

- Record the request date, requested scope, response deadline and private outcome
  record. Use the contact mailbox; ask for project/workspace identifiers instead
  of copies of unpublished papers or datasets. Verify the requester's identity
  through the existing account and permissions, without collecting unnecessary
  identity documents.
- Separate the requester's account/profile from collaboratively authored
  manuscripts, reviews, audit history and files. Leaving a project or removing an
  account does not automatically authorize deleting every coauthor's work. Assess
  applicable rights, legal exceptions and the least destructive response; explain
  any data that must remain and why.
- Before closing access, arrange recovery of the relevant portable manuscript,
  bibliography/assets and shared data file versions. The existing application
  supports portable checkpoints and shared-file download; there is no general
  one-click account-export or account-erasure endpoint.
- For an authorized **whole-workspace deletion**, let its owner use the existing
  authenticated deletion workflow and choose a grace period that leaves enough
  time to complete the 30-day commitment. The default grace period is seven days.
  Maintenance disconnects rooms, purges shared files and multipart uploads,
  removes collaboration object prefixes, then deletes the workspace metadata.
  Check the completion evidence and physical objects; a `failed` request needs
  operator action and is not a completed deletion.
- For a request limited to a file version, the editor/owner can remove the
  relevant version through shared data files. Removing one version does not
  remove other retained versions of that dataset, manuscript references to it,
  or copies already downloaded by collaborators.
- Account erasure is a coordinated operator action: close the identity-provider
  account and sessions; review the application user/profile, invitations,
  membership and notification records; and deal with personal data in shared
  content/history as appropriate. Preserve other people's rights and mandatory
  records. There is no safe blanket `DELETE FROM users` procedure: foreign keys,
  ownership, coauthor attribution and the identity provider must be considered
  together. Prepare and review a scoped plan before applying database changes.
- Include provider backups and the Gmail correspondence in the applicable
  retention follow-up. Keep only the minimal evidence needed to demonstrate the
  response. Never reintroduce erased data when restoring an infrastructure
  backup: reconcile the private deletion record before reopening access.

## Data categories and cleanup boundaries

- The active manuscript, Yjs baseline, user-created recovery checkpoints and
  retained shared-file versions remain project data while the project is active.
  Their existence is not an exception allowing an old **technical backup** to
  remain forever. Named recovery checkpoints reference snapshots and cannot be
  silently expired without changing user-visible recovery history.
- Managed technical backups use a separate object prefix and database table.
  `applyBackupLifecycle` removes copies whose age reaches the configured maximum,
  even if they are among the most recent seven backups.
- Abandoned upload sessions expire after seven days of inactivity through the
  existing maintenance cleanup. A failed cleanup must be retried and monitored.
- Access and service logs are separate from manuscript backups. Bound retention
  at each collector, proxy and provider; rotating by bytes alone is not a fixed
  deletion deadline. Avoid logging content, personal filenames, invitation tokens
  or credentials.

## Planned closure

Notify participants at least 30 days before a planned end of the hosted alpha,
state when writes and access will stop, and explain how to recover manuscripts
and shared files. Treat subsequent active-data and backup deletion as tracked
operator work. An urgent security suspension can be necessary before that
notice period; explain it as soon as practicable and restore export access when
safe. Do not interpret a shutdown notice as permission to erase an unrelated
self-hosted deployment or files on a participant's own computer.

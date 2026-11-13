# Single-host alpha backups and restore

`deploy/single-host/backup/backup.mjs` creates a coherent encrypted backup of the
single-VPS stack. It includes two PostgreSQL custom-format dumps (`draftmatter`
and `keycloak`) and a filesystem archive of SeaweedFS's named volume at `/data`.
It uses Docker administrator access and PostgreSQL's local administrator socket;
it does not need to copy application database passwords or S3 credentials into
the backup command. No environment file, TLS private key, Caddy certificate cache
or host operating-system image is included.

This tooling prepares an operator procedure. Running `create` deliberately pauses
the service; running `restore` creates a separate disposable Docker project.
Neither command is a background action triggered by the application.

## Prerequisites and independent encryption key

Use the repository's Node version, Docker Engine with Compose v2 supporting
`--wait`, and the reviewed single-host Compose configuration. Commands below are
run from the checkout on the VPS. Environment and key files must be regular files
with no group/world permissions; the archive directory must be private and
dedicated to these backups.

Create a separate **raw 32-byte random key**, not a password string or a base64
text file. For example:

```sh
umask 077
openssl rand -out /etc/draftmatter/backup.key 32
install -d -m 700 /var/backups/draftmatter
```

Keep a protected copy of the key outside the VPS and outside application/S3
credentials. Losing this key means losing the backups; storing the only copy
beside the VPS does not protect against host loss. Preserve the reviewed release,
deployment environment and independent secrets through a separate secure process.
They are needed to recreate the stack, but should not be placed in an unencrypted
sidecar beside the archive.

The encryption envelope is versioned, streamed AES-256-GCM with a fresh random
96-bit nonce for each archive and a 128-bit authentication tag. The version/header
is authenticated as additional data. The key is already cryptographically random,
so no password derivation is used. Dumps and object data are streamed directly
into encryption, without staging a plaintext backup on disk. The restore performs
a complete authentication pass before any database/volume mutation, then a second
bounded-memory read to feed the restore tools. This deliberately reads the archive
twice; it does not load the entire backup into memory.

## Creating a backup

```sh
node deploy/single-host/backup/backup.mjs create \
  --env-file /etc/draftmatter/runtime.env \
  --project draftmatter-alpha-20261113 \
  --directory /var/backups/draftmatter \
  --key-file /etc/draftmatter/backup.key
```

The command:

1. Verifies the private input files, selected Compose project and object-storage
   named volume, and acquires a project lock plus a backup-directory lock.
2. Records which of `collaboration`, `keycloak`, and `object-storage` are running,
   then stops those writers cleanly. PostgreSQL stays running. The public proxy
   can return temporary errors during this maintenance window.
3. Checks the archive filesystem's available bytes against the apparent size of
   all object-volume files, twice the combined `pg_database_size` of the two
   databases, and at least **1 GiB additional headroom**. Object file sizes are
   summed from a bounded streaming pipe; arithmetic uses exact integers. If the
   budget does not fit, it writes no archive, resumes the original writers, and
   fails. It never removes an existing backup just to make this operation fit.
   Other host processes can still consume disk space after this preflight.
4. Dumps both databases sequentially while application/identity writes are
   quiesced and reads SeaweedFS's stopped data volume. Do not make administrative
   database changes or restart writers during this operation. SQL dumps alone
   taken at different live instants would not establish this cross-service
   consistency.
5. Uses the already-local PostgreSQL image as an isolated `tar` helper. Its only
   application-data mount is the selected object volume, read-only for backup;
   it has no network, a read-only container filesystem, and only the filesystem
   capabilities needed to read the volume.
6. Atomically publishes the encrypted `.dmbackup` file after writing and syncing
   its authentication tag. An interrupted source dump removes the partial output.
7. Restarts **only the writers that were initially running**, including on a
   failed backup. The command waits for their health and reports a failure if
   resuming them fails. An encrypted archive can exist even if the subsequent
   service restart failed; check the directory and restore service health.

Standard output is one JSON result, for example a `status: "created"` object with
the archive path and creation time. Errors are bounded and do not print raw Docker
diagnostics, environment values, dump bytes or encryption keys. Docker access is
already administrator-equivalent: keep this tooling and its inputs restricted to
the operator.

Do not use `kill -9` as the normal cancellation mechanism. SIGINT/SIGTERM request
an orderly cancellation and writer restart. After a host crash or forced kill,
verify container state and any stale lock before starting a new operation. The
tool never automatically steals a stale lock based on a timer.

## Restoring into an empty isolated project

Prepare a **new private runtime directory and environment**, using the reviewed
single-host configuration and a disposable project name. The independently
preserved deployment configuration can supply matching secrets; the backup
does not include them. Freshly generating an environment does not change
passwords or client settings inside a restored identity database. Plan any
credential rotation explicitly rather than assuming bootstrap settings reset
existing accounts. Never
point a rehearsal at production bind paths, TLS files, hostnames or the production
runtime environment merely because the project name is different. The backup
contains no deployment secrets and does not make those paths safe automatically.

```sh
node deploy/single-host/backup/backup.mjs restore \
  --env-file /etc/draftmatter-restore-check/runtime.env \
  --project draftmatter-restore-check \
  --confirm-empty-target draftmatter-restore-check \
  --archive /var/backups/draftmatter/SELECT_THE_ARCHIVE.dmbackup \
  --key-file /etc/draftmatter/backup.key
```

The target name must start with `draftmatter-restore-`, and the confirmation must
match it exactly. The selected project must match `COMPOSE_PROJECT_NAME` in the
private environment file, `DM_SINGLE_HOST_MODE` must be `rehearsal` or `production`,
and that file must reside inside its own private `DM_SINGLE_HOST_DIR`, outside the
checkout. Exported shell values conflicting with the file are refused. The archive
records its source project/runtime directory; reusing either as a restore target
is refused. A copied environment must therefore be adjusted for the new project
and runtime directory before restoration. Keep the database/identity credentials
consistent with the restored configuration, and preserve its separate TLS/bind
files. The command refuses existing target containers or volumes,
including manually created volumes whose names use the target prefix but lack
Compose labels. It does not stop, overwrite or remove the source stack and never
runs `down --volumes` or a global Docker prune.

After authenticating the archive, restore starts a fresh PostgreSQL service so
the normal initialization creates the two databases and separate roles. It uses
`pg_restore --no-owner --no-acl --role` to assign restored objects to the
application and identity roles. It creates the object-storage container/volume
without starting the writers and extracts the volume archive in a networkless
helper. The helper has write access only to the fresh target volume and the
filesystem capabilities needed to restore its metadata.

The defaults are databases/roles `draftmatter` and `keycloak`. Explicit overrides
are available through `--database`, `--identity-database`, `--database-user` and
`--identity-user`; they must match the archive's manifest and the freshly
initialized target. `--compose-file` can select a reviewed compatible Compose
file. The source database major version and SeaweedFS data format must be
compatible with the restore images. Keep the source release/images available;
this is a recovery procedure, not an automatic database/server upgrade.

A successful result reports `status: "restored"` and `writersStarted: false`.
**It does not assert functional application recovery.** Before allowing access:

- Start the target object-storage service, identity service and collaboration
  service using the target environment, with no production DNS change.
- Check database rows, identity realm/client configuration, account access,
  manuscript portable-checkpoint hashes, retained shared-file bytes and their
  hashes, and storage quota state. Include an actual file download/upload and
  collaboration reopen in the rehearsal.
- Reconcile all erasure requests received since the backup before reopening a
  restored service. Restoration must not resurrect deleted accounts/content or
  re-enable revoked access accidentally. The independent minimal deletion record
  is part of the operator procedure described in [alpha operations](alpha-operations.md).
- Record source release, backup timestamp, restore duration and hash comparisons
  privately. Clean up only the explicitly identified disposable target after
  inspection. If a restore fails, it leaves that target for inspection and refuses
  to overwrite it on a retry; prepare a new target or deliberately remove only the
  failed disposable project after checking its identity.

To recover production on a replacement machine, follow the same fresh-target
process first, reconcile deletions and validate the service, then deliberately
promote that deployment and its intended DNS/identity endpoints. This script does
not perform the promotion.

## Retention and off-host copies

The 29-day threshold is **not a plan to accumulate 29 full archives on a 75 GB
VPS**. Use the local directory as staging and retain at most one recent verified
local archive once off-host copies are confirmed. A fresh full backup needs free
space in addition to both the active dataset and any existing local archive.
Before removing an older local archive for capacity, confirm the independent
off-host copy, compare its checksum with the local encrypted archive and verify
that it can be authenticated with the separately preserved key. Do not remove the
only known usable copy merely to make `create` succeed. If capacity cannot hold a
previous local copy and a new one together, an independently verified off-host
copy must exist before the operator deliberately clears that local staging copy.
The script does not perform that off-host verification or capacity-driven removal.

The hosted alpha promises a maximum of 30 days for technical backup retention.
Prune the dedicated directory daily with a **29-day** threshold, leaving a day
for the scheduled cleanup before that maximum:

```sh
node deploy/single-host/backup/backup.mjs prune \
  --directory /var/backups/draftmatter \
  --retention-days 29
```

`prune` requires the marker written by `create`, refuses a non-dedicated directory,
and removes only regular, unlinked files matching its archive filename format.
It uses the timestamp in that filename rather than a copy/touch time. It does not
delete unrelated files, follow symlinks or recurse into directories. Abandoned
`.dmbackup.partial` files from a host crash use the same age threshold; the
directory lock prevents pruning an archive while `create` is writing it. Retention
arguments above 29 days are refused. **Expiry applies to every old archive,
including the newest or last copy**; a failed backup schedule does not authorize
keeping personal data forever. The JSON result includes `remainingArchives` and
`noCurrentBackups`. Alert on backup/copy failures well before day 28, and alert if
there are no current backups while the alpha remains active. Configure an
operator-owned scheduler to run
the backup and prune commands daily, collect their JSON exit status, and alert on
failure. The tooling does not install a privileged scheduled job by itself.

Copy encrypted archives to a separate French storage location for host-loss
recovery, with credentials independent of the application. Configure the same
maximum retention on every replica, provider snapshot and offline copy, including
noncurrent object versions. Pruning this local directory does **not** delete those
copies. Do not extend retention by repeatedly copying an old archive under a new
creation timestamp, and do not apply the archive expiry policy to active project
objects. No off-host upload is performed by these scripts.

Local checks:

```sh
node --test deploy/single-host/backup/backup.test.mjs
```

The tests cover round-trip streaming encryption, wrong-key/tamper rejection before
restore receives plaintext, partial-output cleanup, private-key validation, restore
target guards, exact capacity arithmetic at the free-space boundary and above
64-bit ranges, and bounded pruning including the final expired copy. A disposable Docker restore rehearsal is still
required to establish the compatibility and functional recovery of the complete
deployment.

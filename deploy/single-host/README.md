# Single-VPS closed alpha

This stack keeps the browser application, collaboration service, PostgreSQL,
Keycloak and private S3-compatible storage on one Linux VPS. It is intended for
the free invited alpha, starting with 4 vCPU, 8 GB RAM and 75 GB disk. It does not
order a server, modify DNS, send invitations or configure an external paid cloud.
The existing [external-dependency template](../production/README.md) remains
available for a later managed database/identity/storage deployment.
The [13 November local rehearsal report](../../docs/deployment-rehearsal.md)
records the observed checks, exact tested images and remaining public-host gates.

```text
app.draftmatter.eu   -- HTTPS --> Caddy: browser application
sync.draftmatter.eu  -- HTTPS --> Caddy --> collaboration
auth.draftmatter.eu  -- HTTPS --> Caddy --> Keycloak (production mode)
                                          | TLS --> PostgreSQL (identity DB)
                               collaboration -- TLS --> PostgreSQL (app DB)
                                             -- TLS --> SeaweedFS (private files)
```

Only the proxy publishes ports. PostgreSQL, S3, the Keycloak admin console/API,
master realm, management endpoints and application metrics stay private. The
database and object networks are internal Docker networks. Application and
identity use separate non-superuser database roles. Internal database/S3
certificates have their own private CA and clients verify certificates and
hostnames; the production service keeps its strict TLS checks enabled.

Keycloak runs `start`, with no public registration, password/implicit grant or
demo accounts. The public client requires Authorization Code with S256 PKCE,
rotates refresh tokens, and issues the collaboration API audience. The identity
proxy uses edge TLS termination to the private Keycloak HTTP listener. It must
remain the only public path to that listener. See the [realm policy](keycloak/README.md).

The per-project data quota remains **1,000,000,000 bytes**. This stack additionally
reserves at most **25,000,000,000 declared DATA bytes across the entire instance**,
including unfinished transfers and versions pending successful deletion. The
global limit is configurable with `DM_PROJECT_FILES_TOTAL_QUOTA_BYTES`; changing
it requires checking actual free disk space first. This is a logical DATA limit,
not a filesystem quota: manuscripts, databases, WAL, object-store compaction,
logs, temporary writes and infrastructure backups also need disk. Monitor disk
space and alert before it reaches the reserved operating margin.

## Local rehearsal

Use the pinned Node version (`.node-version`), OpenSSL, Docker Engine and Compose
2.24.4 or later (`!override` support), plus the repository's installed Playwright
Chromium. Commands run from the checkout. Pick an empty private directory
**outside the checkout**. The initializer refuses existing files and never
prints credentials; it does not rotate an existing deployment.

```sh
npm ci
npm run deploy:single-host:init -- \
  --directory /private/tmp/draftmatter-rehearsal \
  --rehearsal --project draftmatter-rehearsal-local
npm run deploy:single-host:check -- /private/tmp/draftmatter-rehearsal/runtime.env

docker compose --env-file /private/tmp/draftmatter-rehearsal/runtime.env \
  -f deploy/single-host/compose.yaml -f deploy/single-host/rehearsal.yaml config --quiet
docker compose --env-file /private/tmp/draftmatter-rehearsal/runtime.env \
  -f deploy/single-host/compose.yaml -f deploy/single-host/rehearsal.yaml build
docker compose --env-file /private/tmp/draftmatter-rehearsal/runtime.env \
  -f deploy/single-host/compose.yaml -f deploy/single-host/rehearsal.yaml up -d --no-build

NODE_EXTRA_CA_CERTS=/private/tmp/draftmatter-rehearsal/tls/ca.crt \
  npm run test:deployment:smoke -- --env-file /private/tmp/draftmatter-rehearsal/runtime.env
```

The rehearsal exposes only **127.0.0.1:8088 and 127.0.0.1:8443**, using three
`*.draftmatter.localhost` names and a private test certificate. It never requests
a public certificate, changes the OS hosts file or installs a CA into the OS.
The Node test client verifies that CA. The isolated Chromium test contexts accept
the local certificate; this is restricted to the synthetic local rehearsal.
The image runs with `NODE_ENV=production`, verified PostgreSQL/S3 TLS and the same
realm policy as the VPS. No production grant or verification setting is relaxed.

The smoke test creates synthetic Alice/Bob/Eve accounts and disposable projects
only under the local names. It checks public routing and legal pages, denied
public administration, the actual DraftMatter sign-in button and visible account,
browser login, PKCE, refresh rotation/replay,
invitation-scoped access, WebSocket collaboration, resumable multipart files and
SHA-256 downloads, the 1 GB project reservation limit, and managed manuscript
backup/restore. It writes a private `rehearsal-report.json` without tokens or
passwords. It refuses a public hostname. No email is sent.

The file-transfer checks use the real HTTPS API, and collaboration uses the real
WebSocket protocol from a page served by the proxy. This rehearsal does not
exercise every Shared Files/OPFS interface interaction or an installed desktop
application's OS callback.

Then restart the stack and run the persistence verification:

```sh
docker compose --env-file /private/tmp/draftmatter-rehearsal/runtime.env \
  -f deploy/single-host/compose.yaml -f deploy/single-host/rehearsal.yaml restart
NODE_EXTRA_CA_CERTS=/private/tmp/draftmatter-rehearsal/tls/ca.crt \
  npm run test:deployment:smoke -- --env-file /private/tmp/draftmatter-rehearsal/runtime.env --verify-report
```

For the full repeatable sequence, including the encrypted fresh-volume recovery,
use `node scripts/rehearse-single-host.mjs --env-file /absolute/path/runtime.env`.
It builds the images, checks the stack, restarts it, backs up, restores into a
separate project, and verifies the recovered manuscript and file hashes. It
stops both projects afterwards and preserves their volumes and private reports.
`--skip-build` reuses explicitly prepared local images; `--keep-running` keeps
the recovered target running after a successful rehearsal. It refuses production
mode. CI runs this full local sequence on Ubuntu after the service regressions.

Run `npm run test:deployment` for the packaging, configuration, identity, smoke
guards and backup cryptography regressions. Real PostgreSQL concurrency tests
also require the disposable `DM_TEST_POSTGRES_URL` fixture described in
[the collaboration runbook](../../docs/collaboration-runbook.md).

## Encrypted infrastructure recovery drill

Application manuscript backups do not copy research datasets or recreate
accounts and permissions. Use the [full backup/restore procedure](../../docs/single-host-backups.md)
for both databases and the entire object volume. The initializer creates an
independent raw `backup.key`; preserve a protected copy outside the future VPS.

Create a backup, restore into a **new** `draftmatter-restore-*` project with a
separate private runtime directory, then verify the report against that target.
Preserve the source deployment configuration securely: restored Keycloak account
passwords come from its database; newly generated bootstrap/test passwords do
not reset them. Copy the source rehearsal report to the target directory for
`--verify-report`. Keep runtime paths and project names distinct, and stop the
source proxy before starting a target that uses the same localhost ports.

On a small disk, use local backups as bounded staging. A 25 GB dataset cannot
have 29 full daily copies on a 75 GB VPS. Keep one recent local archive after
verifying an independent off-host copy; monitor staging size and free space.
Backup creation never purges existing archives to make room. Explicit scheduled
pruning still expires every archive at the retention limit, including a last
copy; alert well before a missing backup reaches that age. The tooling does not
upload off-host copies. Configure independent storage and its retention before
real testers rely on the alpha.

## Preparing the future VPS

Create the private runtime directory for the operator before initialization:

```sh
sudo install -d -m 700 -o "$USER" -g "$(id -gn)" /etc/draftmatter
npm run deploy:single-host:init -- \
  --directory /etc/draftmatter \
  --app-host app.draftmatter.eu --sync-host sync.draftmatter.eu \
  --auth-host auth.draftmatter.eu --email contact@draftmatter.eu \
  --project draftmatter-alpha-production --release REVIEWED_COMMIT
```

Use a directory writable only by the operator (mode 700, environment mode 600).
The production initializer deliberately leaves hosting, locations and additional
processors as `REPLACE_*` values. Fill these in `runtime.env` from the actual VPS,
email and backup arrangements; the preflight refuses placeholders. The local
rehearsal's legal wording and fake accounts must never be imported into a public
instance. Production has no accounts in its initial realm.

Before `up`, validate with `deploy:single-host:check`, `docker compose config
--quiet`, build the exact tested commit and validate the Caddy configuration.
Keep image digests and the matching private environment for rollback. Do not
reuse a release tag for changed images. New database migrations are discovered
and packaged automatically; rehearse upgrades on a restored copy before changing
the live database. Avoid multiple collaboration replicas.

After the first startup/migrations and after an upgrade, apply the alpha's
29-day application backup policy before inviting users. This sets the default
for future workspaces and shortens any existing 30-day settings, leaving a day
for scheduled physical cleanup within the public 30-day ceiling:

```sh
docker compose --env-file /etc/draftmatter/runtime.env \
  -f deploy/single-host/compose.yaml exec -T postgres \
  psql -U postgres -d draftmatter --set ON_ERROR_STOP=1 \
  < deploy/single-host/postgres/alpha-retention.sql
```

Check the queries in [alpha operations](../../docs/alpha-operations.md) and
monitor the hourly maintenance process; setting a policy does not establish
that physical deletions completed while a service or disk was unavailable.

Point only the A records of `app`, `sync` and `auth` at the eventual VPS; add AAAA
only when IPv6 is tested. Keep OVH mail/MX/SPF/DKIM and the website DNS intact.
Public Caddy obtains certificates after working DNS and inbound TCP 80/443 exist.
Restrict SSH at the host/provider firewall; do not expose backend ports. The
marketing website is not served by this stack.

Initial accounts require operator provisioning through Keycloak's private admin
interface (for example `kcadm.sh` inside its container). Verify the invitee's email
before marking it verified; use unique temporary initial passwords delivered
through an appropriate private channel. The bootstrap admin is temporary: create
a permanent operator account, secure it and remove the bootstrap account before
opening the alpha. Password reset is disabled until an actual mail delivery
provider is configured; in-app invitations and notifications remain available.
The scripts do not create or send real invitations.

## Operating limits

- Monitor readiness, backup age, disk, container restarts and memory. The stack's
  configured service memory limits sum to roughly 4.25 GiB; this is a budget, not
  a workload-capacity claim. Record actual peak usage on the target x86 VPS.
- Internal TLS leaf certificates expire after 90 days, the private CA after one
  year. Renew leaves before day 60, keeping the trusted CA; distribute renewed
  certificates with the initializer container and restart their consumers.
  Do not regenerate database passwords or overwrite the runtime directory to
  renew certificates. CA renewal needs a planned trust transition before expiry.
- Backups pause writers to obtain a coherent cross-service snapshot. Schedule
  the maintenance window, daily backups, pruning and off-host replication, and
  alert on failure. Keep every replica within the alpha's maximum 30-day backup
  retention (29-day scheduled expiry gives one day's margin).
- A restored instance must reconcile erasure requests before reopening. Follow
  [alpha operations](../../docs/alpha-operations.md).

The local rehearsal does not prove public DNS/ACME issuance, an installed desktop
OS callback, independent off-host recovery or performance on the eventual VPS.
Those checks remain part of the public deployment qualification.

Check and renew internal TLS certificates using the private runtime file:

```sh
node scripts/renew-single-host-tls.mjs --env-file /etc/draftmatter/runtime.env --check
node scripts/renew-single-host-tls.mjs --env-file /etc/draftmatter/runtime.env
docker compose --env-file /etc/draftmatter/runtime.env \
  -f deploy/single-host/compose.yaml run --rm --no-deps initialize
docker compose --env-file /etc/draftmatter/runtime.env \
  -f deploy/single-host/compose.yaml restart postgres object-storage keycloak collaboration edge
```

The renewal tool preserves the CA, credentials and realm, verifies all new
certificate/key pairs before installing them, and keeps a private rollback
journal for interrupted replacements. It does not restart containers itself.
Do not remove a stale renewal lock until verifying no renewal process is active;
the tool then recovers the old complete pairs before attempting another renewal.
It refuses a CA with fewer than 90 days remaining: plan the CA trust transition
instead of silently extending that CA or disabling verification.

Regular certificate, key and journal files are flushed on every platform. POSIX
systems also flush directory entries; Node does not support this on Windows.
Windows local runs therefore do not provide the same power-loss durability. Run
production certificate renewal on the Linux VPS.

Configuration references: [Keycloak hostname and edge TLS termination](https://www.keycloak.org/server/hostname),
[Keycloak reverse-proxy boundaries](https://www.keycloak.org/server/reverseproxy),
[PostgreSQL TLS and private-key permissions](https://www.postgresql.org/docs/18/ssl-tcp.html),
and [Caddy certificate configuration](https://caddyserver.com/docs/caddyfile/directives/tls).

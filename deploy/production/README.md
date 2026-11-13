# First private server deployment

For the budget alpha with database, identity and file storage on the same VPS,
use the [single-host stack and local rehearsal](../single-host/README.md).
This directory retains the topology with separately operated dependencies.

This directory prepares a single Linux host running two containers: the browser
application and HTTPS proxy in `edge`, and one `collaboration` service. It needs an
operated HTTPS OIDC provider, a TLS PostgreSQL database, and a private S3 bucket.
Those dependencies are not provisioned by this template. The development stack
at the repository root remains separate.

```text
app.<domain>  -- HTTPS --> edge: static browser application (dist/)
sync.<domain> -- HTTPS --> edge -- HTTP/WebSocket --> collaboration:1234
                                                      | PostgreSQL with verified TLS
                                                      | private S3 over HTTPS
                                                      | public HTTPS OIDC/JWKS
```

This is preparation for a private pilot, not a claim that a server has been
deployed or that the installed desktop callback has been qualified. The marketing
site (`dist-website/`) is a separate build and is not served by this stack.

## Decisions needed before starting

- Select the Linux host, SSH access, and two DNS names. Point their A records (and
  AAAA records only when IPv6 works) to the host. Allow inbound TCP 80/443 and SSH
  from the administrator's network. Keep the database and bucket private. Only
  `edge` publishes application ports; the Node API has no host port.
- Provide PostgreSQL credentials scoped to DraftMatter's database, including
  permission to run its schema migrations. The database certificate must match
  the DSN hostname and chain to a CA trusted by Node. This template assumes a
  public CA. For a private provider CA, add an explicit Compose override mounting
  the CA read-only and setting `NODE_EXTRA_CA_CERTS` to its container path before
  starting. Never disable verification. Do not add `sslmode`, `sslrootcert`, or
  other SSL options to the DSN; configure `DM_DATABASE_TLS=verify-full` instead.
- Create a private bucket with encryption and separate backup credentials.
  For the closed alpha, prefer versioning disabled or explicitly configure
  noncurrent-version expiry and physical deletion; application deletion alone
  does not erase old S3 versions. Apply the [alpha retention runbook](../../docs/alpha-operations.md).
  The service needs HeadBucket, ListBucket, GetObject, PutObject and DeleteObject
  on its configured prefix. Its immutable writes use `If-None-Match: *` and
  `ServerSideEncryption: AES256`; verify provider compatibility. A ready health
  check probes HeadBucket, which does not prove write, read, or restore access.
- Define who can sign in and create workspaces. Use production OIDC credentials
  and explicitly provision the private pilot users. Do not import the development
  realm, its demo users, password grant, or `start-dev` configuration.

## Identity provider

The service publishes one `DM_OIDC_CLIENT_ID` for both browser and desktop. That
client must be public, use Authorization Code with S256 PKCE, have no client
secret, and support the `openid profile email` scopes. Require short-lived JWT
access tokens and rotating refresh tokens. Disable implicit and password grants.

`DM_OIDC_AUDIENCE` is the audience accepted by the API, not an extra parameter
sent by the login request. Configure an audience mapper/default scope at the IdP
so its access tokens actually contain that audience. Use the exact discovery
issuer, including any meaningful trailing slash, as `DM_OIDC_ISSUER`, and the
published HTTPS `jwks_uri` as `DM_OIDC_JWKS_URI`. Both URLs must be reachable from
the browser and from inside the collaboration container.

Register browser redirect URIs on the exact application host. The current client
preserves the page's pathname and removes query/fragment when building its
callback: `/` logs back into `/`, `/invite` into `/invite`, and workspace/project
links into their full paths. Register the paths used by the pilot; if your IdP
supports a path wildcard, scope it to this one HTTPS host. An origin by itself is
not a wildcard redirect. The SPA fallback serves these callback paths.

Register the desktop redirect URI exactly as `draftmatter://auth/callback`. Add
the relevant web origins to both the IdP's CORS policy and `DM_ALLOWED_ORIGINS`:
`https://app.<domain>`, `tauri://localhost` for macOS/Linux, and
`http://tauri.localhost` for Windows. Web origins have no paths or wildcards.
Qualify a complete login on an installed desktop build; a browser login alone
does not prove OS callback registration.

## Configuration and build

The free closed-alpha legal pages are public application routes under `/legal/`.
Set the public `DM_LEGAL_*` values using the actual operator and contact, the
hosting provider’s legal identity/address/contact, a short English statement of
the hosting country, and any additional data-processing providers. Keep server
architecture, addresses, ports and component names in operator documentation,
outside these public fields. Only claim hosting in France by a French company
after confirming both facts; a website on another host must identify that host. The preflight and browser image build
refuse missing or placeholder hosting information. These fields are compiled
into the browser bundle, so they must never contain credentials. Rebuild after
changing them. Local builds show preparation wording until hosting is known.
See [alpha publication and OVH preparation](../../docs/alpha-launch.md) for the
website configuration, legal scope and the next provisioning steps.

Use Node 24.10.0 (the repository's `.node-version`) and Docker Engine with Compose
v2. Keep real secrets outside the checkout and Docker build context. Container
environment variables remain readable to Docker administrators: limit access to
the host, Docker socket, and environment file. A secrets manager can supply the
same variables in a later provider-specific deployment.

```sh
sudo install -d -m 700 /etc/draftmatter
sudo install -m 600 -o "$USER" deploy/production/.env.example /etc/draftmatter/production.env
```

Edit that file and replace every `REPLACE_` value. Set `RELEASE_ID` to the exact
tested Git commit or a unique release tag. Do not reuse a tag for different
images. Generate the webhook secret independently with `openssl rand -base64 48`.
Use literal values without dollar expansion, and percent-encode special
characters in the database username/password. Leave the three optional email
variables empty together if no email delivery provider is configured. In-app
notifications do not require an email provider. For AWS workload identity, both
explicit object credential fields may be left empty together if the container
can obtain its intended scoped role through the SDK's default credential chain.

Run from the repository root, with no conflicting `DM_*`, host, email, or release
variables exported in the shell:

```sh
DM_PRODUCTION_ENV=/etc/draftmatter/production.env
npm ci
npm run deploy:check -- "$DM_PRODUCTION_ENV"
docker compose --env-file "$DM_PRODUCTION_ENV" -f deploy/production/compose.yaml config --quiet
docker compose --env-file "$DM_PRODUCTION_ENV" -f deploy/production/compose.yaml build
docker compose --env-file "$DM_PRODUCTION_ENV" -f deploy/production/compose.yaml run --rm --no-deps --entrypoint caddy edge validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

`deploy:check` validates the actual service configuration without contacting
dependencies, refuses placeholders and insecure settings, checks matching app
origins, and prints no credentials. It also refuses conflicting exported values
that would override the checked file in Compose. Do not publish the output of
`docker compose config` without `--quiet`, or `docker inspect`: these may contain
secrets.

The browser service URL is injected through
`VITE_DRAFTMATTER_COLLABORATION_URL=https://<COLLABORATION_HOST>` **during the image
build**. Changing that hostname requires rebuilding `edge`; changing only its
runtime environment does not update a compiled browser bundle. The edge image
serves the app at `/`.

The service image is the root `Dockerfile`. Both images run without root and
with read-only root filesystems, a writable temporary directory, dropped Linux
capabilities and bounded Docker log rotation. Caddy keeps its certificate data
in named volumes. The pinned base tags are in the Dockerfiles; record image IDs
or digests for rollback and review base-image updates before the real deployment.

## Start and verify on the chosen server

The commands below actually start the public stack and acquire certificates.
Use them after the host, DNS, credentials and backup destination have been set.

```sh
docker compose --env-file "$DM_PRODUCTION_ENV" -f deploy/production/compose.yaml up -d --no-build
docker compose --env-file "$DM_PRODUCTION_ENV" -f deploy/production/compose.yaml ps
npm run deploy:check -- "$DM_PRODUCTION_ENV" --probe
```

The optional probe performs only unauthenticated GET requests: app HTML, service
liveness/readiness, exact-origin CORS and published identity configuration,
rejection of an unauthenticated API request, private metrics, and OIDC discovery
and JWKS. It does not perform a login or certify access-token audience, S3 writes,
WebSocket connectivity, backup restoration, or capacity. A redirect is treated
as a configuration failure. Failed probes do not print remote response bodies.

Before opening the private pilot, record these results on disposable projects:

1. Log in from the hosted browser and installed desktop. Verify the access token
   is accepted by the API with the intended issuer/audience. Never paste the
   token into logs or a ticket.
2. Create a project, share a figure and a citation, and edit it simultaneously
   from desktop and browser. Open it as a second invited user. Confirm figure
   bytes, bibliography, tracked changes and exported manuscript agree.
3. Disconnect, edit, close/reopen, and reconnect. Confirm offline edits survive,
   merge once, and remain scoped to the correct account/project. Check that an
   expired token refreshes and an explicitly revoked membership loses access.
4. Restart the service and verify accepted edits and shared resources persist.
   Keep one service instance: migrations and live-room coordination have not
   been qualified for multiple replicas.
5. Create the first application backup explicitly, verify it, and restore it to
   a **new disposable target project** through the owner's backup controls/API.
   The background maintenance interval defaults to 24 hours of continuous
   operation; readiness does not mean a first backup exists.
6. Restore the independently backed-up PostgreSQL database and bucket into an
   isolated recovery environment. Confirm the restored project can open and
   export. Record recovery time and acceptable data loss before inviting users.

The proxy caps JSON request bodies at 64 KiB. Authenticated data upload parts have
a separate, exact-route 8 MiB exception; see
[project data transfers](../../docs/project-data-files.md).
WebSocket frames are bounded separately by the collaboration service's
`DM_MAX_PAYLOAD_BYTES` (16 MiB by default). Do not
configure a short generic proxy timeout that drops live WebSocket sessions.

## Operations and rollback

Back up PostgreSQL and versioned objects on a schedule independent of application
maintenance, with credentials the service cannot use to delete those backups.
Preserve the deployment environment securely, the exact source commit, image
digests, and the Caddy certificate volumes. Never use `down --volumes` for a
normal restart or update. Application backups supplement infrastructure backups;
they do not reconstruct missing accounts, permissions, or the whole database.

Monitor `/health/ready`, restarts, disk/memory, PostgreSQL space, object-storage
errors and backup age. `/metrics` is intentionally hidden by the public proxy;
an administrator can scrape it through the Docker network or an authenticated
private tunnel. Configure external uptime/backup alerts before relying on the
instance. Logs can contain identifiers or infrastructure errors and belong in
restricted operations tooling.

Before an update, retain the previous environment file and both image IDs and
take database/object backups. Build a new unique `RELEASE_ID`, run the checks,
then replace the two containers. For a failure before a schema change, use the
previous image tags and matching environment file. A schema migration may make
an old image incompatible: validate migration/restore on a database copy before
an upgrade, and use the tested database plus object restore procedure if an
image-only rollback is unsafe. Avoid running old and new service instances
against the same database simultaneously during migration.

Proxy behavior follows the official [Caddy reverse proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
and [SPA routing with try_files](https://caddyserver.com/docs/caddyfile/directives/try_files).

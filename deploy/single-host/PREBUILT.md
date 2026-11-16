# Install a prebuilt server release

This is the VPS installation path. GitHub builds and tests the Linux `amd64`
images; the VPS downloads them by digest and never compiles DraftMatter. Node,
npm and OpenSSL do not need to be installed on the host: the release includes
an operator image with the preparation/check/TLS helpers.

Use a reviewed `server-vVERSION` GitHub release from `VEZY/DraftMatter`. The
manifest identifies the exact source commit and immutable collaboration, web
and operator images. A GitHub release archive is public code and configuration
templates, not manuscripts, data, passwords or a production `runtime.env`.

## Download the release on the VPS

Run these commands **on the VPS, in the `deploy@draftmatter` window**. Set the
version to the published release you intend to install; do not use `latest`.

```sh
release_version=0.1.0-alpha.1
release_directory="/opt/draftmatter/releases/$release_version"
mkdir -p "$release_directory"
cd "$release_directory"
curl --fail --location --remote-name "https://github.com/VEZY/DraftMatter/releases/download/server-v${release_version}/draftmatter-server-${release_version}.tar.gz"
curl --fail --location --remote-name "https://github.com/VEZY/DraftMatter/releases/download/server-v${release_version}/server-release.json"
curl --fail --location --remote-name "https://github.com/VEZY/DraftMatter/releases/download/server-v${release_version}/SHA256SUMS"
sha256sum --check --strict SHA256SUMS
tar -xzf "draftmatter-server-${release_version}.tar.gz"
```

Stop if the download or checksum check fails. The checksums detect corruption;
the selected GitHub repository/release and image digests are the distribution
trust boundary. Keep the downloaded manifest, archive and checksums together.
The extracted `draftmatter-server/` directory contains the Compose files and
operator wrapper, while its parent contains these three downloaded assets.

The clone in `/opt/draftmatter/app` can remain for administration. It is not
needed to build an application image on the server.

## Initialize an empty private runtime directory

The operator wrapper uses `sudo docker` as the current user; do not run the
wrapper itself under `sudo`. It maps the current UID/GID into the container so
the generated files belong to `deploy`, runs without network access, and mounts
the runtime directory at its identical absolute host path.

```sh
sudo install -d -m 700 -o "$USER" -g "$(id -gn)" /etc/draftmatter
sh "$release_directory/draftmatter-server/scripts/server-operator.sh" \
  "$release_directory" /etc/draftmatter init \
  --app-host app.draftmatter.eu --sync-host sync.draftmatter.eu \
  --auth-host auth.draftmatter.eu --email contact@draftmatter.eu \
  --project draftmatter-alpha-production
```

Initialization creates fresh private credentials, certificates, `backup.key`,
the closed identity realm, `runtime.env` and `release.env`. It refuses a nonempty
directory and does not start any service. Never delete or regenerate those
files to work around an initialization refusal. For an existing installation,
use the reviewed upgrade/restore procedure instead.

Set the confirmed public legal hosting/location/processors information in
`/etc/draftmatter/runtime.env`. The initializer deliberately leaves `REPLACE_*`
values and the production check refuses them. Keep the directory mode `700`
and both environment files mode `600`; never commit, upload or print them.
Keep a protected independent copy of `backup.key` and establish encrypted
off-host backups before real test data is entrusted to the alpha.

```sh
sh "$release_directory/draftmatter-server/scripts/server-operator.sh" \
  "$release_directory" /etc/draftmatter check
```

The check validates the production topology, legal settings, private files and
that both environment files match the selected release. Image configuration
contains only the four checked variables in `release.env`; this file is never
sourced as a shell script.

## Pull and start without building

Use both Compose files and both environment files for every command. The
prebuilt override removes both application `build` declarations and selects
Linux `amd64` images by digest. The infrastructure images remain pinned by the
release's Compose file. Only Caddy publishes ports `80` and `443`.

```sh
cd "$release_directory/draftmatter-server"
sudo docker compose --env-file /etc/draftmatter/runtime.env \
  --env-file /etc/draftmatter/release.env \
  -f deploy/single-host/compose.yaml -f deploy/single-host/prebuilt.yaml config --quiet
sudo docker compose --env-file /etc/draftmatter/runtime.env \
  --env-file /etc/draftmatter/release.env \
  -f deploy/single-host/compose.yaml -f deploy/single-host/prebuilt.yaml pull
sudo docker compose --env-file /etc/draftmatter/runtime.env \
  --env-file /etc/draftmatter/release.env \
  -f deploy/single-host/compose.yaml -f deploy/single-host/prebuilt.yaml up -d --no-build
```

Confirm DNS, the provider firewall, HTTPS, readiness and persistence before
inviting anyone. Apply `postgres/alpha-retention.sql` after the first migrations,
replace the bootstrap Keycloak administrator, and complete an independent
encrypted backup and restore drill. The local synthetic smoke script refuses
public hostnames and is not a production account provisioning tool. See
[the main runbook](README.md), [alpha operations](../../docs/alpha-operations.md)
and [infrastructure backups](../../docs/single-host-backups.md).

## TLS maintenance with the same operator release

```sh
sh "$release_directory/draftmatter-server/scripts/server-operator.sh" \
  "$release_directory" /etc/draftmatter tls-check
```

Use `tls-renew` before internal leaves reach their renewal deadline. Renewal
changes only certificate files, preserving the CA, passwords and backup key.
Copy the renewed certificates with the `initialize` Compose service, then
restart their consumers according to the main runbook. No automatic Docker
restart or backup rotation is performed by the TLS helper.

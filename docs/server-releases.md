# Prebuilt server releases

The closed alpha runs prebuilt Linux amd64 images. The VPS downloads them;
it does not compile DraftMatter or need a host Node.js/npm installation.
Desktop installers can ship in the same GitHub prerelease as the server.

## Publish desktop and server together

From your Mac, once the reviewed changes are on `main`, run:

```sh
npm run release:all
```

In GitHub Actions the equivalent is **Server release → Run workflow** on
`main` with **include_desktop** enabled. Leave the version blank for the next
alpha. One workflow chooses the version and commit for both products, runs
the desktop builds alongside the server checks, and collects the verified
files in one draft release tagged `server-vVERSION`. A single-platform
failure prevents the combined version from becoming public.

Open the draft from the Actions summary. Check the installers on the target
systems as described in the [desktop release guide](release-compliance.md),
then click **Publish release** once. The download page discovers published
installers on GitHub. Its existing links keep working while a new draft is
under review or a newer release contains only the server.

`SHA256SUMS-desktop` covers the desktop distribution. `SHA256SUMS` covers the
two server downloads the VPS updater expects. Updating the running VPS is a
separate operator action.

## Publish a reviewed server version

From your development machine, push the changes you want to publish to `main`.
With the GitHub CLI signed in, run this from the repository:

```sh
npm run release:server
```

You can also open **Actions → Server release → Run workflow**, select `main`
and leave **version** blank. Both paths build the commit on GitHub's `main` at
dispatch time. The workflow increments the highest existing server alpha series
(for example, `0.1.0-alpha.9` becomes `0.1.0-alpha.10`). To start a new series
or publish a beta or release candidate, enter the version explicitly in Actions.
A commit that already has a server release tag is caught before the build.
The workflow also refuses an existing version or a reused image tag.

On success, the Actions summary links to the release and its source commit.
The release notes link to the changes since the preceding server tag when one
exists. To deploy a published version to the existing VPS, use
`npm run deploy:server -- VERSION` from your Mac.
[VPS update and recovery instructions](../deploy/single-host/PREBUILT.md#update-a-running-alpha-from-your-mac)

Do not supply private environment files, application credentials or research
data to the workflow. The repository's source code is its only build context.

Publication runs the existing collaboration CI on the exact workflow commit:
browser/service tests, real PostgreSQL and S3 fixtures, image builds, offline
operator initialization, and the complete login/file-sharing/restart/encrypted
backup/restore rehearsal. The rehearsal uses those already-built images with
`--skip-build`. It must pass before the three images are exported as a short-lived
artifact of that run.

Only the publication job has package and repository write permissions. It loads
that artifact, checks its source labels, image IDs and Linux amd64 architecture,
then promotes those same image IDs to:

- `ghcr.io/vezy/draftmatter-collaboration`
- `ghcr.io/vezy/draftmatter-web`
- `ghcr.io/vezy/draftmatter-operator`

Each gets `sha-FULL_COMMIT` and the explicit version tag. Registry manifests are
checked against the tested image IDs. The public `server-release.json` records
immutable `@sha256:` references; installation uses those digests, not mutable
tags. For an OCI provenance index or Docker manifest list, publication verifies
the single Linux amd64 child against the tested configuration and records that
platform image's digest. There is no `latest` image or automatic VPS deployment.

For a server-only run, the workflow publishes the GitHub prerelease automatically
after uploading the server assets. A combined run leaves the release in draft
for the installer review. Both paths use the `server-vVERSION` tag and mark
the release as a prerelease, including when the version has no prerelease suffix.

New GHCR packages are private by default. After the first publication, the
repository owner must set all three package pages to **Public** for the intended
anonymous pulls on the VPS. If access is denied, check package visibility and
repository association; never treat authentication errors as an absent tag and
overwrite it. The workflow itself does not alter account-level package settings.

If publication fails partway through, do not reuse the version or overwrite
images. Inspect the failed phase, preserve any partial release for diagnosis,
and publish a new reviewed source commit with a new version. A complete release
manifest is produced only after all three image pushes and registry checks pass.

## Install a chosen version

The published release provides:

- `draftmatter-server-VERSION.tar.gz`: public deployment templates and operator
  helpers from that exact committed source, with a `draftmatter-server/` prefix.
- `server-release.json`: version, source commit, platform, and the three image
  digests; an identical copy is included in the archive.
- `SHA256SUMS`: checksums of the downloaded archive and standalone manifest.

Download all three files from the same explicit GitHub release into one folder.
Verify `sha256sum --check --strict SHA256SUMS` there before extraction. Checksums
detect changed bytes; they rely on the selected GitHub release as the trusted
source and do not establish an independent publisher signature.

Extract the archive in that folder, retaining the standalone manifest and
checksums beside it. The operator wrapper expects this structure:

```text
release-directory/
  SHA256SUMS
  server-release.json
  draftmatter-server-VERSION.tar.gz
  draftmatter-server/
    deploy/single-host/
    scripts/server-operator.sh
    docs/server-releases.md
```

Continue with the **prebuilt release** procedure in
[`deploy/single-host/PREBUILT.md`](../deploy/single-host/PREBUILT.md). The operator
wrapper runs the pinned helper image without network access, maps the operator's
UID, and initializes the existing private runtime directory. Initialization
refuses existing configuration rather than rotating secrets. Runtime settings
and generated `release.env` remain outside this public archive and the checkout.

The web image receives only allowlisted public site/legal settings at startup;
it contains neither CI fixture contacts nor a site's runtime secrets. Production
configuration must identify the actual host, data locations and contact before
opening the alpha. Generic images do not make those deployment facts true.

Use the base Compose file plus `prebuilt.yaml`, both matching the release, and
both private environment files. Run `pull` and `up -d --no-build`; the override
removes build definitions and requires immutable release-image references.
Do not run the local synthetic smoke test against public alpha hostnames.

Before inviting testers, complete the operations checks in
[`alpha-operations.md`](alpha-operations.md), including independent encrypted
off-host backups, a protected copy of the backup key, monitoring and a restore.
The CI rehearsal checks software behavior on its runner; it does not qualify
the VPS's capacity, firewall, DNS or backup arrangements.

## Local verification of the publication boundary

```sh
npx vitest run services/collaboration/serverReleasePipeline.test.mjs \
  services/collaboration/serverRelease.test.mjs --maxWorkers=1
```

The packaging tests use a disposable Git repository and private canary files.
They check that only committed deployment sources enter the archive, that
untracked runtime settings and unrelated manuscript/data paths stay out, that
symlink/private deployment assets are refused, and that assets are not replaced
on retry. Workflow execution still needs the real GitHub Actions and GHCR checks;
local unit tests are not evidence that an image has been published.

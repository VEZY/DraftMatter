# Prebuilt server distribution verification — 16 November 2026

This verification covers the prebuilt server distribution changes prepared on
`main`, based on `a2f0a6c92aca04a60a4798eaf0e72c408a60bc2f`. It is local evidence;
the release workflow must separately qualify its exact published commit on Linux
amd64. It does not establish that the VPS has been deployed or tested.

## Observed checks

- Application and website TypeScript checks passed.
- The deployment suite passed 118 tests in 12 files; its 10 encrypted backup
  tests passed separately. Runtime configuration and website/session consumer
  checks also passed.
- Official actionlint 1.7.12 validated both server workflows. The downloaded
  linter archive was checked against its publisher's checksum file.
- The collaboration and generic web images built locally on Linux arm64. The
  operator image built and executed for Linux amd64.
- The generic web image started as UID 1000 with a read-only root filesystem,
  no network and dropped capabilities. Its generated public JSON had mode 600,
  exactly the six allowed public settings and no injected private canary.
  Missing public settings stopped startup. Caddy configuration validation passed.
- The amd64 operator initialized and checked a disposable deployment with no
  network, a read-only root and a mapped host UID. Directory and environment
  permissions were private; attempted reinitialization preserved credentials.
- The resolved prebuilt Compose topology had six services, no build definitions,
  and the intended immutable application image references.

The runtime images use Node 24.22.3, a maintenance/security release of the Node
24 LTS line; see the [official release notes](https://nodejs.org/en/blog/release/v24.22.3).
This is not a claim that all dependencies underwent a vulnerability audit.

## Full local rehearsal

The isolated source and restore projects completed every phase using the
already-built images (`--skip-build`):

1. Validate Compose, start the source and wait for readiness.
2. Verify public runtime/legal configuration, real browser sign-in and PKCE,
   invitation-scoped collaboration, denied outsider access, resumable file
   transfer and hashes, quota enforcement and manuscript backup behavior.
3. Restart and verify persisted accounts, manuscripts and file bytes.
4. Create an encrypted infrastructure backup and restore both databases and
   the object store into new, separate volumes.
5. Start the restored project and verify its accounts, manuscript and file
   hashes, then stop both disposable projects.

The private local report is
`/private/tmp/draftmatter-server-release-rehearsal-20261116/end-to-end-rehearsal-report.json`.
It reports `status: passed` and `keptRunning: false`. Runtime settings, keys,
backup archives and synthetic project data are not included in this repository
or the public server release archive.

## Remaining qualification boundaries

GitHub Actions must run the exact release commit, exercise the amd64 stack and
verify the promoted registry manifests. A local build is not publication.
New GHCR packages must be made public before anonymous VPS downloads work.

The existing Browser end-to-end run on the parent commit was not green: its
reported failures covered screenshot paths, a stale file selector, focus styling
and comment positioning; typing performance was flaky. That is separate from
the successful server rehearsal and is not represented here as a completed full
application UI qualification.

Before inviting real testers, the VPS still needs its production initialization,
DNS/firewall/HTTPS checks, permanent operator account, independent encrypted
off-host backups, monitoring and a restore exercise. The local rehearsal does
not measure the PulseHeberg VPS's capacity for ten concurrent users.

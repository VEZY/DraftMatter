# Local deployment rehearsal — 13 November 2026

The complete local single-VPS deployment rehearsal **passed**, including recovery
into fresh PostgreSQL and object-storage volumes and verification through the
restored application's real sign-in flow. Both Compose projects were stopped
afterwards, with their volumes retained. No VPS, production DNS, public account,
email invitation or off-host backup destination was created.

## Reproduce

See [the single-host guide](../deploy/single-host/README.md). The complete command
is `npm run deploy:single-host:rehearse -- --env-file /absolute/private/runtime.env`.
The file must describe an isolated rehearsal initialized outside the checkout.
The successful run reused images built earlier with `--skip-build`; the build
itself passed separately. CI now runs the full sequence with a build on Ubuntu,
but that hosted CI run has not been observed from these uncommitted local edits.

## Observed checks

- Actual DraftMatter Home → Sign in → Keycloak → application callback, visible
  signed-in account, callback/PKCE transaction cleanup; repeated after recovery.
- Public legal/deep routes, missing asset 404, unauthenticated API rejection,
  private metrics and private Keycloak administration.
- Authorization Code with S256, correct API issuer/audience, disabled password
  grant/public registration, rotating refresh tokens and rejected replay.
- Three synthetic users: invited collaborator access, outsider rejection,
  manuscript convergence over WebSocket and reconnect.
- An 8,454,145-byte binary file transferred in two parts, resumed with a fresh
  login, downloaded by the collaborator and verified using SHA-256. Upload
  reservations enforce 1,000,000,000 bytes per project.
- Independent PostgreSQL pools tested concurrent reservations against the shared
  instance budget, including a REPEATABLE READ default. Maintenance recovery
  and the 29-day alpha policy setup also passed on disposable PostgreSQL.
- Managed manuscript backup creation, integrity verification and restore to a
  new project; full stack restart preserves accepted content and file bytes.
- Coherent infrastructure backup of the application and identity databases plus
  the private SeaweedFS volume, encrypted in streaming AES-256-GCM.
- Full archive restored into an empty, separately named Compose project. The
  restored browser sign-in, permissions, manuscript and downloaded file hashes
  passed while the original stack was stopped.

The file-transfer portion exercises the actual HTTPS API, not every Shared Files
or OPFS interaction. An installed desktop OS callback is not exercised.

## Verification results

- Full regression suite: **1,081 passed, 6 skipped** (186 files passed, 2 skipped).
  The optional real PostgreSQL fixtures were run separately: **4 passed, 1 S3
  fixture skipped** across maintenance and file-quota integration suites. The
  deployed private S3 path was exercised by the real HTTPS multipart rehearsal.
- Deployment regression suites: **84 passed**; backup/cryptography/retention
  tests: **10 passed**. TLS tests include a real interrupted certificate rotation.
- App and service TypeScript checks, browser/service Docker builds, production
  Caddy validation, both Compose configurations, `git diff --check` and the
  **691-component** dependency compliance inventory passed.
- Approximate idle container usage on this Mac was **780 MiB** across the five
  running application services. This is not a load or VPS capacity benchmark.

## Exact tested artifacts

Host: macOS arm64, Docker Desktop 4.49.0 / Engine 28.5.1, Compose 2.40.3.
Source base: `578bd6638eb66370099cd90607ad6202f131a5f1`, with uncommitted deployment
and legal changes. Other application changes arrived concurrently in this shared
checkout. The digests below identify the tested images; this rehearsal does not
certify every concurrent unstaged UI/native change as part of those images.

| Image | Tested digest |
| --- | --- |
| DraftMatter browser/proxy | `sha256:39889a482803e49b337df8eda6237436802b323a5038b3408503a699c5056487` |
| DraftMatter collaboration | `sha256:2031258b9febbbd0f7e5d3cddf99069ee4b0aae670d44a9a667735957f1a902e` |
| PostgreSQL 18.7 | `sha256:75dcac3dfb1cd01ca3536910bbc84128759362f8b118bf8c55b38a94f68f3b73` |
| Keycloak 26.7.0 | `sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13` |
| SeaweedFS 4.29 | `sha256:d47c7ee99fcb951351d7194915f4e3a5ea604a8e8871183d713907dec4fb9bf5` |

## Final run

Started: `2026-11-13T10:55:35.468Z`; finished: `2026-11-13T10:58:09.265Z`.
Total duration: **153.80 seconds**.

| Phase | Result | Duration |
| --- | --- | --- |
| compose-validation | passed | 0.06 s |
| build | skipped | 0.00 s |
| source-start | passed | 13.17 s |
| source-readiness | passed | 0.18 s |
| initial-smoke | passed | 7.81 s |
| source-restart | passed | 2.51 s |
| restart-readiness | passed | 21.63 s |
| restart-persistence | passed | 2.96 s |
| encrypted-full-backup | passed | 39.87 s |
| prepare-isolated-restore | passed | 0.01 s |
| restore-full-backup | passed | 7.71 s |
| source-stop-before-target-start | passed | 15.50 s |
| target-start | passed | 8.20 s |
| target-readiness | passed | 1.18 s |
| restored-persistence | passed | 2.63 s |
| final-stop-target | passed | 30.18 s |
| final-stop-source | passed | 0.19 s |

Private source/target environments, certificates, encryption keys, account
passwords, raw diagnostics and encrypted archives remain outside the checkout.
They are intentionally absent from this report. No token is included.

## Fixes found by the rehearsal

The original image copied only migrations 001–004. Packaging now discovers all
numbered SQL migration assets, including project data and alpha retention, with
regressions covering future migrations and stale/link handling. Docker Compose
2.40.3 also rejects `start --wait` and `create --no-deps`; backup recovery now uses
supported commands and explicitly waits for resumed service health.

## Before public deployment

Obtain the VPS and its actual region; set the three service DNS names, real legal
hosting details and a reviewed release ID. Configure and test independent
**off-host** backup storage and retention, apply the alpha 29-day policy after
migrations, arrange uptime/disk/backup alerts, and provision only invited accounts.
Verify public ACME certificates, the installed desktop callback, and resource
usage on the actual Linux x86 host. The local recovery uses separate Docker
volumes on one Mac and does not establish recovery after losing that Mac.

## Isolated publication candidate

The deployment/legal changes were subsequently reconstructed on top of
`f329a4a` (the latest OVH website publication changes), excluding concurrent
editor, selective-sync, native-host and TOML dependency work. That isolated tree
passed **1,083 regression tests, with 6 skipped**, all type checks and the
**689-component** dependency inventory. Seven browser checks passed, including
the root-domain OVH build under the final English public legal metadata.
Backup tooling has ten passing tests.

Both Docker images were rebuilt successfully from that isolated tree. Its new
full-stack rehearsal could not claim the default loopback ports because another
existing development stack was using them; that stack was left untouched.
The previously recorded full recovery run remains the complete local recovery
evidence. CI runs the isolated tree's full sequence on its own runner.

This extra startup/cleanup check exposed a PostgreSQL signal-forwarding issue
with a root `tini` process after the database drops to UID 70 under dropped
capabilities. PostgreSQL now uses its official PID-1 process (`init: false` for
that service only), rather than adding a broader signal capability. The isolated
PostgreSQL instance was verified as PID 1/UID 70, with no published database port,
a healthy restart and a clean exit-0 shutdown, without a signal-forwarding error.

## Linux CI recovery confirmation

The isolated candidate `4b921c82e35856501c6d671e21af3c3825f4a17b` passed the
[complete Linux collaboration workflow](https://github.com/VEZY/DraftMatter/actions/runs/43457485075),
including the full PostgreSQL/S3 test suite, image builds, browser sign-in and
shared-file checks, restart persistence, encrypted infrastructure backup,
fresh-volume restoration, restored file hashes and manuscript state, access
control, and cleanup of both dedicated projects. Restart and restored persistence
checks completed in 4.7 and 4.6 seconds respectively. The backup suite passed all
ten tests.

The first CI attempt at `d04be68` stopped during restart persistence. Its private
child-output boundary did not identify the failing browser sub-check. The later
successful run used the same assertions and timeouts, with fixed, allowlisted
sub-check identifiers added to diagnostics; no retry was added. The initial
failure has not been reproduced or assigned a demonstrated cause and remains a
monitoring point for the real VPS rehearsal. This does not replace verification
on the actual production host or an independent off-host recovery test.

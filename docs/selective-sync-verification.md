# Selective synchronization: local deployment verification

Verified on 13 November 2026, using the actual macOS desktop application and
the browser application served by the existing local Docker deployment.
The server remains running; its volumes and synthetic test projects are retained.

## Deployed artifacts

- Release: `local-selective-sync-20261113150242`.
- Source base: `578bd6638eb66370099cd90607ad6202f131a5f1`, plus the local
  synchronization and connection fixes. The checkout contains other uncommitted
  work; this is not a published release or a claim about every later checkout edit.
- Browser image: `sha256:28e8a2f0f24ce7aad81076537051c9039f5c1ad3060a96862dde85dbaf34e8a9`.
- Collaboration image: `sha256:59d2992eb9149770f4dae6134fd23ed02eec381ee1a984360d44e16b268fd0b1`.
- The desktop app was rebuilt with `npm run desktop:build -- --debug --bundles app`.
  The normal private runtime configuration now selects the verified release.

An encrypted backup of both databases and the object volume was created before
the upgrade. Migration `012` ran against the existing database and is recorded
exactly once. After the tests, SQL found ten heads, one tombstone, zero dangling
live heads and zero ready file paths without a head. The service passed a
verified HTTPS readiness probe after deployment and a restart.

## Observed behavior

| Case | Observed result |
| --- | --- |
| Existing shared data after migration | The original 8,454,145-byte file downloaded with its original SHA-256. |
| Default selection | Desktop followed the manuscript, SVG figure and references automatically. |
| Optional data | The CSV was absent online until its checkbox was selected, then downloaded byte-for-byte. The choice survived reopening the project. |
| Unselected file | The synthetic private notes had no online file version or unfinished upload. |
| Figures and references | The browser displayed the actual 240 × 160 image and the formatted citation and bibliography. Downloaded SVG, references and CSV matched the local bytes. |
| Browser → desktop | Normal typing in the actual browser editor was acknowledged while its window stayed open, appeared in both shared document representations, and materialized in the local manuscript. |
| Desktop → browser | Text pasted through the actual native editor appeared in the same live browser session and in an independent WebSocket reader. |
| Concurrent edits | With automatic file synchronization paused, an external local edit and a separate browser edit produced a conflict. Both copies remained unchanged before the choice. |
| Comparison | The native comparison showed the distinct local and online manuscripts without publishing either preview as a new version. |
| Keep both | The local manuscript was preserved exactly in a separate file, locally and online. The original path received the selected online version. |
| Further writing | After resuming, a new native edit reached the browser and disk; the conflict copy stayed unchanged. |
| Expired test credential | A resolution attempt failed clearly before replacing the local manuscript. Renewing the session preserved the conflict and allowed resolution. |
| Server version races | Two actual API publishers using the same expected version produced one accepted version and one conflict. Earlier bytes and the losing upload remained available; stale completion could not reset a newer head or tombstone. |

The manuscript remains authoritative in live collaboration; it does not have a
competing current file-store head. The preserved conflict copy is an ordinary
immutable shared file.

## Byte preservation

| Artifact | SHA-256 |
| --- | --- |
| Original pre-upgrade 8,454,145-byte file | `64f0b0837bfe2c18e4e698f7e0540c6f1b747900231e9a36425330cd9ae3aa79` |
| Local conflict copy, 475 bytes, identical on disk and online | `270accd1b304fe6d6f3c435d035848a2870d2c4271acf935b298fa3191267eb7` |
| Selected online manuscript at resolution | `de7c96e27b79ba01c331cd1655b06360877d84e07eed83aebd3ed505bfdbb114` |
| Final manuscript after another native edit, identical on disk and in the shared document | `c67303d6a66158c8f53c6b6a4d5b8dd9cc2dfc684ac02d7126ab3c80877e0e44` |

The final local hash was checked again after leaving the test session.

## Defects found and corrected

The actual browser launch exposed an identity race: launch hydration set the
authenticated author, then the local-author effect overwrote it during the same
initial render. The server correctly rejected the resulting presence. The client
now takes presence identity from the authenticated profile, and local settings
cannot overwrite a managed launch.

A protocol room closure could also leave the WebSocket open and the UI claiming
to be connected. Room readiness now requires synchronization, and a room closure
reports an offline state while retaining recovery and unsent edits.

Finally, changing expired credentials left the old realtime client attached and
made Join a no-op. Credential replacement now flushes recovery and retires that
client, ignores its late callbacks, and keeps desktop autosave protected until
the user rejoins or explicitly leaves. These cases have focused regressions.
No server identity or permission check was relaxed.

## Regression checks

The final full `npm test` run passed: 1,252 tests passed and 7 were skipped,
across 204 passing test files and 2 skipped files. The desktop application,
CLI, web/service builds and deployment images built successfully. Focused
regressions cover authenticated launch identity, room readiness and closure,
credential renewal, and editor replication.

## Test boundaries and cleanup

The browser used the real Keycloak Authorization Code + S256 flow and the actual
HTTPS service. For the private rehearsal certificate, desktop used a temporary
loopback bridge whose upstream verified the configured CA. The native connection
used the existing short-lived-token fallback with explicitly authorized private
temporary Alice credential files. Those files were removed; no refresh token was
written. No system certificate trust setting changed.

This run does not qualify the installed desktop OS authentication callback,
public DNS/certificates, a remote VPS, off-host restore, or load capacity. No
manuscript computation ran. All task-owned browser contexts were closed and the
native test session was left cleanly. The temporary loopback bridge exited
successfully at its scheduled expiry; the Docker stack remains running.
Local screenshots and the non-secret JSON
evidence are retained under `test-results/selective-sync-live/`.

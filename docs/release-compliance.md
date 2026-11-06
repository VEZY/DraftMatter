# Release, diagnostics, and compliance

## Supported local targets

The portability workflow type-checks, tests, and packages debug bundles for these Tauri targets from locked dependencies. The tag-driven `desktop-release.yml` workflow produces production release bundles:

- Windows x64 (`x86_64-pc-windows-msvc`)
- Linux x64 (`x86_64-unknown-linux-gnu`)
- macOS Apple Silicon (`aarch64-apple-darwin`)
- macOS Intel (`x86_64-apple-darwin`)

The web application remains a browser-safe fallback on all three operating-system families. It does not receive desktop host commands.

The same portability matrix builds and process-tests the Node.js 20+ CLI.
The CLI package includes clean export, the JSON agent interface, the stdio MCP
server, the canonical skill, and the thin Codex plugin. Each desktop bundle
contains a target-native `draftmatter-mcp` standalone sidecar and
`draftmatter-agent-host` execution sidecar; users do not install either
separately. Tagged releases also attach one platform-neutral
`draftmatter-<version>.tgz` archive and verified release metadata.

The installed application executable also dispatches terminal subcommands to
the bundled CLI. Linux packages expose it through `/usr/bin/draftmatter`; the
Windows NSIS installer adds its per-user install directory to `PATH` and removes
it again on uninstall. On macOS, the regular application remains directly
launchable from Terminal with `open -a DraftMatter`, while the platform-neutral
CLI archive provides the `draftmatter` shell command for users who want the full
terminal surface.

## Reproducible release checks

Run from a clean checkout:

```sh
npm ci
npm run check
npm test
npm run test:e2e
npm run build
npm run test:cli
npm run test:mcp
npm run test:agent-adapters
npm run validate:agent-skill
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run compliance:check
npm run compliance:generate
```

`compliance:check` resolves the locked npm and target-filtered Cargo graphs and rejects every SPDX token outside `compliance/license-allowlist.json`. `compliance:generate` emits target-specific third-party notices and a CycloneDX 1.5 SBOM. The portability workflow attaches both files beside each platform build.

`npm run release:verify` checks that the MCP SDK pin matches the lockfile and
that the Codex plugin and application versions match. It validates every entry
in `compliance/security-exceptions.json` against its locked package version,
severity, scope, and review dates. A recorded exception must cover an unexposed
low or moderate advisory and requires review by its deadline. The release
workflow runs `npm audit --audit-level=high` against the registry before packaging.

`test:e2e` starts the browser-safe application on loopback, exercises the rendered manuscript/review workflow in pinned Chromium, checks keyboard access, and compares the result with the committed visual baseline. The dedicated browser workflow installs the Playwright-pinned browser before running this gate.

The allowlist is an engineering gate, not legal advice. Adding an identifier requires an explicit reviewed change. Package-specific notice and attribution files must be retained when their licence requires it.

## GitHub distribution gate

Desktop releases do not require paid publisher certificates or Apple notarization.
Both development and release macOS bundles use a free ad hoc signature
(`signingIdentity: "-"`). CI mounts each architecture's final DMG read-only
and verifies the application inside with `codesign`. This does not identify a
verified publisher or satisfy Gatekeeper. CI requires the Windows MSI and NSIS
installers to both report `NotSigned` via Authenticode. Linux packages do not require a
publisher certificate. No Apple or Windows certificate secrets are needed.

Manual workflow runs upload candidate artifacts. Pushing a matching
`v<package-version>` tag builds all four targets into a **draft** GitHub release.
The release notes disclose the signing policy and link to the versioned
[installation instructions](installation.md) for macOS, Windows, and Linux.

Before publishing the draft:

1. Require successful tests, locked-dependency audit, platform builds and compliance jobs.
2. Check that the metadata job attached `SHA256SUMS`, per-target CycloneDX SBOMs, third-party notices, execution hosts and the standalone CLI.
3. Verify downloaded installers against `SHA256SUMS` and smoke-test installation and launch on each supported target, including the OS prompts described in the installation guide.
4. Review the draft assets and notes manually, retaining the exact source revision and locked dependencies used by the build.

`npm run release:verify` prevents a tag from drifting from `package.json`,
`package-lock.json`, `Cargo.toml`, or `tauri.conf.json`. The metadata job downloads
the actual installers from the draft and hashes their final download bytes and
filenames. Checksums detect corruption; they do not authenticate the publisher.
A failed job leaves at most an incomplete unpublished draft. Publish only after
all jobs succeed and manual review is complete; CI never publishes automatically.

## Runtime diagnostics

- **Project menu:** shows the active project root, manuscript path, save/recovery state, and external-change conflicts.
- **Execution environments:** reports Python, R, Julia, and Jupyter discovery separately, including executable/version or an actionable missing/unhealthy message. Trust is session-only and revocable.
- **Execution output:** reports provider, runtime identity/version, run state, hashes, stale/environment-changed state, stdout/stderr, artifacts, and retained-manifest availability.
- **History:** reports system Git availability/version, repository root, project prefix, branch/upstream/ahead/behind, staged and working changes, conflicts, and bounded source/rendered diffs.
- **External export:** reports installed Pandoc/Quarto versions, the exact project-relative output path, overwrite conflicts, and bounded renderer failures.
- **Citations:** reports local Zotero availability, Crossref/offline failures, citation-lock conflicts, and cached metadata state without logging manuscript content or credentials.
- **Collaboration:** reports sign-in/discovery failures, live/reconnecting state, active presence, pending owner checkpoint state, invitation/member activity, and named recovery status. Access and refresh tokens remain memory-only. A one-use invitation may be held in origin-scoped session storage only for the bounded OIDC redirect, then is removed on callback; all of these secrets remain absent from public metrics/logs.
- **AI assistant connections:** works without a project and reports client
  detection and a plain connected/not-connected state. Connect, update, and
  reconnect are one action; disconnect is confirmed. File-level state and
  advanced commands remain available in collapsed troubleshooting details.
- **Project AI status:** separately reports instruction/skill/manifest state,
  protocol and skill versions, project enablement, session-only execution
  trust, runtime readiness, and request-scoped network state. Neither check
  contacts a model.

## Privilege and data boundaries

- Tauri exposes fixed typed commands; there is no arbitrary shell command bridge.
- Project paths reject absolute paths, traversal, and platform prefixes. Opening a project validates citation recovery targets and their backups before restoring any files. Recovery directories and journals reject symbolic links and Windows junctions. A manuscript linked to another file inside the project can still be opened.
- Git uses fixed argument lists, bounded/redacted diagnostics, disabled repository hooks and filesystem monitors, no force/rewrite/discard operation, fast-forward-only pull, and explicit push.
- DraftMatter refuses Git operations when the repository or worktree configuration, including its included files, defines a `clean`, `smudge`, or `process` filter command. User and system Git filters remain available. Status and diffs show changes to a submodule's recorded commit. Inspect edits to files inside the submodule by opening it as a separate repository. History and checkpoint diffs display commit contents without invoking a signature verifier.
- External renderers accept only a clean projection. Quarto uses `quarto pandoc`, not `quarto render`; DraftMatter execution classes are removed before process launch.
- Native HTML escapes raw HTML, rejects active asset schemes, contains no scripts, and is governed by the desktop CSP while inside DraftMatter.
- Native DOCX contains resolved clean content and does not claim Word tracked-change round-trip. Relative figure paths produce a visible diagnostic.
- Opening and reopening never executes code, initializes Git, changes branches, contacts remotes, or runs an external renderer.

Any future capability that broadens filesystem, process, network, or browser privileges requires a new typed command, threat review, negative capability test, and release-note entry.

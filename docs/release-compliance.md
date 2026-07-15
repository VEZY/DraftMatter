# Release, diagnostics, and compliance

## Supported local targets

The portability workflow type-checks, tests, and packages these Tauri targets from locked dependencies:

- Windows x64 (`x86_64-pc-windows-msvc`)
- Linux x64 (`x86_64-unknown-linux-gnu`)
- macOS Apple Silicon (`aarch64-apple-darwin`)
- macOS Intel (`x86_64-apple-darwin`)

The web application remains a browser-safe fallback on all three operating-system families. It does not receive desktop host commands.

## Reproducible release checks

Run from a clean checkout:

```sh
npm ci
npm run check
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run compliance:check
npm run compliance:generate
```

`compliance:check` resolves the locked npm and target-filtered Cargo graphs and rejects every SPDX token outside `compliance/license-allowlist.json`. `compliance:generate` emits target-specific third-party notices and a CycloneDX 1.5 SBOM. The portability workflow attaches both files beside each platform build.

The allowlist is an engineering gate, not legal advice. Adding an identifier requires an explicit reviewed change. Package-specific notice and attribution files must be retained when their licence requires it.

## Signing and notarization gate

Development macOS bundles are ad-hoc signed (`signingIdentity: "-"`) so local builds are testable. They are not public-release artifacts. Before publishing a release:

1. configure Apple Developer ID signing and notarization credentials in the protected release environment;
2. verify the `.app` with `codesign --verify --deep --strict` and Gatekeeper after notarization/stapling;
3. sign Windows installers with the organization’s protected Authenticode certificate and verify them with `signtool verify /pa` on the Windows runner;
4. publish checksums, the platform SBOM, and third-party notices beside every installer;
5. retain the exact source revision and locked dependency files used by the build.

Unsigned or unnotarized desktop artifacts must be labelled development builds and must not be promoted as a release. Signing credentials never belong in the repository or application logs.

## Runtime diagnostics

- **Project menu:** shows the active project root, manuscript path, save/recovery state, and external-change conflicts.
- **Execution environments:** reports Python, R, Julia, and Jupyter discovery separately, including executable/version or an actionable missing/unhealthy message. Trust is session-only and revocable.
- **Execution output:** reports provider, runtime identity/version, run state, hashes, stale/environment-changed state, stdout/stderr, artifacts, and retained-manifest availability.
- **History:** reports system Git availability/version, repository root, project prefix, branch/upstream/ahead/behind, staged and working changes, conflicts, and bounded source/rendered diffs.
- **External export:** reports installed Pandoc/Quarto versions, the exact project-relative output path, overwrite conflicts, and bounded renderer failures.
- **Citations:** reports local Zotero availability, Crossref/offline failures, citation-lock conflicts, and cached metadata state without logging manuscript content or credentials.
- **Collaboration:** reports sign-in/discovery failures, live/reconnecting state, active presence, pending owner checkpoint state, invitation/member activity, and named recovery status. Access, refresh, and invitation tokens remain memory-only and are absent from public metrics/logs.

## Privilege and data boundaries

- Tauri exposes fixed typed commands; there is no arbitrary shell command bridge.
- Project paths reject absolute paths, traversal, and platform prefixes.
- Git uses fixed argument lists, bounded/redacted diagnostics, disabled repository hooks and filesystem monitors, no force/rewrite/discard operation, fast-forward-only pull, and explicit push.
- External renderers accept only a clean projection. Quarto uses `quarto pandoc`, not `quarto render`; DraftMatter execution classes are removed before process launch.
- Native HTML escapes raw HTML, rejects active asset schemes, contains no scripts, and is governed by the desktop CSP while inside DraftMatter.
- Native DOCX contains resolved clean content and does not claim Word tracked-change round-trip. Relative figure paths produce a visible diagnostic.
- Opening and reopening never executes code, initializes Git, changes branches, contacts remotes, or runs an external renderer.

Any future capability that broadens filesystem, process, network, or browser privileges requires a new typed command, threat review, negative capability test, and release-note entry.

#!/usr/bin/env bash
set -euo pipefail

target="${1:?macOS Rust target required}"
bundle_dir="${2:?Tauri bundle directory required}"
case "$target" in
  aarch64-apple-darwin) arch=aarch64 ;;
  x86_64-apple-darwin) arch=x64 ;;
  *) echo "Unsupported macOS target: $target" >&2; exit 1 ;;
esac
version="${GITHUB_REF_NAME#v}"
app="$bundle_dir/macos/DraftMatter.app"
dmg="$bundle_dir/dmg/DraftMatter_${version}_${arch}.dmg"
asset="DraftMatter_${version}_darwin_${arch}_dmg.dmg"
work_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/draftmatter-notary.XXXXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

# Tauri notarizes and staples the app, but only signs the enclosing DMG.
codesign --verify --deep --strict --verbose=2 "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=2 "$app"
codesign --verify --strict --verbose=2 "$dmg"
xcrun notarytool submit "$dmg" --wait --output-format json \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_PASSWORD" > "$work_dir/submission.json"
node -e '
  const { id, status } = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
  if (status !== "Accepted") {
    console.error("Notarization request %s has status %s", id, status)
    process.exitCode = 1
  }
' "$work_dir/submission.json"
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"

# The action uploaded the signed DMG before its ticket existed. Replace those
# bytes only on a draft, then verify the actual download before checksumming it.
if [[ "$(gh release view "$GITHUB_REF_NAME" --json isDraft --jq .isDraft)" != true ]]; then
  echo "Refusing to replace a DMG outside a draft release." >&2
  exit 1
fi
cp "$dmg" "$work_dir/$asset"
gh release upload "$GITHUB_REF_NAME" "$work_dir/$asset" --clobber
gh release download "$GITHUB_REF_NAME" --pattern "$asset" --dir "$work_dir/readback"
cmp "$dmg" "$work_dir/readback/$asset"

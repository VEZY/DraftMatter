#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

dmgs=("${1:?Expected the DMG bundle directory}"/*.dmg)
if [[ ${#dmgs[@]} -ne 1 ]]; then
  echo "Expected one release DMG, found ${#dmgs[@]}." >&2
  exit 1
fi

mount_dir=$(mktemp -d "${TMPDIR:-/tmp}/draftmatter-dmg.XXXXXX")
original_device=$(stat -f '%d' "$mount_dir")
cleanup() {
  local status=$?
  trap - EXIT
  # Check the filesystem itself so cleanup also works if attach was interrupted.
  if [[ -d "$mount_dir" && $(stat -f '%d' "$mount_dir") != "$original_device" ]]; then
    hdiutil detach "$mount_dir" || hdiutil detach -force "$mount_dir" || status=1
  fi
  rmdir "$mount_dir" || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

hdiutil attach -readonly -nobrowse -mountpoint "$mount_dir" "${dmgs[0]}"
app="$mount_dir/DraftMatter.app"
if [[ ! -d "$app" || -L "$app" ]]; then
  echo "The DMG must contain DraftMatter.app at its root." >&2
  exit 1
fi
for name in draftmatter draftmatter-agent-host draftmatter-mcp; do
  executable="$app/Contents/MacOS/$name"
  if [[ ! -f "$executable" || -L "$executable" || ! -s "$executable" || ! -x "$executable" ]]; then
    echo "Expected a nonempty executable at Contents/MacOS/$name inside the DMG." >&2
    exit 1
  fi
done
codesign --verify --deep --strict "$app"
codesign --display --verbose=4 "$app" 2>&1 | grep -Fx 'Signature=adhoc'
if [[ -n ${2:-} ]]; then
  node scripts/verify-installed-desktop.mjs "$app/Contents/MacOS" "$2"
  expected=$(/usr/bin/plutil -extract bundle.macOS.bundleVersion raw src-tauri/tauri.release.conf.json)
  actual=$(/usr/bin/plutil -extract CFBundleVersion raw "$app/Contents/Info.plist")
  [[ "$actual" == "$expected" ]]
fi

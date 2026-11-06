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
codesign --verify --deep --strict "$app"
codesign --display --verbose=4 "$app" 2>&1 | grep -Fx 'Signature=adhoc'

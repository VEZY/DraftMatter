#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

bundle=$(cd "${1:?Expected the Linux bundle directory}" && pwd)
debs=("$bundle"/deb/*.deb)
images=("$bundle"/appimage/*.AppImage)
if [[ ${#debs[@]} -ne 1 || ${#images[@]} -ne 1 ]]; then
  echo "Expected one .deb and one .AppImage in $bundle." >&2
  exit 1
fi
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/draftmatter-linux.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
dpkg-deb -x "${debs[0]}" "$work/deb"
(cd "$work" && "${images[0]}" --appimage-extract 'usr/bin/draftmatter*' >/dev/null)
for root in "$work/deb" "$work/squashfs-root"; do
  for name in draftmatter draftmatter-agent-host draftmatter-mcp; do
    executable="$root/usr/bin/$name"
    if [[ ! -f "$executable" || -L "$executable" || ! -s "$executable" || ! -x "$executable" ]]; then
      echo "Expected a nonempty executable at $executable." >&2
      exit 1
    fi
  done
done

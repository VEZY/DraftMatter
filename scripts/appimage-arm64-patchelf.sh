#!/bin/sh
# Rewriting the ARM64 Bun executable's ELF layout breaks its embedded CLI.
# It uses system libraries and does not need an AppImage-relative RPATH.
if [ "$#" -eq 3 ] && [ "$1" = "--set-rpath" ]; then
  case "$3" in
    */usr/bin/draftmatter-mcp) exit 0 ;;
  esac
fi
exec /usr/bin/patchelf "$@"

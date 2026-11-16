#!/bin/sh
set -eu

fail() { printf '%s\n' "$1" >&2; exit 1; }
usage() { printf '%s\n' 'Usage: server-operator.sh RELEASE_DIRECTORY PRIVATE_RUNTIME_DIRECTORY {init|check|manifest|tls-check|tls-renew} [arguments...]'; }
if [ "$#" -eq 1 ] && [ "$1" = '--help' ]; then usage; exit 0; fi
[ "$#" -ge 3 ] || { usage >&2; exit 1; }
release_directory=$(CDPATH= cd -P -- "$1" && pwd) || fail 'The release directory does not exist.'
runtime_directory=$(CDPATH= cd -P -- "$2" && pwd) || fail 'Create the private runtime directory before preparation.'
operation=$3
shift 3
case "$release_directory$runtime_directory" in *','*) fail 'Directory paths containing commas are not supported by Docker bind mounts.';; esac
manifest="$release_directory/server-release.json"
[ -f "$manifest" ] && [ ! -L "$manifest" ] || fail 'The release manifest is missing or linked.'
[ -f "$release_directory/SHA256SUMS" ] || fail 'Verify and place the published SHA256SUMS beside server-release.json first.'
# Only the official image repository can be selected before Node validates the
# complete manifest. Never source an env file, eval JSON, or accept mutable tags.
operator_image=$(sed -nE 's/^[[:space:]]*"operator": "(ghcr\.io\/vezy\/draftmatter-operator@sha256:[a-f0-9]{64})",?$/\1/p' "$manifest")
prefix='ghcr.io/vezy/draftmatter-operator@sha256:'
case "$operator_image" in "$prefix"*) ;; *) fail 'The manifest does not identify the official operator image by digest.';; esac
digest=${operator_image#"$prefix"}
case "$digest" in ''|*[!0-9a-f]*) fail 'The operator digest is invalid or occurs more than once.';; esac
[ "${#digest}" -eq 64 ] || fail 'The operator image must have a full SHA-256 digest.'
# This verifies both the manifest and the downloaded release archive before any
# image is run. SHA256SUMS comes from the same explicitly selected GitHub release.
(cd "$release_directory" && sha256sum --check --strict SHA256SUMS) || fail 'Release checksums failed. Do not run these release files.'
case "$operation" in
  init) set -- scripts/install-server-release.mjs /bundle/server-release.json --directory "$runtime_directory" "$@" ;;
  check) set -- scripts/install-server-release.mjs /bundle/server-release.json --directory "$runtime_directory" --check "$@" ;;
  manifest) set -- scripts/check-server-release.mjs /bundle/server-release.json "$@" ;;
  tls-check) set -- scripts/renew-single-host-tls.mjs --env-file "$runtime_directory/runtime.env" --check "$@" ;;
  tls-renew) set -- scripts/renew-single-host-tls.mjs --env-file "$runtime_directory/runtime.env" "$@" ;;
  *) usage >&2; fail 'Unknown operator operation.' ;;
esac
run_docker() {
  if [ "$(id -u)" -eq 0 ]; then docker "$@"; else sudo docker "$@"; fi
}
run_docker run --rm --pull=always --platform linux/amd64 --network none \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$release_directory,dst=/bundle,readonly" \
  --mount "type=bind,src=$runtime_directory,dst=$runtime_directory" \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  "$operator_image" "$@"

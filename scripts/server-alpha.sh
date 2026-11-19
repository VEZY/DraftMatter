#!/bin/sh
set -eu
fail() { printf '%s\n' "$1" >&2; exit 1; }
[ "$#" -ge 3 ] || fail 'Usage: server-alpha.sh RELEASE_DIRECTORY PRIVATE_RUNTIME_DIRECTORY OPERATION [arguments...]'
[ "$(id -u)" -eq 0 ] || fail 'Run this operator through sudo on the VPS.'
[ -t 0 ] && [ -t 1 ] || fail 'An interactive terminal is required for private administrator authentication.'
dm_release=$(CDPATH= cd -P -- "$1" && pwd)
dm_runtime=$(CDPATH= cd -P -- "$2" && pwd)
shift 2
case "$dm_release$dm_runtime" in *','*) fail 'Directory paths must not contain commas.';; esac
[ -f "$dm_runtime/runtime.env" ] && [ ! -L "$dm_runtime/runtime.env" ] || fail 'A private runtime.env is required.'
dm_project=$(sed -nE 's/^COMPOSE_PROJECT_NAME="([a-z0-9][a-z0-9_-]{0,62})"$/\1/p' "$dm_runtime/runtime.env")
case "$dm_project" in ''|*[!a-z0-9_-]*) fail 'Expected one validated Compose project name.';; esac
dm_operator=$(sed -nE 's/^[[:space:]]*"operator": "(ghcr\.io\/vezy\/draftmatter-operator@sha256:[a-f0-9]{64})",?$/\1/p' "$dm_release/server-release.json")
case "$dm_operator" in ghcr.io/vezy/draftmatter-operator@sha256:*) ;; *) fail 'Expected an official operator image pinned by digest.';; esac
dm_digest=${dm_operator##*:}
[ "${#dm_digest}" -eq 64 ] || fail 'Expected one complete operator digest.'
case "$dm_digest" in *[!a-f0-9]*) fail 'Invalid operator digest.';; esac
(cd "$dm_release" && sha256sum --check --strict SHA256SUMS) || fail 'Release checksums failed.'
if [ "$1" = stage ]; then
  shift
  exec docker run --rm --pull=always --platform linux/amd64 --network none \
    --read-only --cap-drop ALL --security-opt no-new-privileges --user 0:0 \
    --memory 128m --pids-limit 64 \
    --mount "type=bind,src=$dm_runtime,dst=$dm_runtime" \
    --mount "type=bind,src=$dm_release,dst=/bundle,readonly" \
    --tmpfs /tmp:rw,noexec,nosuid,size=16m \
    "$dm_operator" scripts/stage-alpha-registration.mjs \
    --directory "$dm_runtime" --manifest /bundle/server-release.json "$@"
fi
# identity is private. frontend permits outbound TLS SMTP and the live-gate
# check; neither network publishes an administrator port to the host/internet.
exec docker run --rm -it --pull=always --platform linux/amd64 \
  --network "${dm_project}_identity" --network "${dm_project}_frontend" \
  --read-only --cap-drop ALL --security-opt no-new-privileges --user 0:0 \
  --memory 128m --pids-limit 64 \
  --mount "type=bind,src=$dm_runtime,dst=/runtime" \
  --mount "type=bind,src=$dm_release,dst=/bundle,readonly" \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  "$dm_operator" deploy/single-host/keycloak/alpha-cli.mjs "$@"

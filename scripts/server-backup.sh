#!/bin/sh
# Docker administrator access is intentional here. Install/run only reviewed code.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin
export PATH
unset DOCKER_CONFIG DOCKER_CONTEXT DOCKER_HOST DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION

fail() { printf '%s\n' "$1" >&2; exit 1; }
usage() { printf '%s\n' 'Usage: sudo sh server-backup.sh RELEASE_DIRECTORY PRIVATE_RUNTIME_DIRECTORY ARCHIVE_DIRECTORY {create|prune}'; }
if [ "$#" -eq 1 ] && [ "$1" = '--help' ]; then usage; exit 0; fi
[ "$#" -eq 4 ] || { usage >&2; exit 1; }
case "$4" in create|prune) operation=$4 ;; *) usage >&2; fail 'Only create and prune are supported; this launcher never restores a live deployment.' ;; esac
[ "$(id -u)" -eq 0 ] || fail 'Run this reviewed backup launcher with sudo; Docker access is administrator-equivalent.'
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || fail 'This launcher requires the Linux amd64 VPS. Run the Mac pull helper on macOS.'

# A root scheduler must not execute or feed Docker configuration from a normal
# deploy account's writable checkout. Check every ancestor too: a protected
# file inside a replaceable parent is not a protected root input.
check_root_path() {
  dm_check_path=$1
  case "$dm_check_path" in /*) ;; *) fail 'Root backup inputs must use absolute protected paths.' ;; esac
  case "$dm_check_path" in *'/../'*|*'/./'*|*'//'*) fail 'Root backup inputs must use normalized protected paths.' ;; esac
  case "$dm_check_path" in /) ;; */) fail 'Root backup inputs must use normalized protected paths without a trailing slash.' ;; esac
  while :; do
    [ -e "$dm_check_path" ] && [ ! -L "$dm_check_path" ] || fail 'Root backup inputs and their ancestors must exist without symbolic links.'
    dm_check_metadata=$(stat -c '%u %a' -- "$dm_check_path" 2>/dev/null) || fail 'Could not verify root backup input ownership.'
    set -- $dm_check_metadata
    [ "$#" -eq 2 ] && [ "$1" = 0 ] || fail 'Root backup inputs and all ancestors must be owned by root.'
    case "$2" in ''|*[!0-7]*) fail 'Root backup input permissions are invalid.' ;; esac
    [ "$((0$2 & 022))" -eq 0 ] || fail 'Root backup inputs and all ancestors must not be group/world writable.'
    [ "$dm_check_path" != / ] || break
    dm_check_path=$(dirname -- "$dm_check_path")
  done
}
check_root_file() {
  [ -f "$1" ] && [ ! -L "$1" ] || fail 'A protected root backup input file is missing or linked.'
  check_root_path "$1"
  [ "$(stat -c %h -- "$1" 2>/dev/null)" = 1 ] || fail 'Protected root backup files must not have multiple hard links.'
}

dm_launcher=$(readlink -f -- "$0") || fail 'Could not resolve the installed root backup launcher.'
check_root_file "$dm_launcher"
check_root_path "$1"
check_root_path "$2"
check_root_path "$3"
release_directory=$(CDPATH= cd -P -- "$1" && pwd) || fail 'The checked release directory does not exist.'
runtime_directory=$(CDPATH= cd -P -- "$2" && pwd) || fail 'The private runtime directory does not exist.'
[ -d "$3" ] && [ ! -L "$3" ] || fail 'Create a private dedicated archive directory first, without directory links.'
archive_directory=$(CDPATH= cd -P -- "$3" && pwd) || fail 'The archive directory does not exist.'
case "$release_directory$runtime_directory$archive_directory" in *','*|*'
'*) fail 'Bind-mount paths cannot contain commas or newlines.' ;; esac
[ "$archive_directory" != "$runtime_directory" ] && [ "$archive_directory" != "$release_directory" ] || fail 'Archives must have their own dedicated directory.'
bundle="$release_directory/draftmatter-server"
manifest="$release_directory/server-release.json"
for dm_file in "$manifest" "$release_directory/SHA256SUMS" \
  "$bundle/deploy/single-host/backup/backup.mjs" "$bundle/deploy/single-host/backup/crypto.mjs"; do
  check_root_file "$dm_file"
done
if [ "$operation" = create ]; then
  for dm_file in "$bundle/deploy/single-host/compose.yaml" "$bundle/deploy/single-host/prebuilt.yaml" \
    "$bundle/deploy/single-host/initialize-volumes.sh" "$bundle/deploy/single-host/postgres/init.sh" "$bundle/deploy/single-host/postgres/pg_hba.conf" \
    "$runtime_directory/runtime.env" "$runtime_directory/release.env" "$runtime_directory/backup.key" \
    "$runtime_directory/Caddyfile" "$runtime_directory/realm.json" "$runtime_directory/s3.json"; do
    check_root_file "$dm_file"
  done
  check_root_path "$runtime_directory/tls"
  dm_unsafe_tls=$(find "$runtime_directory/tls" -mindepth 1 \( ! -uid 0 -o -perm /022 -o -type l -o \( -type f -a -links +1 \) -o \( ! -type f -a ! -type d \) \) -print -quit) || fail 'Could not verify the protected TLS input tree.'
  [ -z "$dm_unsafe_tls" ] || fail 'TLS inputs must be root-owned ordinary files/directories, without writable permissions or links.'
fi
[ -f "$manifest" ] && [ ! -L "$manifest" ] || fail 'The release manifest is missing or linked.'
[ -f "$release_directory/SHA256SUMS" ] && [ ! -L "$release_directory/SHA256SUMS" ] || fail 'The published release checksums are missing or linked.'
[ -f "$bundle/deploy/single-host/backup/backup.mjs" ] && [ ! -L "$bundle/deploy/single-host/backup/backup.mjs" ] || fail 'The reviewed release backup helper is missing or linked.'
operator_image=$(sed -nE 's/^[[:space:]]*"operator": "(ghcr\.io\/vezy\/draftmatter-operator@sha256:[a-f0-9]{64})",?$/\1/p' "$manifest")
prefix='ghcr.io/vezy/draftmatter-operator@sha256:'
case "$operator_image" in "$prefix"*) ;; *) fail 'The release must select the official operator image by immutable digest.' ;; esac
digest=${operator_image#"$prefix"}
case "$digest" in ''|*[!0-9a-f]*) fail 'The operator image digest is invalid or repeated.' ;; esac
[ "${#digest}" -eq 64 ] || fail 'The operator image must have a full SHA-256 digest.'
(cd "$release_directory" && sha256sum --check --strict --status SHA256SUMS) || fail 'Release checksums failed; no backup action was run.'
docker_cli=$(command -v docker) || fail 'Docker CLI is required on the VPS.'
docker_cli=$(readlink -f -- "$docker_cli") || fail 'Docker CLI must resolve to a regular executable.'
[ -f "$docker_cli" ] && [ -x "$docker_cli" ] || fail 'Docker CLI must resolve to a regular executable.'
check_root_file "$docker_cli"
# Docker discovers plugins before returning client metadata. Never let an
# inherited HOME or sudo -E configuration supply a user-controlled plugin.
dm_docker_config=/var/lib/draftmatter-backup/docker-config
check_root_path "$dm_docker_config"
[ -d "$dm_docker_config" ] && [ "$(stat -c %a -- "$dm_docker_config")" = 700 ] || fail 'Create the private empty root Docker client configuration directory first (chmod 700).'
dm_docker_config_contents=$(find "$dm_docker_config" -mindepth 1 -print -quit) || fail 'Could not verify the root Docker client configuration directory.'
[ -z "$dm_docker_config_contents" ] || fail 'The backup Docker client configuration directory must remain empty.'
socket='unix:///var/run/docker.sock'
platform=$("$docker_cli" --config "$dm_docker_config" --host "$socket" image inspect --format '{{.Os}}/{{.Architecture}}' "$operator_image" 2>/dev/null) || fail 'The checked operator image is not cached. Pull the reviewed digest manually; a scheduled backup never depends on registry availability.'
[ "$platform" = linux/amd64 ] || fail 'The cached operator image must be Linux amd64.'

set -- run --rm --pull=never --platform linux/amd64 --network none \
  --read-only --cap-drop ALL --security-opt no-new-privileges --user 0:0 \
  --mount "type=bind,src=$release_directory,dst=$release_directory,readonly" \
  --mount "type=bind,src=$archive_directory,dst=$archive_directory" \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m

if [ "$operation" = create ]; then
  # No host Node installation or general Docker-enabled application container.
  # Bind the existing Linux CLI/plugin read-only into the pinned Node operator.
  compose_plugin=$("$docker_cli" --config "$dm_docker_config" --host "$socket" info --format '{{range .ClientInfo.Plugins}}{{if eq .Name "compose"}}{{println .Path}}{{end}}{{end}}' 2>/dev/null) || fail 'Could not discover the installed Docker Compose plugin.'
  [ -n "$compose_plugin" ] || fail 'Docker Compose plugin is required.'
  case "$compose_plugin" in /*) ;; *) fail 'Docker Compose plugin must have an absolute path.' ;; esac
  case "$compose_plugin" in *','*|*'
'*) fail 'Docker Compose plugin path contains unsupported characters.' ;; esac
  compose_plugin=$(readlink -f -- "$compose_plugin") || fail 'Docker Compose plugin could not be resolved.'
  [ -f "$compose_plugin" ] && [ -x "$compose_plugin" ] || fail 'Docker Compose plugin must be a regular executable.'
  check_root_file "$compose_plugin"
  set -- "$@" \
    --mount "type=bind,src=$docker_cli,dst=/usr/local/bin/docker,readonly" \
    --mount "type=bind,src=$compose_plugin,dst=/usr/local/lib/docker/cli-plugins/docker-compose,readonly" \
    --mount 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock' \
    --mount "type=bind,src=$runtime_directory,dst=$runtime_directory,readonly" \
    --env DOCKER_HOST=unix:///var/run/docker.sock --env DOCKER_CONFIG=/tmp/draftmatter-docker \
    "$operator_image" "$bundle/deploy/single-host/backup/backup.mjs" create \
    --env-file "$runtime_directory/runtime.env" --release-env-file "$runtime_directory/release.env" \
    --compose-file "$bundle/deploy/single-host/compose.yaml" --prebuilt-compose-file "$bundle/deploy/single-host/prebuilt.yaml" \
    --project draftmatter-alpha-production --directory "$archive_directory" --key-file "$runtime_directory/backup.key" --max-copies 2
else
  # Expiry is independent of successful backup creation and needs no Docker
  # socket, runtime.env, application credentials or encryption key in the worker.
  set -- "$@" "$operator_image" "$bundle/deploy/single-host/backup/backup.mjs" prune \
    --directory "$archive_directory" --retention-days 29
fi

exec "$docker_cli" --config "$dm_docker_config" --host "$socket" "$@"

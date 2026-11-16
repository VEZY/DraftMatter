#!/bin/sh
set -eu
node /opt/draftmatter/deploy/production/public-config.mjs
exec "$@"

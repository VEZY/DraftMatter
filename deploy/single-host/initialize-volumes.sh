#!/bin/sh
set -eu
mkdir -p /certificates
cp /source/ca.crt /source/postgres.crt /source/postgres.key /source/objects.crt /source/objects.key /certificates/
chown root:root /certificates/*.crt
chmod 644 /certificates/*.crt
chown root:70 /certificates/postgres.key
chown root:1000 /certificates/objects.key
chmod 640 /certificates/*.key
if [ -f /source/public.crt ]; then
  cp /source/public.crt /source/public.key /certificates/
  chown root:root /certificates/public.crt
  chmod 644 /certificates/public.crt
  chown root:1000 /certificates/public.key
  chmod 640 /certificates/public.key
fi
chown 1000:1000 /object-data
chmod 700 /object-data

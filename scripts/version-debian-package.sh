#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

debs=("${1:?Expected the deb bundle directory}"/*.deb)
[[ ${#debs[@]} -eq 1 ]]
package=${debs[0]}
version=${DESKTOP_RELEASE_VERSION:-$(node -p 'require("./package.json").version')}
actual=$(dpkg-deb -f "$package" Version)
[[ $actual == "$version" ]]
if [[ $version != *-* ]]; then exit 0; fi

# A Debian tilde sorts before the final release. The semver string remains
# the version reported by the application and in public download names.
debian_version=${version/-/\~}
work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/dm-deb.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
dpkg-deb -R "$package" "$work/pkg"
sed -i "s/^Version: .*/Version: $debian_version/" "$work/pkg/DEBIAN/control"
dpkg-deb --root-owner-group --build "$work/pkg" "$work/versioned.deb"
[[ $(dpkg-deb -f "$work/versioned.deb" Version) == "$debian_version" ]]
dpkg --compare-versions "$debian_version" lt "${version%%-*}"
mv -- "$work/versioned.deb" "$package"

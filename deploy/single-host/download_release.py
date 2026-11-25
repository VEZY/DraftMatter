#!/usr/bin/env python3
"""Install a verified DraftMatter server release in the VPS release cache."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import tempfile


RELEASES = Path("/usr/local/lib/draftmatter/releases")
ORIGIN = "https://github.com/VEZY/DraftMatter/releases/download"
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:alpha|beta|rc)\.[0-9]+)?")
MANIFEST = "server-release.json"
BUNDLE = "draftmatter-server"
ARCHIVE_LIMIT = 32 * 1024 * 1024


def trusted(path, *, directory=False):
    info = path.lstat()
    valid_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1
    forbidden_mode = 0o022 if directory else 0o6022
    if not valid_type or info.st_uid != os.geteuid() or info.st_mode & forbidden_mode:
        raise ValueError(f"Unsafe ownership, type or mode at {path}")
    return info


def fetch(url, path, limit):
    subprocess.run([
        "curl", "--disable", "--fail", "--silent", "--show-error", "--location",
        "--proto", "=https", "--proto-redir", "=https", "--tlsv1.2",
        "--connect-timeout", "10", "--max-time", "180", "--retry", "2",
        "--max-filesize", str(limit), "--output", str(path), url,
    ], check=True)


def asset_limits(version):
    return {"SHA256SUMS": 1024, MANIFEST: 16 * 1024, f"draftmatter-server-{version}.tar.gz": ARCHIVE_LIMIT}


def verify_assets(folder, version):
    archive = f"draftmatter-server-{version}.tar.gz"
    for name, limit in asset_limits(version).items():
        if trusted(folder / name).st_size > limit:
            raise ValueError(f"Release asset too large: {name}")
    expected = {}
    for line in (folder / "SHA256SUMS").read_text("ascii").splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  ([^/]+)", line)
        if not match or match[2] not in (archive, MANIFEST) or match[2] in expected:
            raise ValueError("Invalid release checksum list")
        expected[match[2]] = match[1]
    if set(expected) != {archive, MANIFEST}:
        raise ValueError("Release checksum list must cover the archive and manifest")
    for name, checksum in expected.items():
        if hashlib.sha256((folder / name).read_bytes()).hexdigest() != checksum:
            raise ValueError(f"Checksum mismatch for {name}")
    manifest = json.loads((folder / MANIFEST).read_bytes())
    if not isinstance(manifest, dict) or manifest.get("version") != version or manifest.get("platform") != "linux/amd64":
        raise ValueError("Release manifest does not match the selected version and platform")
    return folder / archive


def unpack_or_compare(folder, archive, cached):
    # Only ordinary files beneath the bundle root are part of the publication format.
    seen = set()
    total_size = 0
    with tarfile.open(archive, "r|gz") as tar:
        for member in tar:
            parts = member.name.split("/")
            if (parts[0] != BUNDLE or any(p in ("", ".", "..") for p in parts)
                    or member.name in seen or len(seen) >= 4096):
                raise ValueError("Invalid or repeated path in release archive")
            if len(parts) > 1 and "/".join(parts[:-1]) not in seen:
                raise ValueError("Missing parent directory in release archive")
            seen.add(member.name)
            path = folder / member.name
            if member.isdir():
                if cached:
                    trusted(path, directory=True)
                else:
                    path.mkdir(mode=0o755)
            elif member.type in (tarfile.REGTYPE, tarfile.AREGTYPE):
                total_size += member.size
                if member.size < 0 or total_size > 128 * 1024 * 1024:
                    raise ValueError("Expanded release exceeds its size limit")
                with tar.extractfile(member) as stream:
                    data = stream.read()
                if cached:
                    if trusted(path).st_size != len(data) or path.read_bytes() != data:
                        raise ValueError(f"Installed file differs from the verified release: {member.name}")
                else:
                    with path.open("xb") as output:
                        output.write(data)
                    path.chmod(0o755 if member.mode & 0o111 else 0o644)
            else:
                raise ValueError("Links and special files are not allowed in the release")
    if f"{BUNDLE}/{MANIFEST}" not in seen or (folder / BUNDLE / MANIFEST).read_bytes() != (folder / MANIFEST).read_bytes():
        raise ValueError("Embedded and downloaded release manifests differ")
    if cached:
        for parent, dirs, files in os.walk(folder / BUNDLE):
            for name in dirs + files:
                if str((Path(parent) / name).relative_to(folder)) not in seen:
                    raise ValueError(f"Unexpected file in installed release: {name}")


def install(base, version, download=fetch):
    if len(version) > 100 or not VERSION.fullmatch(version):
        raise ValueError("Choose an exact server version such as 0.1.0-alpha.7")
    trusted(base, directory=True)
    fd = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        target = base / version
        if os.path.lexists(target):
            trusted(target, directory=True)
            unpack_or_compare(target, verify_assets(target, version), cached=True)
            return target
        with tempfile.TemporaryDirectory(prefix=".download-", dir=base) as temp:
            folder = Path(temp) / version
            folder.mkdir(mode=0o755)
            for name, limit in asset_limits(version).items():
                download(f"{ORIGIN}/server-v{version}/{name}", folder / name, limit)
            unpack_or_compare(folder, verify_assets(folder, version), cached=False)
            folder.rename(target)
        return target
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Run the downloader with sudo on the VPS")
    try:
        for directory in [*reversed(RELEASES.parents), RELEASES]:
            if not os.path.lexists(directory):
                directory.mkdir(mode=0o755, exist_ok=True)
            trusted(directory, directory=True)
        print(install(RELEASES, args.version))
    except (OSError, ValueError, tarfile.TarError, EOFError, subprocess.CalledProcessError) as error:
        sys.exit(f"Release download or verification failed: {error}")


if __name__ == "__main__":
    main()

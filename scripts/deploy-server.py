#!/usr/bin/env python3
"""Update an existing DraftMatter VPS over SSH to an explicit server release."""

import argparse
import base64
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import zlib


REPOSITORY = Path(__file__).resolve().parents[1]
TOOLS = REPOSITORY / "deploy" / "single-host"
HELPERS = ("download_release.py", "stage_update.py", "upgrade_checks.py", "upgrade.py")
# SSH uses a remote shell for the command; quote each argument exactly once.
# Only these four public tools cross the connection. The version and options
# are passed as argv to upgrade.py and sudo reads its password from the TTY.
BOOTSTRAP = """
import base64, json, pathlib, subprocess, sys, tempfile, zlib
helpers = json.loads(zlib.decompress(base64.b64decode(sys.argv[1], validate=True)))
names = ("download_release.py", "stage_update.py", "upgrade_checks.py", "upgrade.py")
if set(helpers) != set(names):
    sys.exit("Incomplete deployment tools")
with tempfile.TemporaryDirectory(prefix="draftmatter-deploy-", dir="/run") as directory:
    root = pathlib.Path(directory)
    for name in names:
        (root / name).write_text(helpers[name], encoding="utf-8")
    status = subprocess.call(["/usr/bin/python3", "-I", "-B", str(root / "upgrade.py"), *sys.argv[2:]])
sys.exit(status)
"""


def pack_helpers(directory):
    helpers = {}
    for name in HELPERS:
        path = directory / name
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 128 * 1024:
            raise ValueError(f"Expected a regular deployment helper: {name}")
        helpers[name] = path.read_text(encoding="utf-8")
    packed = base64.b64encode(zlib.compress(json.dumps(helpers).encode(), 9)).decode("ascii")
    if len(packed) > 96 * 1024:
        raise ValueError("Deployment tools exceed the SSH command size limit")
    return packed


def local_setting(key):
    if not (REPOSITORY / ".git").exists():
        return None
    result = subprocess.run(
        ["git", "-C", str(REPOSITORY), "config", "--local", "--no-includes", "--get", key],
        capture_output=True, text=True,
        env={k: v for k, v in os.environ.items() if not k.startswith("GIT_")},
    )
    if result.returncode == 1:  # No value in this repository.
        return None
    if result.returncode != 0:
        raise ValueError(f"Could not read {key} from local Git configuration")
    return result.stdout.removesuffix("\n") or None


def ssh_command(host, identity, packed, version, check):
    if not re.fullmatch(r"(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?(?:[A-Za-z0-9_:][A-Za-z0-9_.:-]*|\[[0-9A-Fa-f:]+\])", host):
        raise ValueError("Use an SSH alias, hostname or user@host for --host")
    remote = ["/usr/bin/sudo", "--", "/usr/bin/python3", "-I", "-B", "-c", BOOTSTRAP, packed, version]
    if check:
        remote.append("--check")
    ssh = ["ssh", "-t", "-o", "StrictHostKeyChecking=yes", "-o", "ClearAllForwardings=yes",
           "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ControlPath=none"]
    if identity:
        ssh.extend(["-o", "IdentitiesOnly=yes", "-i", str(Path(identity).expanduser())])
    return [*ssh, "--", host, shlex.join(remote)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", help="published server version, for example 0.1.0-alpha.7")
    parser.add_argument("--host", help="SSH destination (defaults: DRAFTMATTER_SSH_HOST, "
                        "local Git draftmatter.deployHost, then draftmatter-vps)")
    parser.add_argument("--identity", metavar="PATH", help="SSH identity file (default: local Git draftmatter.deployIdentity)")
    parser.add_argument("--check", action="store_true", help="check the upgrade without activating it")
    args = parser.parse_args()
    try:
        if len(args.version) > 100 or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-(?:alpha|beta|rc)\.[0-9]+)?", args.version):
            raise ValueError("Choose an exact published server version")
        host = args.host or os.getenv("DRAFTMATTER_SSH_HOST") or local_setting("draftmatter.deployHost") or "draftmatter-vps"
        identity = args.identity or local_setting("draftmatter.deployIdentity")
        command = ssh_command(host, identity, pack_helpers(TOOLS), args.version, args.check)
        return subprocess.call(command)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Could not start the deployment: {error}\n")


if __name__ == "__main__":
    sys.exit(main())

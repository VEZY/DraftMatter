#!/usr/bin/env python3
"""Upgrade the two application services of an existing DraftMatter alpha on Linux."""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import sys
import tempfile
import time
import uuid

# -I excludes the script directory. Only load siblings from this operator bundle.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from download_release import RELEASES, VERSION, install, trusted
from stage_update import stage
from upgrade_checks import check_compatible, check_migrations, public_ready

RUNTIME = Path("/etc/draftmatter")
ARCHIVES = Path("/var/backups/draftmatter")
PENDING = ".upgrade-in-progress"
PROJECT = "draftmatter-alpha-production"
FILES = ("runtime.env", "release.env", "realm.json")
SCHEDULE = "backup-schedule.env"
APPS = ("edge", "collaboration")


def fail(message):
    raise RuntimeError(message)


def run(args, capture=False):
    # Compose config contains secrets. Never echo its output, even on failure.
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.DEVNULL if capture else None)
    if result.returncode:
        fail(f"{Path(args[0]).name} failed (exit {result.returncode}).")
    return result.stdout.strip() if capture else None


def compose(release, env_dir, *args, capture=False):
    base = release / "draftmatter-server/deploy/single-host"
    return run(["docker", "compose", "-p", PROJECT, "--env-file", env_dir / "runtime.env",
                "--env-file", env_dir / "release.env", "-f", base / "compose.yaml",
                "-f", base / "prebuilt.yaml", *args], capture)


def manifest(release):
    return json.loads((release / "server-release.json").read_bytes())


def field(path, name):
    # Read only generated, single-line settings by name. Other dotenv values stay private.
    values = re.findall(rb'^' + name.encode() + rb'="([^"\r\n]+)"\r?$', path.read_bytes(), re.M)
    if len(values) != 1:
        fail(f"Expected one generated {name} in {path.name}.")
    return values[0].decode("ascii")


def installed_release(runtime):
    commit = field(runtime / "release.env", "RELEASE_ID")
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        fail("Invalid installed source revision.")
    matches = []
    for folder in RELEASES.iterdir():
        if VERSION.fullmatch(folder.name) and folder.is_dir() and not folder.is_symlink():
            path = folder / "server-release.json"
            if path.is_file():
                trusted(path)
                if manifest(folder)["commit"] == commit:
                    matches.append(folder.name)
    if len(matches) != 1:
        fail("Could not match the installed revision to one release in the VPS cache.")
    return install(RELEASES, matches[0])


def public_settings(runtime):
    path = runtime / "runtime.env"
    origins = tuple(field(path, name) for name in ("APP_ORIGIN", "COLLABORATION_ORIGIN", "AUTH_ORIGIN"))
    orcid = [line for line in path.read_bytes().splitlines() if line.startswith(b'DM_ORCID_LINKING_ENABLED=')]
    return (*origins, field(path, "DM_ALPHA_REGISTRATION_ENABLED") == "true",
            bool(orcid) and field(path, "DM_ORCID_LINKING_ENABLED") == "true")


def verify_running(release, runtime):
    images = manifest(release)["images"]
    for service, image in (("edge", images["web"]), ("collaboration", images["collaboration"])):
        container = compose(release, runtime, "ps", "-q", service, capture=True)
        if not re.fullmatch("[0-9a-f]{12,64}", container):
            fail(f"Expected one running {service} container.")
        expected = run(["docker", "image", "inspect", "--format", "{{.Id}}", image], True)
        actual = run(["docker", "inspect", "--format", "{{.Config.Image}} {{.Image}} {{.State.Running}}", container], True)
        if actual != f"{image} {expected} true":
            fail(f"The running {service} image differs from {release.name}.")
    settings = public_settings(runtime)
    for attempt in range(8):
        try:
            public_ready(*settings)
            return
        except RuntimeError:
            if attempt == 7:
                raise
            time.sleep(3)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def copy_file(source, target):
    # Preserve generated file modes and always replace a whole file, even after interruption.
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as temp:
        name = Path(temp.name)
        try:
            os.fchmod(temp.fileno(), source.stat().st_mode & 0o777)
            temp.write(source.read_bytes())
            temp.flush()
            os.fsync(temp.fileno())
            os.replace(name, target)
            sync_dir(target.parent)
        finally:
            name.unlink(missing_ok=True)


def schedule(runtime, saved, prepared, target):
    source = runtime / SCHEDULE
    if not os.path.lexists(source):
        return
    trusted(source)
    content = source.read_bytes()
    match = re.fullmatch(rb'DM_BACKUP_RELEASE_DIRECTORY=([^\r\n]+)\n?', content)
    if not match or Path(os.fsdecode(match[1])).parent != RELEASES or not VERSION.fullmatch(Path(os.fsdecode(match[1])).name):
        print("Custom backup schedule retained. Review its release directory separately.", flush=True)
        return
    copy_file(source, saved / SCHEDULE)
    (prepared / SCHEDULE).write_text(f"DM_BACKUP_RELEASE_DIRECTORY={target}\n")


@contextmanager
def exclude_backup(archives, token):
    # The shipped backup/prune workers acquire this exact exclusive directory entry.
    # A unique durable token lets recovery identify our own interrupted lock.
    lock = archives / ".lock"
    marker = ("release-upgrade-" + token + "\n").encode("ascii")
    with tempfile.NamedTemporaryFile(dir=archives) as handle:
        handle.write(marker)
        handle.flush()
        try:
            os.link(handle.name, lock)
        except FileExistsError:
            if lock.is_symlink() or not lock.is_file() or lock.read_bytes() != marker:
                fail("A backup or expiry check holds the archive lock. Retry when it finishes.")
    try:
        yield
    finally:
        if lock.read_bytes() == marker:
            lock.unlink()


def operator_check(release, runtime):
    # The old operator is already cached for backups. Staging pulls the new one.
    operator = manifest(release)["images"]["operator"]
    run(["docker", "run", "--rm", "--pull=never", "--platform", "linux/amd64", "--network", "none",
         "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "0:0",
         "--mount", f"type=bind,src={release},dst=/bundle,readonly",
         "--mount", f"type=bind,src={runtime},dst={runtime},readonly", "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m",
         operator, "scripts/install-server-release.mjs", "/bundle/server-release.json", "--directory", runtime, "--check"])


def activate(release, runtime, settings):
    for name in FILES:
        if (runtime / name).read_bytes() != (settings / name).read_bytes():
            copy_file(settings / name, runtime / name)
    operator_check(release, runtime)
    compose(release, runtime, "up", "-d", "--no-deps", "--no-build", "--pull", "never",
            "--wait", "--wait-timeout", "300", *APPS)
    verify_running(release, runtime)
    if (settings / SCHEDULE).exists():
        copy_file(settings / SCHEDULE, runtime / SCHEDULE)


def clear_pending(runtime):
    # Stop marking the transaction pending before cleaning up its private files.
    with tempfile.TemporaryDirectory(dir=runtime) as tmp:
        (runtime / PENDING).rename(Path(tmp) / "finished")
        sync_dir(runtime)


def recover(runtime, pending, target_version):
    record = json.loads((pending / "transaction.json").read_bytes())
    if record["target"] != target_version:
        fail(f"An interrupted upgrade to {record['target']} needs recovery. Rerun that version.")
    old = install(RELEASES, record["previous"])
    with exclude_backup(ARCHIVES, record["token"]):
        print(f"Recovering {old.name} after the interrupted switch.", flush=True)
        activate(old, runtime, pending / "saved")
    clear_pending(runtime)
    fail(f"Restored and checked {old.name}. Rerun to start a new upgrade.")


def upgrade(runtime, target_version, check_only):
    pending = runtime / PENDING
    if pending.exists():
        if check_only:
            fail("An interrupted switch is recorded. Run the deployment for its target version to recover.")
        recover(runtime, pending, target_version)
    for name in (*FILES, "Caddyfile"):
        trusted(runtime / name)
        if os.path.lexists(runtime / (name + ".next")):
            fail("Another update has staged .next files. Resolve that update first.")
    old = installed_release(runtime)
    print(f"Installed {old.name}. Checking its configuration and running services.", flush=True)
    operator_check(old, runtime)
    verify_running(old, runtime)
    if old.name == target_version:
        print(f"Already running verified {old.name}.", flush=True)
        return
    target = install(RELEASES, target_version)
    print(f"Preparing {old.name} → {target.name}.", flush=True)
    with tempfile.TemporaryDirectory(prefix=".prepare-upgrade-", dir=runtime) as tmp:
        transaction = Path(tmp) / "transaction"
        saved, prepared = transaction / "saved", transaction / "prepared"
        saved.mkdir(parents=True)
        prepared.mkdir()
        for name in (*FILES, "Caddyfile"):
            copy_file(runtime / name, saved / name)
        stage(runtime, old, target, prepared)
        old_compose = json.loads(compose(old, runtime, "config", "--format", "json", capture=True))
        new_compose = json.loads(compose(target, prepared, "config", "--format", "json", capture=True))
        check_compatible(old, target, old_compose, new_compose)
        compose(target, prepared, "pull", *APPS)
        check_migrations(manifest(old)["images"]["collaboration"], manifest(target)["images"]["collaboration"])
        schedule(runtime, saved, prepared, target)
        if check_only:
            print(f"Preflight passed for {target.name}.", flush=True)
            return
        print("Creating an encrypted recovery archive before switching.", flush=True)
        run(["sh", old / "draftmatter-server/scripts/server-backup.sh", old, runtime, ARCHIVES, "create"])
        verify_running(old, runtime)
        for path in saved.iterdir():
            if path.read_bytes() != (runtime / path.name).read_bytes():
                fail(f"{path.name} changed during preparation. Run the deployment again.")
        token = uuid.uuid4().hex
        record = dict(previous=old.name, target=target.name, token=token)
        (transaction / "transaction.json").write_text(json.dumps(record))
        # Persist staged files and recovery metadata before changing production.
        for directory in (saved, prepared, transaction):
            for path in directory.iterdir():
                if path.is_file():
                    with path.open("rb") as handle:
                        os.fsync(handle.fileno())
            sync_dir(directory)
        transaction.rename(pending)
        sync_dir(runtime)
        restored = False
        with exclude_backup(ARCHIVES, token):
            try:
                activate(target, runtime, pending / "prepared")
            except (Exception, KeyboardInterrupt) as error:
                print(f"Activation failed ({error}). Restoring {old.name}.", file=sys.stderr, flush=True)
                activate(old, runtime, pending / "saved")
                restored = True
        clear_pending(runtime)
        if restored:
            fail(f"Restored and checked {old.name} after activation failed.")
        print(f"Running verified {target.name} ({manifest(target)['commit']}).", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if not VERSION.fullmatch(args.version) or len(args.version) > 100:
        parser.error("Provide an exact server version.")
    if platform.system() != "Linux" or platform.machine() != "x86_64" or os.geteuid() != 0:
        parser.error("Run with sudo on the Linux amd64 VPS.")
    os.umask(0o077)
    os.environ.clear()
    os.environ.update(PATH="/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bin", HOME="/root", LC_ALL="C.UTF-8")
    for directory in (RUNTIME, RELEASES, ARCHIVES):
        for parent in (*reversed(directory.parents), directory):
            trusted(parent, directory=True)
    if RUNTIME.stat().st_mode & 0o077 or ARCHIVES.stat().st_mode & 0o077:
        fail("Runtime and backup directories must be private.")
    def interrupted(signum, frame):
        raise InterruptedError(f"Received signal {signum}")
    for sig in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(sig, interrupted)
    with (RUNTIME / ".release-update.lock").open("a") as guard:
        try:
            fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("Another deployment is in progress.")
        upgrade(RUNTIME, args.version, args.check)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, KeyboardInterrupt) as error:
        print(f"Deployment stopped. {error}", file=sys.stderr)
        sys.exit(1)

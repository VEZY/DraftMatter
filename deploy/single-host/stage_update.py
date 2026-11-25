"""Prepare a routine update with the target release's offline operator."""

import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile


FILES = ("runtime.env", "release.env", "realm.json", "Caddyfile")
PROFILE = "org.keycloak.userprofile.UserProfileProvider"
HELP_TEXT = ("inputHelperTextBefore", "inputHelperTextAfter")


def read_file(path, limit, private=False):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1
                or info.st_mode & (0o077 if private else 0o022) or info.st_size > limit):
            raise ValueError(f"Unexpected ownership, permissions, type or size for {path.name}")
        contents = stream.read(limit + 1)
        if len(contents) > limit:
            raise ValueError(f"File exceeds size limit: {path.name}")
        return contents


def release_pins(directory):
    manifest = json.loads(read_file(directory / "server-release.json", 16 * 1024))
    commit = manifest.get("commit", "")
    if (manifest.get("platform") != "linux/amd64" or manifest.get("schemaVersion") != 1
            or not re.fullmatch("[0-9a-f]{40}", commit)):
        raise ValueError("Unexpected server release commit, platform or schema")
    lines = [f'RELEASE_ID="{commit}"']
    images = manifest["images"]
    for kind in ("collaboration", "web", "operator"):
        if not re.fullmatch(rf"ghcr\.io/vezy/draftmatter-{kind}@sha256:[0-9a-f]{{64}}", images.get(kind, "")):
            raise ValueError(f"Expected an official {kind} image digest")
        lines.append(f'DM_{kind.upper()}_IMAGE="{images[kind]}"')
    return commit.encode(), images["operator"], ("\n".join(lines) + "\n").encode()


def realm_without_name_help(source):
    realm = json.loads(source)
    profiles = realm["components"][PROFILE]
    if len(profiles) != 1 or len(profiles[0]["config"]["kc.user.profile.config"]) != 1:
        raise ValueError("Unexpected Keycloak user-profile configuration")
    settings = profiles[0]["config"]["kc.user.profile.config"]
    profile = json.loads(settings[0])
    for field in profile["attributes"]:
        if field.get("name") not in ("firstName", "lastName") or "annotations" not in field:
            continue
        annotations = field["annotations"]
        for key in HELP_TEXT:
            if key in annotations:
                if not isinstance(annotations[key], str):
                    raise ValueError("Unexpected Keycloak name help text")
                del annotations[key]
        if not annotations:
            del field["annotations"]
    settings[0] = profile
    return json.dumps(realm, sort_keys=True)


def stage(runtime: Path, old: Path, target: Path, workspace: Path):
    """Write four verified candidate files. Caller holds the deployment lock."""
    for directory in (runtime, workspace):
        info = directory.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o077 or directory != directory.resolve()):
            raise ValueError("Staging requires canonical private directories owned by the operator")
    if runtime == workspace or any(os.path.lexists(workspace / name) for name in FILES):
        raise ValueError("Staging requires unused candidate filenames outside the live configuration")
    previous, _, old_pins = release_pins(old)
    new, operator, new_pins = release_pins(target)
    source = read_file(runtime / "runtime.env", 256 * 1024, private=True)
    if read_file(runtime / "release.env", 16 * 1024, private=True) != old_pins:
        raise ValueError("Installed release.env differs from the selected previous release")

    # Only literal generated assignments are supported. The target operator
    # parses the full dotenv source and independently checks for ambiguities.
    assignments = (
        (b"RELEASE_ID", previous),
        (b"DM_ALPHA_REGISTRATION_ENABLED", b"true|false"),
        (b"DM_OIDC_REQUIRED_ALPHA_ROLE", b"draftmatter-alpha"),
        (b"DM_IDENTITY_ADMISSION_TOKEN", b"[a-f0-9]{64}"),
    )
    values = {}
    for name, pattern in assignments:
        matches = list(re.finditer(rb'^' + name + rb'="(' + pattern + rb')"\r?$', source, re.M))
        if len(matches) != 1:
            raise ValueError(f"Expected one generated {name.decode()} setting in the installed runtime")
        values[name] = matches[0]
    start, end = values[b"RELEASE_ID"].span(1)
    expected_runtime = source[:start] + new + source[end:]
    registration = values[b"DM_ALPHA_REGISTRATION_ENABLED"].group(1) == b"true"

    with tempfile.TemporaryDirectory(dir=workspace) as temp:
        scratch = Path(temp)
        for name, data in (("runtime.env", source), ("release.env", old_pins)):
            with os.fdopen(os.open(scratch / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "wb") as stream:
                stream.write(data)
        subprocess.run([
            "docker", "run", "--rm", "--pull=missing", "--platform", "linux/amd64",
            "--network", "none", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--user", "0:0",
            "--memory", "128m", "--pids-limit", "64",
            "--mount", f"type=bind,src={scratch},dst={runtime}",
            "--mount", f"type=bind,src={target / 'server-release.json'},dst=/bundle/server-release.json,readonly",
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
            operator, "scripts/stage-alpha-registration.mjs",
            "--directory", str(runtime), "--manifest", "/bundle/server-release.json",
            *(["--registration-ready"] if registration else []),
        ], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)

        if (read_file(scratch / "runtime.env.next", 256 * 1024, private=True) != expected_runtime
                or read_file(scratch / "release.env.next", 16 * 1024, private=True) != new_pins):
            raise ValueError("Staged runtime settings would change beyond the release commit and images")
        if read_file(scratch / "Caddyfile.next", 256 * 1024) != read_file(runtime / "Caddyfile", 256 * 1024):
            raise ValueError("Proxy configuration changes require a reviewed migration")
        old_realm = read_file(runtime / "realm.json", 512 * 1024)
        new_realm = read_file(scratch / "realm.json.next", 512 * 1024)
        if old_realm != new_realm and realm_without_name_help(old_realm) != realm_without_name_help(new_realm):
            raise ValueError("Identity policy changes require a reviewed migration")

        published = []
        try:
            for name in FILES:
                os.link(scratch / (name + ".next"), workspace / name)
                published.append(workspace / name)
        except BaseException:
            for path in published:
                path.unlink()
            raise

"""Checks for an application-only upgrade of a prebuilt DraftMatter server."""

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import re
import subprocess
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, ProxyHandler, Request


def version_order(version):
    match = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?', version)
    if not match:
        raise RuntimeError("Unsupported server version. Check the release notes for its upgrade procedure.")
    major, minor, patch, stage, count = match.groups()
    return (int(major), int(minor), int(patch), {None: 3, 'rc': 2, 'beta': 1, 'alpha': 0}[stage], int(count or 0))


def normalized_compose(directory, manifest, configuration):
    model = deepcopy(configuration)
    services = model['services']
    if set(services) != {'initialize', 'postgres', 'object-storage', 'keycloak', 'edge', 'collaboration'}:
        raise RuntimeError("This upgrade requires a review of the services in the Compose project.")
    for service, kind in [('edge', 'web'), ('collaboration', 'collaboration')]:
        expected = manifest['images'][kind]
        if (not re.fullmatch(rf'ghcr\.io/vezy/draftmatter-{kind}@sha256:[0-9a-f]{{64}}', expected)
                or services[service].get('image') != expected or 'build' in services[service]):
            raise RuntimeError(f"The resolved {service} configuration must use its prebuilt release image.")
        del services[service]['image']

    # Compare contents as well as mount points. Each bundle has its own absolute
    # checkout path, even when its PostgreSQL config and initialization scripts match.
    for service in services.values():
        for mount in service.get('volumes', []):
            if mount['type'] != 'bind':
                continue
            source = Path(mount['source'])
            if source.is_relative_to(directory):
                if not source.is_file() or source.is_symlink():
                    raise RuntimeError("An application-only upgrade requires regular release bind files.")
                mount['source'] = (str(source.relative_to(directory)), sha256(source.read_bytes()).hexdigest())
    return model


def check_compatible(old, target, old_compose, new_compose):
    old_manifest = json.loads((old / 'server-release.json').read_text())
    new_manifest = json.loads((target / 'server-release.json').read_text())
    if version_order(new_manifest['version']) <= version_order(old_manifest['version']):
        raise RuntimeError("Choose a newer server version for an upgrade.")
    before = normalized_compose(old, old_manifest, old_compose)
    after = normalized_compose(target, new_manifest, new_compose)
    # Alpha.6 added this optional flag. Its absence in older releases meant false.
    old_env = before['services']['collaboration']['environment']
    new_env = after['services']['collaboration']['environment']
    if 'DM_ORCID_LINKING_ENABLED' not in old_env and new_env.get('DM_ORCID_LINKING_ENABLED') == 'false':
        del new_env['DM_ORCID_LINKING_ENABLED']
    if before != after:
        raise RuntimeError("The deployment configuration changed beyond application image pins. Review the upgrade manually.")
    retention = Path('draftmatter-server/deploy/single-host/postgres/alpha-retention.sql')
    if (old / retention).read_bytes() != (target / retention).read_bytes():
        raise RuntimeError("The database retention policy changed. Review the database upgrade before switching.")


# Fingerprint exactly the SQL assets shipped and read by the service. Running
# Node with no mounts or network never starts the collaboration application.
FINGERPRINT = r"""
const fs = require('node:fs'), { createHash } = require('node:crypto');
const dir = process.argv[1];
const names = fs.readdirSync(dir).sort();
if (!names.length) throw Error('No migrations');
const hash = createHash('sha256');
for (const name of names) {
  if (!/^\d+_[a-z0-9_]+\.sql$/i.test(name) || !fs.lstatSync(dir + '/' + name).isFile())
    throw Error('Unexpected migration asset');
  hash.update(name + '\0');
  hash.update(createHash('sha256').update(fs.readFileSync(dir + '/' + name)).digest());
}
console.log(hash.digest('hex'));
"""


def migration_fingerprint(image):
    if not re.fullmatch(r'ghcr\.io/vezy/draftmatter-collaboration@sha256:[0-9a-f]{64}', image):
        raise RuntimeError("An immutable collaboration image digest is required.")
    try:
        result = subprocess.run(
            ['docker', '--host', 'unix:///var/run/docker.sock', 'run', '--rm', '--pull=never',
             '--platform', 'linux/amd64', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
             '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--entrypoint', 'node',
             image, '-e', FINGERPRINT, '/app/dist-service/migrations'],
            check=True, timeout=60, capture_output=True, text=True,
        )
    except (OSError, subprocess.SubprocessError):
        raise RuntimeError("Could not inspect the cached collaboration image's migration files.") from None
    digest = result.stdout.strip()
    if not re.fullmatch('[0-9a-f]{64}', digest):
        raise RuntimeError("The collaboration image returned an invalid migration fingerprint.")
    return digest


def check_migrations(old_image, new_image):
    if migration_fingerprint(old_image) != migration_fingerprint(new_image):
        raise RuntimeError("Database migrations changed. Rehearse the database upgrade on a restored copy first.")


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def public_ready(app_origin, sync_origin, auth_origin, registration_enabled, orcid_enabled):
    for origin in (app_origin, sync_origin, auth_origin):
        parsed = urlsplit(origin)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.path or parsed.query or parsed.fragment):
            raise RuntimeError("Public readiness checks require configured HTTPS origins.")
    opener = build_opener(ProxyHandler({}), NoRedirects())

    def get(url, *, json_body=True, cors=False):
        try:
            req = Request(url, headers={'Origin': app_origin} if cors else {})
            with opener.open(req, timeout=6) as response:
                if response.status != 200 or response.geturl() != url:
                    raise ValueError()
                if cors and response.headers.get('access-control-allow-origin') != app_origin:
                    raise ValueError()
                body = response.read(1024 * 1024 + 1)
                if len(body) > 1024 * 1024:
                    raise ValueError()
                if not json_body:
                    return body
                data = json.loads(body)
                if not isinstance(data, dict):
                    raise ValueError()
                return data
        except (OSError, URLError, ValueError):
            raise RuntimeError(f"Public readiness check failed at {url}.") from None

    if b'id="root"' not in get(app_origin + '/', json_body=False):
        raise RuntimeError("The public application page did not load.")
    config = get(app_origin + '/draftmatter-public-config.json').get('environment')
    if not isinstance(config, dict) or config.get('VITE_DRAFTMATTER_COLLABORATION_URL') != sync_origin:
        raise RuntimeError("The public application points to an unexpected collaboration service.")
    if get(sync_origin + '/health/ready').get('status') != 'ready':
        raise RuntimeError("The collaboration service is not ready.")
    issuer = auth_origin + '/realms/draftmatter'
    oidc = get(sync_origin + '/config', cors=True).get('oidc')
    if (not isinstance(oidc, dict) or oidc.get('issuer') != issuer
            or oidc.get('clientId') != 'draftmatter-public'
            or oidc.get('registrationEnabled') is not registration_enabled
            or oidc.get('orcidLinkingEnabled', False) is not orcid_enabled):
        raise RuntimeError("The collaboration service's public account configuration changed.")
    discovery = get(issuer + '/.well-known/openid-configuration')
    base = issuer + '/protocol/openid-connect'
    if (discovery.get('issuer') != issuer or discovery.get('jwks_uri') != base + '/certs'
            or discovery.get('authorization_endpoint') != base + '/auth'
            or discovery.get('token_endpoint') != base + '/token'):
        raise RuntimeError("Keycloak discovery points to unexpected identity endpoints.")

#!/usr/bin/env python3
"""Publish only a validated static website, over pinned-key SFTP.

No recursive remote deletion, credential debug output, cleartext fallback or shell is used.
New assets are published before the HTML entrypoint. Each individual replacement
uses a temporary file and rename, leaving the old file intact if upload fails.
"""
import argparse
import base64
import stat
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SITE = 'https://www.draftmatter.eu'
MANIFEST = 'draftmatter-deployment.json'
MAX_BUILD_BYTES = 80_000_000  # Keep headroom within the free host's 100 MB allowance.
SUFFIXES = {'.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.json', '.txt', '.xml', '.pdf'}


def artifact_files(directory):
    root = Path(directory)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('The build directory must be a real directory.')
    files = []
    for item in sorted(root.rglob('*')):
        if item.is_symlink():
            raise ValueError('The website artifact cannot contain symbolic links.')
        if item.is_dir():
            continue
        relative = item.relative_to(root).as_posix()
        if (not item.is_file() or item.suffix.lower() not in SUFFIXES
                or any(part.startswith('.') or not re.fullmatch(r'[A-Za-z0-9_.-]+', part) for part in PurePosixPath(relative).parts)):
            raise ValueError('The artifact contains an unsupported or non-public file.')
        files.append((relative, item))
    names = {name for name, _ in files}
    if 'index.html' not in names:
        raise ValueError('The website artifact is missing index.html.')
    index = (root / 'index.html').read_text(encoding='utf8')
    if '/DraftMatter/' in index or 'id="root"' not in index:
        raise ValueError('Build the website for the custom domain root with DRAFTMATTER_SITE_BASE=/.')
    assets = re.findall(r'(?:src|href)="(/assets/[^"?#]+)"', index)
    if not assets or any(asset.lstrip('/') not in names for asset in assets):
        raise ValueError('The entrypoint references missing or non-root build assets.')
    if sum(path.stat().st_size for _, path in files) > MAX_BUILD_BYTES:
        raise ValueError('The website artifact is too large for the free hosting allowance.')
    return files


def settings(environment):
    host = environment.get('OVH_SFTP_HOST', '').strip()
    username = environment.get('OVH_SFTP_USERNAME', '').strip()
    password = environment.get('OVH_SFTP_PASSWORD', '')
    directory = environment.get('OVH_SFTP_DIRECTORY', '').strip()
    host_key = environment.get('OVH_SFTP_HOST_KEY', '').strip()
    release = environment.get('WEBSITE_RELEASE', '').strip()
    if not re.fullmatch(r'ftp\.[A-Za-z0-9.-]+\.hosting\.ovh\.net', host):
        raise ValueError('Configure OVH_SFTP_HOST with the exact OVH hosting FTP/SFTP hostname.')
    if not username or not password or any(char in username + password for char in '\r\n\x00'):
        raise ValueError('Configure OVH_SFTP_USERNAME and OVH_SFTP_PASSWORD as environment secrets.')
    if not directory or directory == '/' or not re.fullmatch(r'[A-Za-z0-9_./-]+', directory) or any(part.startswith('.') for part in directory.split('/') if part):
        raise ValueError('OVH_SFTP_DIRECTORY must be the confirmed website directory, usually www relative to the account home.')
    if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/]+={0,2}', host_key):
        raise ValueError('Configure OVH_SFTP_HOST_KEY with the verified server public key (ssh-ed25519 and base64 key).')
    if not re.fullmatch(r'[0-9a-f]{40}', release):
        raise ValueError('WEBSITE_RELEASE must be the exact source commit SHA.')
    return host, username, password, directory.rstrip('/'), host_key, release


def connect_sftp(host, username, password, host_key):
    import paramiko
    try:
        key = paramiko.Ed25519Key(data=base64.b64decode(host_key.split()[1], validate=True))
    except Exception:
        raise ValueError('OVH_SFTP_HOST_KEY is not a valid Ed25519 public key.') from None
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.get_host_keys().add(host, key.get_name(), key)
    try:
        client.connect(host, port=22, username=username, password=password,
                       allow_agent=False, look_for_keys=False, timeout=30,
                       banner_timeout=30, auth_timeout=30)
        return client, client.open_sftp()
    except Exception:
        client.close()
        raise


def publish_file(sftp, name, data, release):
    path = PurePosixPath(name)
    if path.parent.as_posix() != '.':
        for end in range(1, len(path.parent.parts) + 1):
            folder = '/'.join(path.parent.parts[:end])
            try:
                attributes = sftp.stat(folder)
            except FileNotFoundError:
                sftp.mkdir(folder)
            else:
                if not stat.S_ISDIR(attributes.st_mode):
                    raise ValueError('A remote asset directory is not a directory.')
    temporary = str(path.with_name(f'.{path.name}.{release[:12]}.tmp'))
    try:
        with sftp.open(temporary, 'wb') as target:
            target.write(data)
        # Fail safely if the server lacks this atomic overwrite extension.
        # Never delete the old public file to force an overwrite.
        sftp.posix_rename(temporary, name)
    except Exception:
        try:
            sftp.remove(temporary)
        except Exception:
            pass
        raise


def artifact_manifest(files, release):
    return {'release': release, 'site': SITE, 'files': {
        name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files
    }}


def publish(directory, environment=os.environ, connector=connect_sftp):
    files = artifact_files(directory)
    host, username, password, remote, host_key, release = settings(environment)
    htaccess = Path(__file__).with_name('.htaccess').read_bytes()
    manifest = artifact_manifest(files, release)
    client, sftp = connector(host, username, password, host_key)
    try:
        sftp.chdir(remote)  # Never create a guessed document root or use the account root.
        for name, path in files:
            if name != 'index.html':
                publish_file(sftp, name, path.read_bytes(), release)
        publish_file(sftp, MANIFEST, json.dumps(manifest, sort_keys=True).encode() + b'\n', release)
        publish_file(sftp, 'index.html', (Path(directory) / 'index.html').read_bytes(), release)
        publish_file(sftp, '.htaccess', htaccess, release)
    finally:
        sftp.close()
        client.close()
    print(f'Uploaded {len(files)} public files for release {release[:12]} through pinned-key SFTP.')


def verify_release(environment=os.environ, request=urllib.request.urlopen, delay=time.sleep, directory="dist-website"):
    expected = artifact_manifest(artifact_files(directory), environment.get("WEBSITE_RELEASE", "").strip())
    release = environment.get('WEBSITE_RELEASE', '').strip()
    if not re.fullmatch(r'[0-9a-f]{40}', release):
        raise ValueError('WEBSITE_RELEASE must be the exact source commit SHA.')
    for attempt in range(6):
        try:
            url = f'{SITE}/{MANIFEST}?release={release}'
            with request(url, timeout=20) as response:
                if response.geturl().split('?', 1)[0] != f'{SITE}/{MANIFEST}':
                    raise ValueError('Unexpected redirect when verifying the published release.')
                manifest = json.load(response)
            if manifest != expected:
                raise ValueError('The published release does not match the tested artifact.')
            # Check all published bytes, including JS, CSS, icons, and public resources.
            for name, expected_digest in manifest['files'].items():
                if not re.fullmatch(r'[A-Za-z0-9_./-]+', name) or '..' in PurePosixPath(name).parts:
                    raise ValueError('The deployment manifest contains an unsafe path.')
                with request(f'{SITE}/{name}?release={release}', timeout=20) as response:
                    if urllib.parse.urlparse(response.geturl()).scheme != 'https' or urllib.parse.urlparse(response.geturl()).netloc != 'www.draftmatter.eu':
                        raise ValueError('A published asset redirects outside the website.')
                    if hashlib.sha256(response.read()).hexdigest() != expected_digest:
                        raise ValueError('A published file does not match the tested artifact.')
            with request(SITE + '/', timeout=20) as response:
                if response.geturl() != SITE + '/' or hashlib.sha256(response.read()).hexdigest() != expected['files']['index.html']:
                    raise ValueError('The domain root does not serve the tested website entrypoint.')
            print(f'HTTPS website and all public file hashes verified for release {release[:12]}.')
            return
        except (OSError, ValueError, KeyError, urllib.error.URLError):
            if attempt == 5:
                raise RuntimeError('HTTPS verification failed; check DNS, OVH domain mapping, SSL and the published release.') from None
            delay(10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-dir', default='dist-website')
    parser.add_argument('--validate-only', action='store_true')
    parser.add_argument('--verify-release', action='store_true')
    args = parser.parse_args()
    try:
        if args.verify_release:
            verify_release(directory=args.build_dir)
        elif args.validate_only:
            files = artifact_files(args.build_dir)
            print(f'Validated {len(files)} public website files, {sum(path.stat().st_size for _, path in files)} bytes; no SFTP connection made.')
        else:
            publish(args.build_dir)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception:
        # A remote server response may echo credentials; don't print raw exceptions.
        print('Deployment failed. Check the hosting details, SFTP credentials and HTTPS configuration; no credential values are printed.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

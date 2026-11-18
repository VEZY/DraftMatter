#!/usr/bin/python3 -I
"""Forced SSH command: expose completed ciphertext, never a shell or private keys."""
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys

ARCHIVES = Path('/var/backups/draftmatter')
LOCK_DIRECTORY = Path('/run/draftmatter-backup')
MARKER = b'DraftMatter encrypted backup directory v1\n'
NAME = re.compile(r'^draftmatter-(\d{8}T\d{9}Z)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.dmbackup$')
MAX_BYTES = 64 * 1024**3
MAX_ARCHIVES = 128
CHUNK = 256 * 1024


class ExportError(Exception):
    pass


def timestamp(name):
    match = NAME.fullmatch(name)
    if not match:
        raise ExportError('Unknown archive name.')
    try:
        value = dt.datetime.strptime(match[1], '%Y%m%dT%H%M%S%fZ').replace(tzinfo=dt.timezone.utc)
    except ValueError:
        raise ExportError('Unknown archive name.') from None
    if value.strftime('%Y%m%dT%H%M%S') + f'{value.microsecond // 1000:03d}Z' != match[1]:
        raise ExportError('Unknown archive name.')
    return value


def private_regular(info):
    return stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and not info.st_mode & 0o077


def acquire_export_lock(directory=LOCK_DIRECTORY, expected_owner=None):
    """Keep the lock outside shared /run/lock; never follow a planted path."""
    owner = os.geteuid() if expected_owner is None else expected_owner
    try:
        os.mkdir(directory, 0o700)
    except FileExistsError:
        pass
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner or info.st_mode & 0o077:
            raise ExportError('Archive export is unavailable.')
        lock = os.open('export.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK,
                       0o600, dir_fd=descriptor)
        info = os.fstat(lock)
        if not private_regular(info) or info.st_uid != owner:
            raise ExportError('Archive export is unavailable.')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return lock
    except BaseException:
        if lock is not None:
            os.close(lock)
        raise
    finally:
        os.close(descriptor)


class ArchiveExport:
    def __init__(self, directory=ARCHIVES, now=None):
        self.directory = Path(directory)
        self.now = now or dt.datetime.now(dt.timezone.utc)

    def _directory(self):
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        descriptor = os.open(self.directory, flags)
        try:
            if os.fstat(descriptor).st_mode & 0o077:
                raise ExportError('Archive export is unavailable.')
            marker = os.open('.draftmatter-backups', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=descriptor)
            try:
                if not private_regular(os.fstat(marker)) or os.read(marker, 128) != MARKER:
                    raise ExportError('Archive export is unavailable.')
            finally:
                os.close(marker)
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def _metadata(self, name, info):
        created = timestamp(name)
        if not private_regular(info) or not 0 < info.st_size <= MAX_BYTES:
            raise ExportError('Archive is unavailable.')
        age = (self.now - created).total_seconds()
        if age >= 29 * 86400 or age < -300:
            raise ExportError('Archive is outside its retention window.')
        return {'name': name, 'bytes': info.st_size,
                'createdAt': created.isoformat(timespec='milliseconds').replace('+00:00', 'Z')}

    def list(self):
        descriptor = self._directory()
        try:
            archives = []
            with os.scandir(descriptor) as entries:
                for entry in entries:
                    if not NAME.fullmatch(entry.name):
                        continue
                    try:
                        metadata = self._metadata(entry.name, entry.stat(follow_symlinks=False))
                    except ExportError:
                        continue
                    archives.append(metadata)
                    if len(archives) > MAX_ARCHIVES:
                        raise ExportError('Archive catalogue exceeds its limit.')
            return sorted(archives, key=lambda item: item['name'], reverse=True)
        finally:
            os.close(descriptor)

    def get(self, name, output):
        # Validation precedes openat; no user-controlled path is ever resolved.
        timestamp(name)
        descriptor = self._directory()
        try:
            archive = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=descriptor)
        finally:
            os.close(descriptor)
        with os.fdopen(archive, 'rb') as source:
            before = os.fstat(source.fileno())
            metadata = self._metadata(name, before)
            digest = hashlib.sha256()
            for chunk in iter(lambda: source.read(CHUNK), b''):
                digest.update(chunk)
            after = os.fstat(source.fileno())
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise ExportError('Archive changed during export.')
            source.seek(0)
            write_json(output, {'ok': True, **metadata, 'sha256': digest.hexdigest()})
            remaining = before.st_size
            while remaining:
                chunk = source.read(min(CHUNK, remaining))
                if not chunk:
                    raise ExportError('Archive changed during export.')
                output.write(chunk)
                remaining -= len(chunk)
            output.flush()


def write_json(output, value):
    output.write(json.dumps(value, separators=(',', ':')).encode('utf8') + b'\n')
    output.flush()


def serve(request, output, exporter):
    if not isinstance(request, dict):
        raise ExportError('Unknown export request.')
    if request == {'op': 'list'}:
        write_json(output, {'ok': True, 'archives': exporter.list()})
    elif set(request) == {'op', 'name'} and request.get('op') == 'get' and isinstance(request['name'], str):
        exporter.get(request['name'], output)
    else:
        raise ExportError('Unknown export request.')


def main():
    lock = None
    try:
        if len(sys.argv) != 1 or os.geteuid() != 0:
            raise ExportError('Archive export is unavailable.')
        # One transfer at a time, including authenticated clients on new sockets.
        lock = acquire_export_lock()
        signal.alarm(2 * 60 * 60)
        line = sys.stdin.buffer.readline(4097)
        if len(line) > 4096 or not line.endswith(b'\n'):
            raise ExportError('Unknown export request.')
        serve(json.loads(line), sys.stdout.buffer, ArchiveExport())
    except (ExportError, OSError, ValueError, TypeError):
        # Never print exceptions, paths, environment, SSH commands or file data.
        sys.stderr.write('DraftMatter archive export failed.\n')
        return 1
    finally:
        if lock is not None:
            os.close(lock)
    return 0


if __name__ == '__main__':
    sys.exit(main())

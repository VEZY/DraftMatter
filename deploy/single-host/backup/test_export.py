import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
import stat
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('draftmatter_archive_export', Path(__file__).with_name('export.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ArchiveExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.root.chmod(0o700)
        marker = self.root / '.draftmatter-backups'
        marker.write_bytes(module.MARKER)
        marker.chmod(0o600)
        self.now = dt.datetime(2026, 11, 18, 5, tzinfo=dt.timezone.utc)
        self.exporter = module.ArchiveExport(self.root, self.now)

    def archive(self, day='20261118', suffix=1):
        name = f'draftmatter-{day}T030000000Z-00000000-0000-0000-0000-{suffix:012d}.dmbackup'
        path = self.root / name
        path.write_bytes(b'Encrypted archive bytes\0\xff\n')
        path.chmod(0o600)
        return path

    def test_exports_exact_completed_ciphertext_with_hash_without_decrypting_or_changing_source(self):
        archive = self.archive()
        content = archive.read_bytes()
        output = io.BytesIO()
        module.serve({'op': 'get', 'name': archive.name}, output, self.exporter)
        header, body = output.getvalue().split(b'\n', 1)
        metadata = json.loads(header)
        self.assertEqual(metadata, {'ok': True, 'name': archive.name, 'bytes': len(content),
                                    'createdAt': '2026-11-18T03:00:00.000Z',
                                    'sha256': hashlib.sha256(content).hexdigest()})
        self.assertEqual(body, content)
        self.assertEqual(archive.read_bytes(), content)

    def test_lists_only_final_private_unlinked_archives(self):
        valid = self.archive()
        partial = self.root / (valid.name + '.partial')
        partial.write_bytes(b'incomplete')
        public = self.archive(suffix=2)
        public.chmod(0o644)
        linked = self.root / valid.name.replace('000000000001', '000000000003')
        linked.symlink_to(valid)
        self.assertEqual([value['name'] for value in self.exporter.list()], [valid.name])

    def test_does_not_follow_links_or_export_arbitrary_files_or_operations(self):
        archive = self.archive()
        linked = self.root / archive.name.replace('000000000001', '000000000002')
        linked.symlink_to(archive)
        hardlink = self.root / archive.name.replace('000000000001', '000000000003')
        os.link(archive, hardlink)
        for name in ['../backup.key', '/etc/draftmatter/runtime.env', 'archive.dmbackup', linked.name, hardlink.name]:
            with self.subTest(name=name), self.assertRaises((module.ExportError, OSError)):
                self.exporter.get(name, io.BytesIO())
        for request in [{'op': 'delete', 'name': archive.name}, {'op': 'list', 'directory': '/etc'}, {'op': 'get', 'name': archive.name, 'key': 'x'}]:
            with self.assertRaises(module.ExportError):
                module.serve(request, io.BytesIO(), self.exporter)

    def test_expiry_uses_immutable_creation_name_not_copy_or_touch_time(self):
        old = self.archive('20261019')
        os.utime(old, None)
        self.assertEqual(self.exporter.list(), [])
        with self.assertRaises(module.ExportError):
            self.exporter.get(old.name, io.BytesIO())
        self.assertTrue(old.exists(), 'read-only export never deletes archives')

    def test_refuses_wrong_or_public_directory_marker(self):
        archive = self.archive()
        (self.root / '.draftmatter-backups').write_bytes(b'Unrelated files')
        with self.assertRaises(module.ExportError):
            self.exporter.get(archive.name, io.BytesIO())
        (self.root / '.draftmatter-backups').write_bytes(module.MARKER)
        self.root.chmod(0o755)
        with self.assertRaises(module.ExportError):
            self.exporter.list()


class ExportLockTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.directory = self.root / 'private-runtime'
        self.owner = os.geteuid()

    def acquire(self):
        return module.acquire_export_lock(self.directory, expected_owner=self.owner)

    def test_creates_private_lock_and_serializes_independent_descriptors(self):
        first = self.acquire()
        try:
            self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)
            self.assertEqual((self.directory / 'export.lock').stat().st_mode & 0o777, 0o600)
            with self.assertRaises(BlockingIOError):
                self.acquire()
        finally:
            os.close(first)
        second = self.acquire()
        os.close(second)

    def test_refuses_public_or_linked_runtime_directory(self):
        self.directory.mkdir(mode=0o755)
        with self.assertRaises(module.ExportError):
            self.acquire()
        self.assertFalse((self.directory / 'export.lock').exists())
        self.directory.rmdir()
        self.directory.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            self.acquire()
        self.assertFalse((self.root / 'export.lock').exists())

    def test_refuses_lock_symlinks_hardlinks_and_public_permissions(self):
        self.directory.mkdir(mode=0o700)
        target = self.root / 'unrelated'
        target.write_bytes(b'Preserve unrelated data')
        target.chmod(0o600)
        lock = self.directory / 'export.lock'
        lock.symlink_to(target)
        with self.assertRaises(OSError):
            self.acquire()
        lock.unlink()
        os.link(target, lock)
        with self.assertRaises(module.ExportError):
            self.acquire()
        lock.unlink()
        lock.write_bytes(b'')
        lock.chmod(0o644)
        with self.assertRaises(module.ExportError):
            self.acquire()
        self.assertEqual(target.read_bytes(), b'Preserve unrelated data')

    def test_requires_the_runtime_directory_owner_to_match(self):
        self.directory.mkdir(mode=0o700)
        with self.assertRaises(module.ExportError):
            module.acquire_export_lock(self.directory, expected_owner=self.owner + 1)
        self.assertFalse((self.directory / 'export.lock').exists())

    def test_rejects_a_lock_owned_by_a_different_account(self):
        self.directory.mkdir(mode=0o700)
        original_fstat = os.fstat

        def foreign_lock_owner(descriptor):
            info = original_fstat(descriptor)
            if stat.S_ISREG(info.st_mode):
                fields = list(info)
                fields[4] = self.owner + 1
                return os.stat_result(fields)
            return info

        with patch.object(module.os, 'fstat', side_effect=foreign_lock_owner):
            with self.assertRaises(module.ExportError):
                self.acquire()
        # Rejection must release its descriptor rather than retain a hidden lock.
        lock = self.acquire()
        os.close(lock)


if __name__ == '__main__':
    unittest.main()

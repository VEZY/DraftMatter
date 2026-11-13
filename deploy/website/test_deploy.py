import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('website_deploy', Path(__file__).with_name('deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
RELEASE = 'a' * 40


class MemorySFTP:
    def __init__(self, fail=None):
        self.files = {'index.html': b'previous working website', 'unrelated.txt': b'leave me alone'}
        self.directories = set()
        self.renamed = []
        self.deleted = []
        self.fail = fail
        self.closed = False

    def chdir(self, directory):
        if directory != 'www':
            raise FileNotFoundError(directory)

    def stat(self, directory):
        if directory not in self.directories:
            raise FileNotFoundError(directory)
        return types.SimpleNamespace(st_mode=stat.S_IFDIR)

    def mkdir(self, directory):
        self.directories.add(directory)

    @contextlib.contextmanager
    def open(self, path, mode):
        assert mode == 'wb'
        target = io.BytesIO()
        yield target
        self.files[path] = target.getvalue()

    def posix_rename(self, source, target):
        if target == self.fail:
            raise OSError('Simulated transfer failure')
        self.files[target] = self.files.pop(source)
        self.renamed.append(target)

    def remove(self, path):
        self.deleted.append(path)
        del self.files[path]

    def close(self):
        self.closed = True


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        (self.directory / 'assets').mkdir()
        (self.directory / 'assets/site-1234.js').write_bytes(b'public application code')
        (self.directory / 'index.html').write_text('<html><div id="root"></div><script src="/assets/site-1234.js"></script></html>')
        self.environment = {
            'OVH_SFTP_HOST': 'ftp.cluster129.hosting.ovh.net',
            'OVH_SFTP_USERNAME': 'website-user',
            'OVH_SFTP_PASSWORD': 'private-test-password',
            'OVH_SFTP_DIRECTORY': 'www',
            'OVH_SFTP_HOST_KEY': 'ssh-ed25519 AAAATESTPUBLICKEY',
            'WEBSITE_RELEASE': RELEASE,
        }

    def test_rejects_old_project_base_and_missing_assets(self):
        index = self.directory / 'index.html'
        index.write_text('<div id="root"></div><script src="/DraftMatter/assets/site-1234.js"></script>')
        with self.assertRaisesRegex(ValueError, 'custom domain root'):
            deploy.artifact_files(self.directory)
        index.write_text('<div id="root"></div><script src="/assets/absent.js"></script>')
        with self.assertRaisesRegex(ValueError, 'missing'):
            deploy.artifact_files(self.directory)

    def test_rejects_secret_files_and_symlinks(self):
        secret = self.directory / '.env'
        secret.write_text('must never be uploaded')
        with self.assertRaisesRegex(ValueError, 'non-public'):
            deploy.artifact_files(self.directory)
        secret.unlink()
        (self.directory / 'assets/link.js').symlink_to('/etc/hosts')
        with self.assertRaisesRegex(ValueError, 'symbolic'):
            deploy.artifact_files(self.directory)

    def test_refuses_oversized_artifact_before_connecting(self):
        with (self.directory / 'large.txt').open('wb') as target:
            target.truncate(deploy.MAX_BUILD_BYTES)
        connector = mock.Mock()
        with self.assertRaisesRegex(ValueError, 'too large'):
            deploy.publish(self.directory, self.environment, connector=connector)
        connector.assert_not_called()

    def test_refuses_missing_credentials_key_and_unsafe_root_before_connecting(self):
        for key, value in [('OVH_SFTP_PASSWORD', ''), ('OVH_SFTP_HOST_KEY', ''), ('OVH_SFTP_DIRECTORY', '../www'), ('OVH_SFTP_DIRECTORY', '/'), ('OVH_SFTP_HOST', 'ftp://wrong')]:
            connector = mock.Mock()
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                deploy.publish(self.directory, {**self.environment, key: value}, connector=connector)
            connector.assert_not_called()

    def test_uploads_assets_before_entrypoint_and_preserves_other_remote_files(self):
        server = MemorySFTP()
        client = mock.Mock()
        connector = mock.Mock(return_value=(client, server))
        deploy.publish(self.directory, self.environment, connector=connector)
        connector.assert_called_once_with(self.environment['OVH_SFTP_HOST'], 'website-user', 'private-test-password', self.environment['OVH_SFTP_HOST_KEY'])
        self.assertLess(server.renamed.index('assets/site-1234.js'), server.renamed.index('index.html'))
        self.assertEqual(server.files['unrelated.txt'], b'leave me alone')
        self.assertEqual(server.deleted, [])
        self.assertTrue(server.closed)
        client.close.assert_called_once()

    def test_failure_keeps_previous_entrypoint_and_removes_only_own_temporary_file(self):
        server = MemorySFTP(fail='assets/site-1234.js')
        with self.assertRaises(OSError):
            deploy.publish(self.directory, self.environment, connector=lambda *args: (mock.Mock(), server))
        self.assertEqual(server.files['index.html'], b'previous working website')
        self.assertEqual(server.files['unrelated.txt'], b'leave me alone')
        self.assertEqual(server.deleted, ['assets/.site-1234.js.aaaaaaaaaaaa.tmp'])
        self.assertTrue(server.closed)

    def test_missing_document_root_does_not_create_a_guessed_root(self):
        server = MemorySFTP()
        with self.assertRaises(FileNotFoundError):
            deploy.publish(self.directory, {**self.environment, 'OVH_SFTP_DIRECTORY': 'wrong'}, connector=lambda *args: (mock.Mock(), server))
        self.assertEqual(server.renamed, [])
        self.assertEqual(server.directories, set())

    def test_rejects_untrusted_server_keys_and_avoids_local_ssh_credentials(self):
        client = mock.Mock()
        key = mock.Mock()
        key.get_name.return_value = 'ssh-ed25519'
        paramiko = types.SimpleNamespace(Ed25519Key=mock.Mock(return_value=key), SSHClient=mock.Mock(return_value=client), RejectPolicy=mock.Mock())
        with mock.patch.dict('sys.modules', {'paramiko': paramiko}):
            deploy.connect_sftp('ftp.cluster129.hosting.ovh.net', 'website-user', 'private-test-password', 'ssh-ed25519 AAAA')
        client.set_missing_host_key_policy.assert_called_once_with(paramiko.RejectPolicy.return_value)
        client.get_host_keys.return_value.add.assert_called_once_with('ftp.cluster129.hosting.ovh.net', 'ssh-ed25519', key)
        options = client.connect.call_args.kwargs
        self.assertIs(options['allow_agent'], False)
        self.assertIs(options['look_for_keys'], False)
        self.assertEqual(options['port'], 22)

    def responses(self, manifest=None, corrupt=False, wrong_root=False):
        expected = deploy.artifact_manifest(deploy.artifact_files(self.directory), RELEASE)
        actual_manifest = expected if manifest is None else manifest
        def request(url, timeout):
            path = url.split('?', 1)[0].removeprefix(deploy.SITE + '/')
            if path == deploy.MANIFEST:
                data = json.dumps(actual_manifest).encode()
            elif path == '':
                data = b'OVH default page' if wrong_root else (self.directory / 'index.html').read_bytes()
            else:
                data = b'corrupt' if corrupt else (self.directory / path).read_bytes()
            response = io.BytesIO(data)
            response.geturl = lambda: url
            return response
        return request

    def test_verifies_published_bytes_against_trusted_local_artifact(self):
        deploy.verify_release(self.environment, request=self.responses(), delay=lambda _: None, directory=self.directory)
        for request in [self.responses(corrupt=True), self.responses(wrong_root=True), self.responses(manifest={'release': RELEASE, 'site': deploy.SITE, 'files': {}})]:
            with self.assertRaisesRegex(RuntimeError, 'HTTPS verification failed'):
                deploy.verify_release(self.environment, request=request, delay=lambda _: None, directory=self.directory)


if __name__ == '__main__':
    unittest.main()

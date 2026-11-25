import copy
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import upgrade_checks as checks


class CompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.old, self.before = self.release('0.1.0-alpha.9', '1')
        self.new, self.after = self.release('0.1.0-alpha.10', '2')

    def release(self, version, digit):
        root = self.base / version
        deployment = root / 'draftmatter-server/deploy/single-host'
        (deployment / 'postgres').mkdir(parents=True)
        bind = deployment / 'postgres/init.sh'
        bind.write_text('initialize')
        (deployment / 'postgres/alpha-retention.sql').write_text('set retention')
        images = {k: f'ghcr.io/vezy/draftmatter-{k}@sha256:{digit * 64}'
                  for k in ('collaboration', 'web', 'operator')}
        (root / 'server-release.json').write_text(json.dumps({'version': version, 'images': images}))
        services = {
            'initialize': {}, 'keycloak': {}, 'object-storage': {},
            'postgres': {'image': 'postgres@sha256:' + 64 * '3', 'volumes': [{'type': 'bind', 'source': str(bind)}]},
            'edge': {'image': images['web']},
            'collaboration': {'image': images['collaboration'], 'environment': {'EXAMPLE': 'preserve'}},
        }
        return root, {'services': services, 'name': 'draftmatter-alpha-production'}

    def check(self):
        checks.check_compatible(self.old, self.new, self.before, self.after)

    def test_checks_numeric_version_app_pins_and_release_relative_bind_contents(self):
        self.after['services']['collaboration']['environment']['DM_ORCID_LINKING_ENABLED'] = 'false'
        original = copy.deepcopy(self.after)
        self.check()
        self.assertEqual(self.after, original)
        target = Path(self.after['services']['postgres']['volumes'][0]['source'])
        target.write_text('changed')
        with self.assertRaisesRegex(RuntimeError, 'configuration changed'):
            self.check()

    def test_rejects_changed_database_image_and_changed_registration_or_orcid_flags(self):
        for service, field, key, value in (
                ('postgres', None, 'image', 'postgres:different'),
                ('collaboration', 'environment', 'DM_ALPHA_REGISTRATION_ENABLED', 'true'),
                ('collaboration', 'environment', 'DM_ORCID_LINKING_ENABLED', 'true'),
                ('edge', None, 'image', 'draftmatter-web:latest')):
            with self.subTest(key=key):
                conf = self.after['services'][service]
                with patch.dict(conf[field] if field else conf, {key: value}):
                    with self.assertRaises(RuntimeError):
                        self.check()

    def test_rejects_old_target_and_changed_retention_sql(self):
        with self.assertRaisesRegex(RuntimeError, 'newer'):
            checks.check_compatible(self.new, self.old, self.after, self.before)
        (self.new / 'draftmatter-server/deploy/single-host/postgres/alpha-retention.sql').write_text('changed')
        with self.assertRaisesRegex(RuntimeError, 'retention'):
            self.check()

    @unittest.skipUnless(shutil.which('node'), 'Node is needed to run the image migration checker locally')
    def test_shipped_probe_fingerprints_the_names_and_bytes_of_the_migration_sequence(self):
        directory = self.base / 'sql'
        directory.mkdir()

        def probe():
            return subprocess.run(['node', '-e', checks.FINGERPRINT, str(directory)], capture_output=True)

        self.assertNotEqual(probe().returncode, 0)
        path = directory / '001_create.sql'
        path.write_text('first definition')
        first = probe()
        self.assertEqual(first.returncode, 0)
        path.write_text('second definition')
        second = probe()
        self.assertNotEqual(first.stdout, second.stdout)
        path.rename(directory / '002_create.sql')
        self.assertNotEqual(probe().stdout, second.stdout)
        (directory / '003_link.sql').symlink_to(directory / '002_create.sql')
        self.assertNotEqual(probe().returncode, 0)

    @patch.object(checks.subprocess, 'run')
    def test_inspects_only_pinned_images_offline_and_rejects_changed_migrations(self, run):
        service = 'ghcr.io/vezy/draftmatter-collaboration@sha256:'
        old, new = service + '1' * 64, service + '2' * 64
        with self.assertRaisesRegex(RuntimeError, 'immutable'):
            checks.check_migrations('draftmatter-collaboration:latest', new)
        run.assert_not_called()
        out = lambda digest: subprocess.CompletedProcess([], 0, stdout=digest * 64 + '\n')
        run.side_effect = [out('a'), out('a')]
        checks.check_migrations(old, new)
        for call, image in zip(run.call_args_list, (old, new)):
            args = call.args[0]
            self.assertEqual(args[args.index('--network') + 1], 'none')
            self.assertIn('--pull=never', args)
            self.assertIn('--read-only', args)
            self.assertIn(image, args)
            self.assertNotIn('--mount', args)
        run.side_effect = [out('a'), out('b')]
        with self.assertRaisesRegex(RuntimeError, 'migrations changed'):
            checks.check_migrations(old, new)


class Response(io.BytesIO):
    def __init__(self, url, body, origin):
        super().__init__(body if isinstance(body, bytes) else json.dumps(body).encode())
        self.url = url
        self.headers = {'access-control-allow-origin': origin}
        self.status = 200

    def geturl(self):
        return self.url


class PublicChecks(unittest.TestCase):
    def setUp(self):
        self.app, self.sync, self.auth = ('https://' + k + '.example.test' for k in ('app', 'sync', 'auth'))
        issuer = self.auth + '/realms/draftmatter'
        self.disco = issuer + '/.well-known/openid-configuration'
        self.oidc = {'issuer': issuer, 'clientId': 'draftmatter-public', 'registrationEnabled': True}
        self.documents = {
            self.app + '/': b'<html><div id="root"></div></html>',
            self.app + '/draftmatter-public-config.json': {'environment': {'VITE_DRAFTMATTER_COLLABORATION_URL': self.sync}},
            self.sync + '/health/ready': {'status': 'ready'}, self.sync + '/config': {'oidc': self.oidc},
            self.disco: {'issuer': issuer, **{field: issuer + '/protocol/openid-connect/' + suffix
                          for field, suffix in [('authorization_endpoint', 'auth'), ('token_endpoint', 'token'), ('jwks_uri', 'certs')]}},
        }

    @patch.object(checks, 'build_opener')
    def test_preserves_expected_signup_orcid_and_identity_routes(self, factory):
        def opened(req, timeout):
            return Response(req.full_url, self.documents[req.full_url], self.app)
        factory.return_value.open.side_effect = opened
        checks.public_ready(self.app, self.sync, self.auth, True, False)
        self.oidc['registrationEnabled'] = False
        with self.assertRaisesRegex(RuntimeError, 'public account'):
            checks.public_ready(self.app, self.sync, self.auth, True, False)
        self.oidc['orcidLinkingEnabled'] = True
        checks.public_ready(self.app, self.sync, self.auth, False, True)
        self.documents[self.disco]['token_endpoint'] = 'https://elsewhere.example.test'
        with self.assertRaisesRegex(RuntimeError, 'discovery'):
            checks.public_ready(self.app, self.sync, self.auth, False, True)


if __name__ == '__main__':
    unittest.main()

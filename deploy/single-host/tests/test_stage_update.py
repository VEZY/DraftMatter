import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import stage_update


REPO = Path(__file__).resolve().parents[3]
RUN = subprocess.run
FIXTURE = """
import {writeFileSync} from 'node:fs'
import {createSingleHostEnvironment, serializeEnvironment} from './scripts/init-single-host.mjs'
import {renderSingleHostCaddy} from './scripts/single-host-config.mjs'
import {buildSingleHostRealm} from './deploy/single-host/keycloak/realm.mjs'
const [directory, release, registration] = process.argv.slice(1)
const env = createSingleHostEnvironment({directory, release, rehearsal:true, project:'draftmatter-rehearsal-stage'})
env.DM_ALPHA_REGISTRATION_ENABLED = registration
writeFileSync(directory + '/runtime.env', '# Operator note.\\n' + serializeEnvironment(env), {mode:0o600})
writeFileSync(directory + '/Caddyfile', renderSingleHostCaddy(env))
writeFileSync(directory + '/realm.json', JSON.stringify(buildSingleHostRealm({
  appHost:env.APP_HOST, authHost:env.AUTH_HOST, httpsPort:8443, registrationEnabled:registration === 'true',
}), null, 2) + '\\n')
"""


class StageTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name).resolve()
        self.runtime, self.workspace = root / 'runtime', root / 'workspace'
        self.old, self.target = root / 'old', root / 'target'
        for folder in (self.runtime, self.workspace, self.old, self.target):
            folder.mkdir(mode=0o700)
        self.old_commit, self.new_commit = 'a' * 40, 'b' * 40
        for path, commit, digest in [(self.old, self.old_commit, 'c'), (self.target, self.new_commit, 'd')]:
            images = {name: f'ghcr.io/vezy/draftmatter-{name}@sha256:{digest * 64}'
                      for name in ('collaboration', 'web', 'operator')}
            (path / 'server-release.json').write_text(json.dumps({
                'schemaVersion': 1, 'version': '0.1.0-alpha.7', 'commit': commit,
                'platform': 'linux/amd64', 'images': images,
            }))
        old_pins = self.runtime / 'release.env'
        old_pins.write_bytes(stage_update.release_pins(self.old)[2])
        old_pins.chmod(0o600)
        self.fixture('true')

    def fixture(self, registration):
        RUN(['node', '--input-type=module', '-e', FIXTURE, str(self.runtime), self.old_commit, registration],
            cwd=REPO, check=True)

    def simulate_mount(self, cmd, **kwargs):
        """Run the real operator helper locally with the two Docker paths mapped."""
        self.assertIn('none', cmd)
        image = stage_update.release_pins(self.target)[1]
        self.assertIn(image, cmd)
        mounts = [arg for arg in cmd if arg.startswith('type=bind,src=')]
        scratch = Path(mounts[0].split(',')[1].removeprefix('src='))
        self.assertTrue(scratch.is_relative_to(self.workspace))
        self.assertEqual(mounts[0].split(',')[2], 'dst=' + str(self.runtime))
        self.assertEqual(mounts[1].split(',')[1:], ['src=' + str(self.target / 'server-release.json'),
                                                   'dst=/bundle/server-release.json', 'readonly'])
        runtime_env = scratch / 'runtime.env'
        runtime_env.write_bytes(runtime_env.read_bytes().replace(bytes(self.runtime), bytes(scratch)))
        args = ['node', *cmd[cmd.index(image) + 1:]]
        args[args.index('--directory') + 1] = str(scratch)
        args[args.index('--manifest') + 1] = str(self.target / 'server-release.json')
        RUN(args, cwd=REPO, **kwargs)
        candidate = scratch / 'runtime.env.next'
        candidate.write_bytes(candidate.read_bytes().replace(bytes(scratch), bytes(self.runtime)))

    def stage(self):
        with patch.object(stage_update.subprocess, 'run', side_effect=self.simulate_mount):
            stage_update.stage(self.runtime, self.old, self.target, self.workspace)

    def test_preserves_registration_and_operator_settings_in_both_modes(self):
        for enabled in ('false', 'true'):
            with self.subTest(registered=enabled):
                self.fixture(enabled)
                before = {p.name: p.read_bytes() for p in self.runtime.iterdir()}
                self.stage()
                expected = before['runtime.env'].replace(self.old_commit.encode(), self.new_commit.encode(), 1)
                self.assertEqual((self.workspace / 'runtime.env').read_bytes(), expected)
                self.assertEqual((self.workspace / 'release.env').read_bytes(), stage_update.release_pins(self.target)[2])
                self.assertEqual({p.name: p.read_bytes() for p in self.runtime.iterdir()}, before)
                for name in stage_update.FILES:
                    staged = self.workspace / name
                    self.assertEqual(staged.stat().st_nlink, 1)
                    if name.endswith('.env'):
                        self.assertEqual(staged.stat().st_mode & 0o777, 0o600)
                    staged.unlink()

    def test_accepts_previous_registration_help_and_preserves_the_live_realm(self):
        path = self.runtime / 'realm.json'
        realm = json.loads(path.read_bytes())
        settings = realm['components'][stage_update.PROFILE][0]['config']['kc.user.profile.config']
        profile = json.loads(settings[0])
        names = {attr['name']: attr for attr in profile['attributes']}
        del names['firstName']['annotations']
        settings[0] = json.dumps(profile)
        path.write_text(json.dumps(realm))
        self.stage()
        self.assertEqual(json.loads(path.read_text()), realm)
        self.assertNotEqual(path.read_bytes(), (self.workspace / 'realm.json').read_bytes())

    def test_refuses_security_policy_or_proxy_changes_before_producing_candidates(self):
        path = self.runtime / 'realm.json'
        original = path.read_bytes()
        data = json.loads(original)
        data['registrationAllowed'] = False
        path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'Identity policy'):
            self.stage()
        self.assertEqual(list(self.workspace.iterdir()), [])
        path.write_bytes(original)
        (self.runtime / 'Caddyfile').write_text('changed proxy policy')
        with self.assertRaisesRegex(ValueError, 'Proxy configuration'):
            self.stage()
        self.assertEqual(list(self.workspace.iterdir()), [])

    def test_existing_output_or_unmatched_active_pins_stop_before_running_the_operator(self):
        path = self.workspace / 'release.env'
        path.write_text('earlier attempt')
        with self.assertRaisesRegex(ValueError, 'unused'):
            self.stage()
        self.assertEqual(path.read_text(), 'earlier attempt')
        path.unlink()
        (self.runtime / 'release.env').write_bytes(stage_update.release_pins(self.target)[2])
        with self.assertRaisesRegex(ValueError, 'Installed release.env'):
            self.stage()
        self.assertEqual(list(self.workspace.iterdir()), [])

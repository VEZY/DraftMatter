import io
import json
import os
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import upgrade


class DeploymentTests(unittest.TestCase):
    """Real config files, journal, locks and scheduler with simulated host services."""

    def setUp(self):
        self.events = ExitStack()
        self.addCleanup(self.events.close)
        self.events.callback(os.umask, os.umask(0o077))  # main() sets this for the real operator.
        self.directory = Path(self.events.enter_context(tempfile.TemporaryDirectory()))
        self.releases = self.directory / 'releases'
        self.runtime = self.directory / 'runtime'
        self.archives = self.directory / 'archives'
        for folder in (self.releases, self.runtime, self.archives):
            folder.mkdir(mode=0o700)
        self.old = self.release('0.1.0-alpha.5', 'a')
        self.new = self.release('0.1.0-alpha.7', 'b')
        self.running = self.old
        self.write_settings(self.old, self.runtime)
        self.original = self.contents()
        self.backups = 0
        self.pull = []
        self.start = []
        self.fail_backup = False
        self.fail_start = set()
        self.events.enter_context(redirect_stdout(io.StringIO()))
        self.events.enter_context(redirect_stderr(io.StringIO()))
        for name, value in (
            ('RELEASES', self.releases), ('ARCHIVES', self.archives),
            ('install', lambda base, version: base / version), ('trusted', lambda path: None),
            ('verify_running', self.verify), ('stage', self.stage), ('compose', self.compose),
            ('run', self.run_command), ('check_compatible', lambda *args: None),
            ('check_migrations', lambda *args: None),
        ):
            self.events.enter_context(patch.object(upgrade, name, value))

    def release(self, version, digit):
        release = self.releases / version
        release.mkdir()
        manifest = dict(version=version, commit=digit * 40, images={
            kind: f'ghcr.io/vezy/draftmatter-{kind}@sha256:{digit * 64}' for kind in ('collaboration', 'operator', 'web')
        })
        (release / 'server-release.json').write_text(json.dumps(manifest))
        return release

    def write_settings(self, release, dest):
        commit = upgrade.manifest(release)['commit']
        for name in ('runtime.env', 'release.env'):
            (dest / name).write_text(f'RELEASE_ID="{commit}"\n')
            (dest / name).chmod(0o600)
        (dest / 'realm.json').write_text(f'{release.name} realm import')
        (dest / 'Caddyfile').write_text('constant routing configuration')
        if dest == self.runtime:
            (dest / upgrade.SCHEDULE).write_text(f'DM_BACKUP_RELEASE_DIRECTORY={release}\n')
            (dest / upgrade.SCHEDULE).chmod(0o600)

    def contents(self):
        return {key: (self.runtime / key).read_bytes() for key in (*upgrade.FILES, 'Caddyfile', upgrade.SCHEDULE)}

    def stage(self, runtime, old, target, prepared):
        self.assertEqual(runtime, self.runtime)
        self.verify(old, runtime)
        self.write_settings(target, prepared)

    def verify(self, release, runtime):
        self.assertEqual(self.running, release)
        for name in ('runtime.env', 'release.env'):
            self.assertEqual(upgrade.field(runtime / name, 'RELEASE_ID'), upgrade.manifest(release)['commit'])

    def run_command(self, args, capture=False):
        args = [str(a) for a in args]
        if args[0] == 'sh' and args[1].endswith('/server-backup.sh'):
            self.assertEqual(args[2:], [str(self.old), str(self.runtime), str(self.archives), 'create'])
            if self.fail_backup:
                raise RuntimeError('simulated disk full')
            self.backups += 1
        elif args[0] == 'sh' and args[1].endswith('/server-operator.sh'):
            self.assertEqual(args[-1], 'check')
        else:
            self.assertEqual(args[:2], ['docker', 'run'])
            self.assertIn('--pull=never', args)
            self.assertIn('--check', args)

    def compose(self, release, env, *args, capture=False):
        if args[0] == 'config':
            self.assertTrue(capture)
            return '{}'
        if args[0] == 'pull':
            self.assertEqual(args[1:], ('edge', 'collaboration'))
            self.pull.append(release)
            return
        self.assertEqual(args[0], 'up')
        self.assertIn('--no-deps', args)
        self.assertIn('--no-build', args)
        self.assertIn('--wait', args)
        self.assertEqual(args[-2:], ('edge', 'collaboration'))
        self.assertEqual(env, self.runtime)
        self.assertEqual(upgrade.field(env / 'release.env', 'RELEASE_ID'), upgrade.manifest(release)['commit'])
        self.assertTrue((self.archives / '.lock').is_file())
        self.start.append(release)
        if release in self.fail_start:
            raise RuntimeError('simulated startup failure')
        self.running = release

    def deploy(self, check_only=False):
        upgrade.upgrade(self.runtime, self.new.name, check_only)

    def assert_clean(self):
        self.assertFalse((self.archives / '.lock').exists())
        self.assertFalse((self.runtime / upgrade.PENDING).exists())

    def test_check_prepares_images_with_no_downtime_and_no_live_writes(self):
        self.deploy(check_only=True)
        self.assertEqual(self.pull, [self.new])
        self.assertEqual((self.backups, self.start), (0, []))
        self.assertEqual(self.contents(), self.original)
        self.assert_clean()

    def test_upgrade_switches_schedule_after_health_and_repeating_is_a_noop(self):
        self.deploy()
        self.assertEqual(self.running, self.new)
        self.assertEqual((self.backups, self.start), (1, [self.new]))
        self.assertEqual((self.runtime / upgrade.SCHEDULE).read_text(), f'DM_BACKUP_RELEASE_DIRECTORY={self.new}\n')
        self.assertEqual((self.runtime / upgrade.SCHEDULE).stat().st_mode & 0o077, 0)
        self.deploy()
        self.assertEqual((self.backups, self.start, self.pull), (1, [self.new], [self.new]))
        self.assert_clean()

    def test_backup_failure_leaves_old_service_and_settings(self):
        self.fail_backup = True
        with self.assertRaisesRegex(RuntimeError, 'disk full'):
            self.deploy()
        self.assertEqual(self.start, [])
        self.assertEqual(self.contents(), self.original)
        self.assert_clean()

    def test_failed_activation_restores_old_configuration_pins_and_schedule(self):
        self.fail_start = {self.new}
        with self.assertRaisesRegex(RuntimeError, 'Restored'):
            self.deploy()
        self.assertEqual(self.start, [self.new, self.old])
        self.assertEqual(self.running, self.old)
        self.assertEqual(self.contents(), self.original)
        self.assert_clean()

    def test_public_health_failure_after_start_rolls_back_both_running_app_services(self):
        def health(release, runtime):
            self.verify(release, runtime)
            if release == self.new:
                self.assertEqual((runtime / upgrade.SCHEDULE).read_bytes(), self.original[upgrade.SCHEDULE])
                raise RuntimeError('simulated unavailable public identity endpoint')
        with patch.object(upgrade, 'verify_running', health):
            with self.assertRaisesRegex(RuntimeError, 'Restored'):
                self.deploy()
        self.assertEqual(self.start, [self.new, self.old])
        self.assertEqual(self.running, self.old)
        self.assertEqual(self.contents(), self.original)
        self.assert_clean()

    def test_restart_recovers_an_interrupted_transaction_and_its_own_lock(self):
        pending = self.runtime / upgrade.PENDING
        saved = pending / 'saved'
        saved.mkdir(parents=True)
        for name in self.original:
            shutil.copy2(self.runtime / name, saved / name)
        token = 'd' * 32
        (pending / 'transaction.json').write_text(json.dumps(dict(previous=self.old.name, target=self.new.name, token=token)))
        (self.archives / '.lock').write_text(f'release-upgrade-{token}\n')
        # Model the crash between replacing the first and second live environment file.
        (self.runtime / 'runtime.env').write_text('RELEASE_ID="' + upgrade.manifest(self.new)['commit'] + '"\n')
        with self.assertRaisesRegex(RuntimeError, 'interrupted'):
            self.deploy(check_only=True)
        with self.assertRaisesRegex(RuntimeError, 'Restored'):
            self.deploy()
        self.assertEqual(self.start, [self.old])
        self.assertEqual(self.backups, 0)
        self.assertEqual(self.contents(), self.original)
        self.assert_clean()

    def test_failed_rollback_retains_journal_for_second_attempt(self):
        self.fail_start = {self.old, self.new}
        with self.assertRaises(RuntimeError):
            self.deploy()
        self.assertTrue((self.runtime / upgrade.PENDING / 'transaction.json').is_file())
        self.fail_start.clear()
        with self.assertRaisesRegex(RuntimeError, 'Restored'):
            self.deploy()
        self.assertEqual(self.start, [self.new, self.old, self.old])
        self.assertEqual(self.contents(), self.original)
        self.assert_clean()


if __name__ == '__main__':
    unittest.main()

import base64
import importlib.util
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zlib


client_path = Path(__file__).resolve().parents[3] / "scripts" / "deploy-server.py"
spec = importlib.util.spec_from_file_location("deploy_server", client_path)
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class DeployClientTests(unittest.TestCase):
    def test_one_ssh_connection_with_checked_host_key_and_interactive_sudo(self):
        args = client.ssh_command("deploy@example.org", "/mac/key file", "payload", "0.1.0-alpha.7", True)
        self.assertEqual(args[:2], ["ssh", "-t"])
        self.assertEqual(args[-3:-1], ["--", "deploy@example.org"])
        self.assertEqual(args[args.index("-i") + 1], "/mac/key file")
        for flag in ["ControlPath=none", "ClearAllForwardings=yes", "ForwardAgent=no",
                     "ForwardX11=no", "StrictHostKeyChecking=yes", "IdentitiesOnly=yes"]:
            self.assertIn(flag, args)
        remote = shlex.split(args[-1])
        self.assertEqual(remote, ["/usr/bin/sudo", "--", "/usr/bin/python3", "-I", "-B", "-c",
                                  client.BOOTSTRAP, "payload", "0.1.0-alpha.7", "--check"])
        for host in ["-o", "my host", "a;b", "user@bad$(host)"]:
            with self.assertRaises(ValueError):
                client.ssh_command(host, None, "", "0.1.0-alpha.7", False)

    def test_only_the_public_helpers_are_transferred_and_cleaned_after_exit(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            local = base / "local"
            local.mkdir()
            for name in client.HELPERS:
                (local / name).write_text(f"# {name}\n")
            (local / "runtime.env").write_text("fixture-private")
            packed = client.pack_helpers(local)
            sources = json.loads(zlib.decompress(base64.b64decode(packed)))
            self.assertEqual(set(sources), set(client.HELPERS))
            version = "0.1.0-alpha.7"
            remote_dir = base / "remote"
            with tempfile.TemporaryDirectory(dir=base) as temp_parent:
                temp_directory = tempfile.TemporaryDirectory

                def temp_on_host(*, dir, prefix):
                    self.assertEqual(dir, "/run")
                    return temp_directory(prefix=prefix, dir=temp_parent)

                def run(args):
                    nonlocal remote_dir
                    remote_dir = Path(args[3]).parent
                    self.assertEqual(args, ["/usr/bin/python3", "-I", "-B", str(remote_dir / "upgrade.py"), version, "--check"])
                    self.assertEqual({p.name: p.read_text() for p in remote_dir.iterdir()}, sources)
                    self.assertEqual(remote_dir.stat().st_mode & 0o777, 0o700)
                    return 17

                with patch.object(sys, "argv", ["-c", packed, version, "--check"]), \
                     patch("tempfile.TemporaryDirectory", side_effect=temp_on_host), \
                     patch("subprocess.call", side_effect=run), self.assertRaises(SystemExit) as exit_status:
                    exec(client.BOOTSTRAP, {})
                self.assertEqual(exit_status.exception.code, 17)
                self.assertFalse(remote_dir.exists())
            # An accidentally linked helper cannot cause the client to send a private file.
            (local / "upgrade.py").unlink()
            (local / "upgrade.py").symlink_to(local / "runtime.env")
            with self.assertRaises(ValueError):
                client.pack_helpers(local)

    def test_host_and_identity_precedence_only_reads_needed_settings(self):
        host_key, identity_key = "draftmatter.deployHost", "draftmatter.deployIdentity"
        config = {host_key: "configured-vps", identity_key: "/configured/key"}
        cases = [
            ([], "", {}, "draftmatter-vps", None, [host_key, identity_key]),
            ([], "", config, "configured-vps", "/configured/key", [host_key, identity_key]),
            ([], "env-vps", config, "env-vps", "/configured/key", [identity_key]),
            (["--identity", "/explicit/key"], "", config, "configured-vps", "/explicit/key", [host_key]),
            (["--host", "cli-vps", "--identity", "/my key"], "env-vps", config, "cli-vps", "/my key", []),
        ]
        for extra, env_host, settings, host, identity, expected_keys in cases:
            with self.subTest(extra=extra, host=host), patch.dict("os.environ", {"DRAFTMATTER_SSH_HOST": env_host}), \
                 patch.object(sys, "argv", ["deploy-server.py", "0.1.0-alpha.7", *extra]), \
                 patch.object(client, "local_setting", side_effect=settings.get) as lookup, \
                 patch.object(client, "pack_helpers", return_value="payload"), patch("subprocess.call", return_value=11) as call:
                self.assertEqual(client.main(), 11)
                args = call.call_args.args[0]
                self.assertEqual(args[-2], host)
                self.assertEqual(args[args.index("-i") + 1] if "-i" in args else None, identity)
                self.assertEqual([item.args[0] for item in lookup.call_args_list], expected_keys)

    def test_only_the_clients_own_repository_local_config_is_read(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(client, "REPOSITORY", Path(directory)):
            self.assertIsNone(client.local_setting("draftmatter.deployHost"))
            subprocess.run(["git", "init", "-q", directory], check=True)
            root = Path(directory)
            (root / "included.conf").write_text("[draftmatter]\n deployHost = included-host\n")
            config = root / ".git/config"
            with config.open("a") as output:
                output.write("[include]\n path = ../included.conf\n[draftmatter]\n deployIdentity = /my key\n")
            before = config.read_bytes()
            with patch.dict("os.environ", {"GIT_DIR": str(root / "some-other-repository")}):
                self.assertIsNone(client.local_setting("draftmatter.deployHost"))
                self.assertEqual(client.local_setting("draftmatter.deployIdentity"), "/my key")
            self.assertEqual(config.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()

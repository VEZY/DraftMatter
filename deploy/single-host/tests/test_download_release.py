import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest.mock import Mock


spec = importlib.util.spec_from_file_location("download_release", Path(__file__).resolve().parents[1] / "download_release.py")
downloader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(downloader)


class ReleaseDownloadTests(unittest.TestCase):
    version = "0.1.0-alpha.7"
    archive = f"draftmatter-server-{version}.tar.gz"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name) / "releases"
        self.base.mkdir()
        self.assets = Path(self.temp.name) / "assets"
        self.assets.mkdir()
        self.manifest = json.dumps({"platform": "linux/amd64", "version": self.version}).encode()
        self.fixture()
        self.urls = []

    def fixture(self, embedded=None, extra=None):
        (self.assets / downloader.MANIFEST).write_bytes(self.manifest)
        with tarfile.open(self.assets / self.archive, "w:gz") as tar:
            root = tarfile.TarInfo(downloader.BUNDLE)
            root.type = tarfile.DIRTYPE
            tar.addfile(root)
            entry = tarfile.TarInfo(f"{downloader.BUNDLE}/{downloader.MANIFEST}")
            data = self.manifest if embedded is None else embedded
            entry.size = len(data)
            tar.addfile(entry, io.BytesIO(data))
            if extra:
                tar.addfile(extra)
        checksums = [f"{hashlib.sha256((self.assets / name).read_bytes()).hexdigest()}  {name}"
                     for name in [downloader.MANIFEST, self.archive]]
        (self.assets / "SHA256SUMS").write_text("\n".join(checksums) + "\n")

    def copy(self, url, path, _limit):
        self.urls.append(url)
        shutil.copyfile(self.assets / path.name, path)

    def test_download_is_version_pinned_and_matching_cache_is_reused_offline(self):
        path = downloader.install(self.base, self.version, self.copy)
        self.assertEqual(path, self.base / self.version)
        self.assertEqual(self.urls, [
            f"https://github.com/VEZY/DraftMatter/releases/download/server-v{self.version}/{name}"
            for name in ["SHA256SUMS", downloader.MANIFEST, self.archive]
        ])
        no_network = Mock(side_effect=AssertionError("unexpected download"))
        self.assertEqual(downloader.install(self.base, self.version, no_network), path)
        no_network.assert_not_called()

    def test_incomplete_or_corrupt_download_does_not_install_or_prevent_retry(self):
        with self.assertRaises(OSError):
            downloader.install(self.base, self.version, Mock(side_effect=OSError("offline")))
        self.assertEqual(list(self.base.iterdir()), [])
        with (self.assets / self.archive).open("ab") as file:
            file.write(b"trailing")
        with self.assertRaisesRegex(ValueError, "Checksum"):
            downloader.install(self.base, self.version, self.copy)
        self.assertEqual(list(self.base.iterdir()), [])
        self.fixture()
        downloader.install(self.base, self.version, self.copy)

    def test_rejects_mismatched_manifest_version_and_embedded_bytes(self):
        self.fixture(embedded=b"{}")
        with self.assertRaisesRegex(ValueError, "Embedded"):
            downloader.install(self.base, self.version, self.copy)
        self.manifest = json.dumps({"platform": "linux/amd64", "version": "0.1.0-alpha.5"}).encode()
        self.fixture()
        with self.assertRaisesRegex(ValueError, "version and platform"):
            downloader.install(self.base, self.version, self.copy)
        self.assertEqual(list(self.base.iterdir()), [])

    def test_rejects_extra_or_missing_checksum_and_unsafe_paths(self):
        for text in ["", "0" * 64 + "  unknown\n", (self.assets / "SHA256SUMS").read_text() * 2]:
            with self.subTest(text=text):
                (self.assets / "SHA256SUMS").write_text(text)
                with self.assertRaisesRegex(ValueError, "checksum"):
                    downloader.install(self.base, self.version, self.copy)
        for name in ["elsewhere", "draftmatter-server/../unexpected", "draftmatter-server/link"]:
            with self.subTest(name=name):
                entry = tarfile.TarInfo(name)
                if name.endswith("/link"):
                    entry.type, entry.linkname = tarfile.SYMTYPE, "server-release.json"
                self.fixture(extra=entry)
                with self.assertRaises(ValueError):
                    downloader.install(self.base, self.version, self.copy)
        self.assertEqual(list(self.base.iterdir()), [])

    def test_refuses_unsafe_or_modified_cache_and_leaves_it_untouched(self):
        path = downloader.install(self.base, self.version, self.copy)
        no_network = Mock(side_effect=AssertionError("unexpected download"))
        bundle = path / downloader.BUNDLE
        extra = bundle / "extra"
        extra.write_text("operator note")
        with self.assertRaisesRegex(ValueError, "Unexpected"):
            downloader.install(self.base, self.version, no_network)
        self.assertEqual(extra.read_text(), "operator note")
        extra.unlink()
        installed = bundle / downloader.MANIFEST
        installed.write_text("changed")
        with self.assertRaisesRegex(ValueError, "differs"):
            downloader.install(self.base, self.version, no_network)
        self.assertEqual(installed.read_text(), "changed")
        installed.unlink()
        installed.symlink_to(path / downloader.MANIFEST)
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            downloader.install(self.base, self.version, no_network)
        installed.unlink()
        installed.write_bytes(self.manifest)
        bundle.chmod(0o777)
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            downloader.install(self.base, self.version, no_network)

    def test_rejects_invalid_version_before_accessing_network_or_cache(self):
        for version in ["latest", "server-v0.1.0", "../1.0.0", "0.1.0-alpha.7\n"]:
            with self.assertRaisesRegex(ValueError, "exact server version"):
                downloader.install(self.base, version, Mock(side_effect=AssertionError()))
        self.assertEqual(list(self.base.iterdir()), [])


if __name__ == "__main__":
    unittest.main()

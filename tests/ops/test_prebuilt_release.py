"""Ensure release packaging cannot substitute source revisions or leak local files."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_package", ROOT / "deploy/package_release.py")
PACKAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGE)


class PrebuiltRelease(unittest.TestCase):
    def test_source_snapshot_excludes_untracked_private_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            output = Path(temporary) / "snapshot"
            root.mkdir()
            output.mkdir()
            def git(*args):
                return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()
            git("init", "--quiet")
            (root / "README.md").write_text("public source")
            git("add", "README.md")
            git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
                "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fixture")
            revision = git("rev-parse", "HEAD")
            (root / ".env").write_text("PRIVATE_FIXTURE_NOT_FOR_RELEASE=secret")
            (root / "README.md").write_text("uncommitted content")
            PACKAGE.source_snapshot(root, output, revision)
            self.assertEqual((output / "README.md").read_text(), "public source")
            self.assertFalse((output / ".env").exists())
            self.assertFalse((output / ".git").exists())

    def test_wrong_architecture_and_revision_fail_before_copying(self):
        def inspect(architecture, revision):
            return json.dumps([{"Os": "linux", "Architecture": architecture, "Id": "sha256:fixture",
                                "Config": {"Labels": {"org.opencontainers.image.revision": revision}}}])
        expected = "a" * 40
        for architecture, revision in [("arm64", expected), ("amd64", "b" * 40)]:
            with self.subTest(architecture=architecture, revision=revision):
                with patch.object(PACKAGE, "command", return_value=inspect(architecture, revision)):
                    with self.assertRaises(ValueError):
                        PACKAGE.image_info("fixture", expected)
        with patch.object(PACKAGE, "command", return_value=inspect("amd64", expected)):
            self.assertEqual(PACKAGE.image_info("fixture", expected)["id"], "sha256:fixture")


if __name__ == "__main__":
    unittest.main()

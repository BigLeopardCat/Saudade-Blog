"""Configuration preparation uses disposable paths and never starts Docker."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("stack", ROOT / "deploy/stack.py")
stack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stack)


class ComposeInstall(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.state = self.root / "state"

    def prepare(self, *extra):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            result = stack.main(["--state-dir", str(self.state), "--prepare-only", *extra])
        self.assertEqual(result, 0)
        return output.getvalue()

    def test_first_install_private_credentials_and_independent_databases(self):
        output = self.prepare()
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)
        admin = json.loads((self.state / "administrator.json").read_text())
        self.assertGreaterEqual(len(admin["password"]), 32)
        self.assertNotIn(admin["password"], output)
        for name in ["administrator.json", "backend.env", "agent.env", "postgres.env", "compose.env"]:
            self.assertEqual((self.state / name).stat().st_mode & 0o777, 0o600)
        backend = (self.state / "backend.env").read_text()
        agent = (self.state / "agent.env").read_text()
        self.assertIn("@postgres:5432/saudade_blog", backend)
        self.assertIn("@postgres:5432/saudade_agent", agent)
        self.assertNotIn("JWT_SECRET", agent)
        self.assertNotIn("BLOG_DELEGATION_SECRET", agent)
        self.assertNotEqual(backend.split("@postgres")[0], agent.split("@postgres")[0])

    def test_reuse_preserves_existing_credentials_and_rejects_overwrite(self):
        self.prepare()
        before = {file.name: file.read_bytes() for file in self.state.iterdir() if file.is_file()}
        self.prepare("--reuse")
        self.assertEqual(before, {file.name: file.read_bytes() for file in self.state.iterdir() if file.is_file()})
        with self.assertRaisesRegex(ValueError, "not empty"):
            self.prepare()

    def test_separate_installations_do_not_share_container_or_volume_names(self):
        self.prepare()
        first = (self.state / "compose.env").read_text().splitlines()[0]
        self.state = self.root / "another-state"
        self.prepare()
        second = (self.state / "compose.env").read_text().splitlines()[0]
        self.assertTrue(first.startswith("STACK_NAME=saudade-"))
        self.assertNotEqual(first, second)

    def test_bad_inputs_do_not_create_state(self):
        for options in [("--site-url", "https://example.com/;evil"),
                        ("--site-url", "https://example.com;return"),
                        ("--site-url", "https://user:pw@example.com"),
                        ("--with-scheduler",), ("--with-agent",),
                        ("--admin-user", "admin;sql"),
                        ("--model", "model\nOPENCODE_API_KEY=evil")]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.prepare(*options)
            self.assertFalse(self.state.exists())

    def test_secret_is_literal_and_never_sent_to_subprocess(self):
        key = self.root / "model-key"
        key.write_text('secret$(touch SHOULD_NOT_EXIST)"$with-quotes')
        key.chmod(0o600)
        with patch.object(stack, "agent_source", return_value=(ROOT, "a" * 40)):
            output = self.prepare("--with-agent", "--model-key-file", str(key))
        self.assertIn("OPENCODE_API_KEY=" + key.read_text(), (self.state / "agent.env").read_text())
        self.assertNotIn(key.read_text(), output)
        self.assertFalse((ROOT / "SHOULD_NOT_EXIST").exists())

    def test_shared_or_symlinked_credentials_are_rejected(self):
        self.prepare()
        key = self.state / "backend.env"
        key.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "private regular"):
            self.prepare("--reuse")
        key.chmod(0o600)
        destination = self.root / "original"
        key.rename(destination)
        key.symlink_to(destination)
        with self.assertRaisesRegex(ValueError, "private regular"):
            self.prepare("--reuse")

    def test_tls_redirect_uses_configured_port_and_private_key_owner(self):
        cert, key = self.root / "cert", self.root / "key"
        cert.write_text("test certificate"); key.write_text("test key")
        self.prepare("--site-url", "https://example.com:8443", "--cert", str(cert), "--key", str(key))
        nginx = (self.state / "nginx.conf").read_text()
        self.assertIn("return 308 https://example.com:8443$request_uri", nginx)
        self.assertNotIn("https://$host", nginx)
        self.assertEqual((self.state / "tls/site.key").stat().st_mode & 0o777, 0o600)
        self.assertIn(f"CONFIG_UID={os.geteuid()}", (self.state / "compose.env").read_text())

    def test_prepare_never_invokes_docker_and_schema_excludes_optional_cutovers(self):
        original = stack.run
        def execute(args, **kwargs):
            self.assertNotEqual(args[0], "docker")
            return original(args, **kwargs)
        with patch.object(stack, "run", side_effect=execute):
            self.prepare()
        schema = (self.state / "schema.sql").read_text()
        self.assertIn('CREATE TABLE', schema)
        self.assertNotIn('CREATE EXTENSION IF NOT EXISTS vector', schema)
        self.assertNotIn('DROP COLUMN IF EXISTS tags', schema)

    def test_source_revision_is_rechecked_before_build(self):
        with patch.object(stack, "revision", return_value="a" * 40):
            with self.assertRaisesRegex(ValueError, "pinned revision"):
                stack.verify_source(ROOT, "b" * 40, "deploy/docker/Dockerfile.backend")
        with patch.object(stack, "revision", return_value="a" * 40), patch.object(stack, "run") as run:
            run.return_value.stdout = "?? uncommitted-runtime.py"
            with self.assertRaisesRegex(ValueError, "clean committed"):
                stack.verify_source(ROOT, "a" * 40, "deploy/docker/Dockerfile.backend")

    def test_upgrade_pins_new_revision_without_regenerating_runtime_secrets(self):
        self.prepare()
        before = (self.state / "backend.env").read_bytes()
        with patch.object(stack, "revision", return_value="b" * 40), patch.object(stack, "run") as run:
            run.return_value.stdout = ""
            self.prepare("--reuse", "--upgrade")
        self.assertEqual((self.state / "backend.env").read_bytes(), before)
        self.assertIn("BLOG_REVISION=" + "b" * 40, (self.state / "compose.env").read_text())
        backup = next(self.state.glob("before-*"))
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        self.assertNotEqual(json.loads((backup / "installation.json").read_text())["blog_revision"], "b" * 40)


if __name__ == "__main__":
    unittest.main()

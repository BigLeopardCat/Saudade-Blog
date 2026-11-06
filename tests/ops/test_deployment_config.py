import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("deployment_config", ROOT / "scripts/deploy/deployment_config.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DeploymentConfig(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.file = self.root / "saudade/deploy.env"
        self.file.parent.mkdir()
        self.file.write_text('R2_ENDPOINT=https://r2.example\nR2_ACCESS_KEY=access\n'
                             'R2_SECRET_KEY="literal $value # with spaces"\nR2_BUCKET=artifacts\n')
        self.file.chmod(0o600)
        self.env = {"XDG_CONFIG_HOME": str(self.root)}

    def test_private_config_uses_library_quoting_without_shell_expansion(self):
        before = dict(os.environ)
        result = module.read_deployment_config(self.env)
        self.assertEqual(result["R2_SECRET_KEY"], "literal $value # with spaces")
        self.assertEqual(set(result), set(module.R2_FIELDS))
        self.assertEqual(dict(os.environ), before)

    def test_process_environment_overrides_file_without_importing_other_fields(self):
        result = module.read_deployment_config({**self.env, "R2_BUCKET": "override", "DEPLOY_SHA": "revision"})
        self.assertEqual(result["R2_BUCKET"], "override")
        self.assertNotIn("DEPLOY_SHA", result)

    def test_ci_does_not_access_local_configuration(self):
        env = {key: "ci-" + key for key in module.R2_FIELDS}
        with patch.object(Path, "stat", side_effect=AssertionError("CI read local file")):
            self.assertEqual(module.read_deployment_config(env), env)

    def test_explicit_missing_file_cannot_fall_back_to_environment(self):
        env = {key: "ci" for key in module.R2_FIELDS}
        with self.assertRaises(FileNotFoundError):
            module.read_deployment_config({**env, "SAUDADE_DEPLOY_ENV_FILE": str(self.root / "missing")})

    def test_shared_files_and_symlinks_are_rejected(self):
        for mode in [0o644, 0o640, 0o660]:
            self.file.chmod(mode)
            with self.subTest(mode=mode), self.assertRaisesRegex(ValueError, "owner-only"):
                module.read_deployment_config(self.env)
        self.file.chmod(0o600)
        link = self.root / "alias.env"
        link.symlink_to(self.file)
        with self.assertRaisesRegex(ValueError, "regular file"):
            module.read_deployment_config({"SAUDADE_DEPLOY_ENV_FILE": str(link)})

    def test_runtime_secrets_and_release_revision_are_not_allowed_in_deploy_file(self):
        for key in ["OPENCODE_API_KEY", "JWT_SECRET", "DATABASE_URL", "DEPLOY_SHA"]:
            with self.subTest(key=key):
                original = self.file.read_text()
                self.file.write_text(original + key + "=must-not-be-logged\n")
                with self.assertRaises(ValueError) as caught:
                    module.read_deployment_config(self.env)
                self.assertNotIn("must-not-be-logged", str(caught.exception))
                self.file.write_text(original)

    def test_different_owner_is_rejected(self):
        with patch.object(module.os, "geteuid", return_value=self.file.stat().st_uid + 1):
            with self.assertRaisesRegex(ValueError, "owned by the current user"):
                module.read_deployment_config(self.env)

    def test_checkout_dotenv_is_never_a_fallback(self):
        (self.root / ".env").write_text(self.file.read_text())
        self.file.unlink()
        with self.assertRaises(FileNotFoundError):
            module.read_deployment_config(self.env)

    def test_missing_fields_and_relative_paths_fail(self):
        self.file.write_text("R2_BUCKET=only\n")
        with self.assertRaisesRegex(ValueError, "missing deployment configuration: R2_ENDPOINT"):
            module.read_deployment_config(self.env)
        with self.assertRaisesRegex(ValueError, "absolute path"):
            module.read_deployment_config({"SAUDADE_DEPLOY_ENV_FILE": ".env"})

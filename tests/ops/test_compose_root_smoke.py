"""Privileged container checks are limited to disposable GitHub runner state."""
import importlib.util
import os
import runpy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("root_smoke", ROOT / "deploy/docker/ci-root-smoke.py")
root_smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(root_smoke)


class RootSmokeBoundary(unittest.TestCase):
    def test_bootstrap_smoke_rejects_production_paths_before_reading_configuration(self):
        with tempfile.TemporaryDirectory() as folder:
            runner = Path(folder) / "runner"
            runner.mkdir()
            link = runner / "linked-state"
            link.symlink_to(Path(folder) / "production")
            for state, ci in [(runner / "state", "false"), (Path(folder) / "production", "true"),
                              (link, "true"), (runner, "true")]:
                with self.subTest(state=state, ci=ci), patch.dict(os.environ, {
                    "RUNNER_TEMP": str(runner), "STACK_STATE": str(state), "GITHUB_ACTIONS": ci,
                }), patch("subprocess.run") as execute:
                    with self.assertRaisesRegex(ValueError, "disposable"):
                        runpy.run_path(str(ROOT / "deploy/docker/ci-smoke.py"), run_name="__main__")
                    execute.assert_not_called()

    def test_rejects_normal_installations_and_escaped_paths_before_sudo(self):
        with tempfile.TemporaryDirectory() as folder:
            runner = Path(folder) / "runner"
            runner.mkdir()
            linked = runner / "linked-state"
            linked.symlink_to(Path(folder) / "production")
            for state, ci in [(runner / "state", "false"),
                              (Path(folder) / "production", "true"), (linked, "true"),
                              (runner, "true")]:
                with self.subTest(state=state, ci=ci), patch.dict(os.environ, {
                    "RUNNER_TEMP": str(runner), "ROOT_STATE": str(state), "GITHUB_ACTIONS": ci,
                }), patch.object(root_smoke.subprocess, "run") as execute:
                    with self.assertRaisesRegex(ValueError, "disposable"):
                        root_smoke.main()
                    execute.assert_not_called()


if __name__ == "__main__":
    unittest.main()

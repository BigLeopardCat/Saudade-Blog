"""The destructive recovery drill cannot target a normal local installation."""

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("recovery", ROOT / "deploy/docker/ci-recovery.py")
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class RecoveryBoundary(unittest.TestCase):
    def test_only_disposable_runner_paths_are_accepted(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            runner = root / "runner"
            runner.mkdir()
            escaped = runner / "linked-state"
            escaped.symlink_to(root / "production")
            for state, ci in [(runner / "state", "false"),
                              (root / "production", "true"), (escaped, "true")]:
                with self.subTest(state=state, ci=ci), patch.dict(os.environ, {
                    "RUNNER_TEMP": str(runner), "STACK_STATE": str(state), "GITHUB_ACTIONS": ci,
                }), patch.object(recovery.subprocess, "run") as run:
                    with self.assertRaisesRegex(ValueError, "disposable"):
                        recovery.main()
                    run.assert_not_called()


if __name__ == "__main__":
    unittest.main()

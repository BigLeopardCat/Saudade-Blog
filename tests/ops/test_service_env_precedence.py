import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("isolation", ROOT / "scripts/deploy/render_service_isolation.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ServiceConfiguration(unittest.TestCase):
    def test_units_have_one_configuration_source_and_correct_execution_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            module.render("/home/operator/blog", "/srv/agent", root)
            for service in ["saudade-agent", "saudade-scheduler", "saudade-agent-maintenance", "saudade-rust"]:
                agent = service != "saudade-rust"
                unit = (root / (service + ".service")).read_text()
                self.assertEqual(unit.count("EnvironmentFile="), 1)
                self.assertIn("EnvironmentFile=/etc/saudade/" + ("agent" if agent else "blog") + "-runtime.env\n", unit)
                self.assertIn("User=" + ("saudade-agent" if agent else "saudade-blog") + "\n", unit)
                self.assertNotIn("__", unit)
                self.assertNotIn("/home/operator/blog/saudade-blog-agent", unit)
                dropins = list((root / (service + ".service.d")).iterdir())
                self.assertEqual([path.name for path in dropins], ["90-sandbox.conf"])
                hardening = dropins[0].read_text()
                self.assertIn("ProtectSystem=strict", hardening)
                self.assertIn("ProtectHome=yes", hardening)
                self.assertIn("UMask=0077", hardening)
                if agent:
                    self.assertIn("Environment=SAUDADE_IGNORE_ENV_FILE=1", unit)
                    self.assertIn("WorkingDirectory=/srv/agent/current", unit)
                    self.assertIn("ReadWritePaths=/var/lib/saudade-agent /var/cache/saudade-agent", unit)
                    target = "append:/home/operator/blog/logs/agent/agent.log" if service == "saudade-agent" else "journal"
                    self.assertIn("StandardOutput=" + target + "\n", unit)
                    self.assertIn("StandardError=" + target + "\n", unit)
            self.assertIn("ExecStart=/srv/agent/current/scripts/serve.sh\n", (root / "saudade-agent.service").read_text())
            self.assertIn("ExecStart=/srv/agent/current/scripts/serve_scheduler.sh\n", (root / "saudade-scheduler.service").read_text())
            maintenance = (root / "saudade-agent-maintenance.service").read_text()
            self.assertIn("Type=oneshot", maintenance)
            self.assertIn("-m eval.trace_retention --apply", maintenance)
            self.assertEqual([line for line in maintenance.splitlines()
                              if line.startswith("ExecStart=")], [
                "ExecStart=/srv/agent/current/.venv/bin/python -m eval.trace_retention --apply",
                "ExecStart=/srv/agent/current/.venv/bin/python -m eval.pg_retention --apply",
                "ExecStart=/srv/agent/current/.venv/bin/python -m agent.scheduling.retention --apply",
            ])
            self.assertIn("TimeoutStartSec=600", maintenance)
            self.assertIn("Restart=no", maintenance)
            rust = (root / "saudade-rust.service").read_text()
            self.assertIn("TimeoutStopSec=360", rust)
            self.assertNotIn("saudade-agent/data/word_graph", rust)
            self.assertIn("BindReadOnlyPaths=-/var/lib/saudade-blog/article-graph\n", rust)
            self.assertTrue((root / "saudade-agent-maintenance.timer").is_file())

    def test_existing_output_is_not_mixed_with_generated_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            marker = root / "site-override.conf"
            marker.write_text("keep")
            with self.assertRaisesRegex(ValueError, "empty output"):
                module.render("/srv/blog", "/srv/agent", root)
            self.assertEqual(marker.read_text(), "keep")
            self.assertEqual(len(list(root.iterdir())), 1)

    def test_cli_rejects_unit_directive_injection(self):
        for path in ["relative", "/srv/../private", "/srv/blog\nExecStart=/evil", "/srv/%h", "/srv/blog other"]:
            with self.subTest(path=path), tempfile.TemporaryDirectory() as temporary:
                result = subprocess.run(["python3", str(ROOT / "scripts/deploy/render_service_isolation.py"),
                                         "--app-dir", path, "--output", temporary], capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(list(Path(temporary).iterdir()))

import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("isolation", ROOT / "scripts/deploy/render_service_isolation.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EnvironmentPrecedence(unittest.TestCase):
    def test_legacy_embedding_cannot_restore_hidden_home_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            module.render("/home/operator/blog", "/srv/saudade-agent", root)
            for service in ["saudade-agent", "saudade-scheduler", "saudade-agent-maintenance"]:
                directory = root / (service + ".service.d")
                (directory / "local-embedding.conf").write_text(
                    "[Service]\nEnvironmentFile=/etc/saudade/legacy-embedding.env\n")
                files = []
                for path in sorted(directory.glob("*.conf")):
                    for line in path.read_text().splitlines():
                        if line.startswith("EnvironmentFile="):
                            value = line.split("=", 1)[1]
                            if value: files.append(value)
                            else: files.clear()
                self.assertEqual(files, ["/etc/saudade/agent-runtime.env"])

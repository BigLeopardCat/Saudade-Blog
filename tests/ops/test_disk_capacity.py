import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("capacity", ROOT / "scripts/check_disk_capacity.py")
capacity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capacity)
MIB = 1024 * 1024


class CapacityTests(unittest.TestCase):
    def check(self, total, used, free, **kwargs):
        with patch.object(capacity.shutil, "disk_usage", return_value=shutil._ntuple_diskusage(
                total * MIB, used * MIB, free * MIB)):
            capacity.require_capacity(".", **kwargs)

    def test_normal_headroom(self):
        self.check(40000, 32000, 6000)

    def test_reserved_blocks_do_not_mask_low_headroom(self):
        with self.assertRaises(RuntimeError):
            self.check(40000, 36000, 1000)

    def test_large_filesystem_still_rejects_percent_limit(self):
        with self.assertRaises(RuntimeError):
            self.check(400000, 390000, 10000)

    def test_archive_expansion_must_leave_reserve(self):
        with self.assertRaises(RuntimeError):
            self.check(40000, 32000, 6000, extra_bytes=4000 * MIB)
        self.check(40000, 32000, 6000, extra_bytes=3900 * MIB)

    def test_probe_failure_is_not_success(self):
        with patch.object(capacity.shutil, "disk_usage", side_effect=OSError("unavailable")):
            with self.assertRaises(OSError):
                capacity.require_capacity(".")

    def test_health_check_continues_after_service_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            scripts = root / "scripts"
            scripts.mkdir()
            binary = root / "bin"
            binary.mkdir()
            (scripts / "check_disk_capacity.py").write_text("raise SystemExit(1)\n")
            marker = root / "security_checked"
            (scripts / "check_security_headers.sh").write_text(f"touch '{marker}'\n")
            for name, body in {
                "curl": "printf 000; exit 7",
                "systemctl": "printf 4",
                "pgrep": "exit 1",
                "logger": "exit 0",
            }.items():
                path = binary / name
                path.write_text("#!/bin/sh\n" + body + "\n")
                path.chmod(0o700)
            result = subprocess.run(["bash", str(ROOT / "scripts/healthcheck.sh")],
                                    env={**os.environ, "PROJECT_DIR": temp,
                                         "HOME": temp, "NGX_ERR_LOG": str(root / "nginx.log"),
                                         "PATH": f"{binary}:{os.environ['PATH']}"},
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(marker.exists())
            log = (root / "logs/health.log").read_text()
            self.assertIn("FAIL Rust", log)
            self.assertIn("FAIL agent", log)


if __name__ == "__main__":
    unittest.main()

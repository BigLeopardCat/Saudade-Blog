import http.server
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[2]
CHECKS = ROOT / "scripts/deploy/backend_checks.sh"


class BackendProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.response = {"status": 200, "body": b'{"ready":true}', "paths": []}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                cls.response["paths"].append(self.path)
                self.send_response(cls.response["status"])
                self.send_header("Content-Length", str(len(cls.response["body"])))
                self.end_headers()
                self.wfile.write(cls.response["body"])

            def log_message(self, *_args):
                pass

        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def check(self, status, body):
        self.response.update(status=status, body=body)
        return subprocess.run(["bash", "-c", 'source "$1"; backend_ready', "probe", str(CHECKS)],
                              env={**os.environ, "DEPLOY_PYTHON": sys.executable,
                                   "SAUDADE_BACKEND_BASE_URL": f"http://127.0.0.1:{self.server.server_port}"},
                              capture_output=True, timeout=5)

    def test_only_explicit_json_readiness_and_http_200_pass(self):
        for status, body, passes in [
            (200, b'{"ready":true}', True),
            (200, b'{"ready":false}', False),
            (200, b'{"ready":1}', False),
            (200, b'{"ready":"true"}', False),
            (200, b'{"alive":true}', False),
            (200, b'[]', False),
            (200, b'', False),
            (200, b'<html>ready</html>', False),
            (405, b'{"ready":true}', False),
            (500, b'{"ready":true}', False),
            (503, b'{"ready":true}', False),
            (302, b'{"ready":true}', False),
            (200, b'{"ready":true,"padding":"' + b'x' * 4096 + b'"}', False),
        ]:
            with self.subTest(status=status, body=body[:50]):
                result = self.check(status, body)
                self.assertEqual(result.returncode == 0, passes, result.stderr)
                self.assertEqual(result.stdout, b'')
        self.assertEqual(set(self.response["paths"]), {"/api/health/ready"})

    def test_curl_failure_cannot_be_repaired_by_success_shaped_output(self):
        script = r"""source "$1"; curl() { printf '{"ready":true}\n200'; return 7; }; backend_ready"""
        result = subprocess.run(["bash", "-c", script, "probe", str(CHECKS)],
                                env={**os.environ, "DEPLOY_PYTHON": sys.executable},
                                capture_output=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)


class BackendRevisionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git("init", "-q")
        (self.root / "src").mkdir()
        (self.root / "src/main.rs").write_text("fn main() {}\n")
        self.before = self.commit()
        (self.root / "README.md").write_text("deployment notes\n")
        self.docs = self.commit()
        (self.root / "src/main.rs").write_text("fn main() { println!(\"changed\"); }\n")
        self.backend = self.commit()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.PIPE).decode().strip()

    def commit(self):
        self.git("add", ".")
        self.git("-c", "user.name=CI fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def unchanged(self, previous, current):
        return subprocess.run(["bash", "-c", 'source "$1"; backend_unchanged "$2" "$3"',
                               "revision", str(CHECKS), previous, current], cwd=self.root,
                              capture_output=True, timeout=5)

    def test_only_two_present_revisions_with_unchanged_backend_skip_restart(self):
        self.assertEqual(self.unchanged(self.before, self.docs).returncode, 0)
        for previous, current in [(self.docs, self.backend), (self.before, "0" * 40),
                                  ("0" * 40, self.backend), ("", self.backend),
                                  (self.backend, self.backend)]:
            with self.subTest(previous=previous, current=current):
                result = self.unchanged(previous, current)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stderr, b'')


if __name__ == "__main__":
    unittest.main()

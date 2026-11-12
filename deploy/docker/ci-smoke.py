#!/usr/bin/env python3
"""Exercise only the disposable Compose stack created by container CI."""
import json
import http.client
import importlib.util
import os
from pathlib import Path
import subprocess
import ssl
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
STATE = Path(os.environ["STACK_STATE"])
DC = ["docker", "compose", "--project-directory", str(STATE), "--env-file", str(STATE / "compose.env"),
      "-f", str(ROOT / "deploy/docker/compose.yaml"), "--profile", "agent", "--profile", "scheduler"]


def command(*args):
    return subprocess.run([*DC, *args], check=True, capture_output=True, text=True, timeout=60).stdout


def query(sql):
    return command("exec", "-T", "postgres", "psql", "-X", "-U", "postgres", "-d", "saudade_blog",
                   "-At", "-v", "ON_ERROR_STOP=1", "-c", sql).strip()


def main():
    config = json.loads(command("config", "--format", "json"))
    for service in ["postgres", "backend", "agent", "scheduler"]:
        assert not config["services"][service].get("ports"), "private service has published ports"
    assert config["services"]["backend"].get("read_only")
    assert config["services"]["agent"].get("read_only")
    assert query("SELECT count(*) FROM public.\"user\" WHERE role = 'admin'") == "1"
    before = query('SELECT password FROM public."user" WHERE role = \'admin\'')
    assert before.startswith("$argon2id$"), "bootstrap must use the current password algorithm"
    command("run", "--rm", "--no-deps", "bootstrap")
    assert query('SELECT password FROM public."user" WHERE role = \'admin\'') == before, "bootstrap reset credentials"
    assert query("SELECT has_table_privilege('saudade_app', 'public.note', 'INSERT')") == "t"
    assert query("SELECT has_schema_privilege('saudade_app', 'public', 'CREATE')") == "f"
    assert query("SELECT has_database_privilege('saudade_agent', 'saudade_blog', 'CONNECT')") == "f"
    assert query("SELECT has_database_privilege('saudade_app', 'saudade_agent', 'CONNECT')") == "f"
    credentials = json.loads((STATE / "administrator.json").read_text())
    payload = json.dumps({name: credentials[name] for name in ["username", "password"]}).encode()
    request = urllib.request.Request("http://127.0.0.1:8080/api/login", data=payload,
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as response:
        login = json.load(response)
    assert login["code"] == 200 and login["data"], "first administrator cannot log in"
    with urllib.request.urlopen("http://127.0.0.1:8080/api/health/ready", timeout=10) as response:
        assert json.load(response)["ready"] is True
    with urllib.request.urlopen("http://127.0.0.1:8080/build-info.json", timeout=10) as response:
        assert json.load(response)["sha"] == os.environ["GITHUB_SHA"]
    probe = "import json,urllib.request; r=json.load(urllib.request.urlopen('http://127.0.0.1:8010/version',timeout=5)); assert r['sha']=='" + json.loads((STATE / "installation.json").read_text())["agent_revision"] + "'"
    command("exec", "-T", "agent", "python", "-c", probe)
    command("exec", "-T", "frontend", "nginx", "-t")
    command("exec", "-T", "frontend", "test", "-s", "/usr/share/doc/saudade/ASSETS-LICENSE.md")
    assert command("ps", "--status", "running", "--services").splitlines().count("scheduler") == 1
    print("Compose smoke passed: readiness, administrator login, idempotence, role isolation and pinned versions")
    # The same unprivileged nginx must read owner-only renewed TLS files.
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-subj", "/CN=localhost", "-keyout", str(STATE / "tls/site.key"),
                    "-out", str(STATE / "tls/site.crt")],
                   check=True, capture_output=True, timeout=30)
    for name in ["site.crt", "site.key"]:
        (STATE / "tls" / name).chmod(0o600)
    spec = importlib.util.spec_from_file_location("stack", ROOT / "deploy/stack.py")
    stack = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stack)
    (STATE / "nginx.conf").write_text(stack.nginx_text(True, "https://localhost:8443"))
    command("exec", "-T", "frontend", "nginx", "-t")
    command("exec", "-T", "frontend", "nginx", "-s", "reload")
    # Self-signed certificates are confined to this disposable loopback test.
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.load_verify_locations(str(STATE / "tls/site.crt"))
    import time
    for attempt in range(20):
        try:
            with urllib.request.urlopen("https://127.0.0.1:8443/api/health/ready", context=context,
                                        timeout=3) as response:
                assert json.load(response)["ready"] is True
            break
        except OSError:
            if attempt == 19:
                raise
            time.sleep(0.25)
    connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=5)
    connection.request("GET", "/")
    response = connection.getresponse()
    assert response.status == 308 and response.getheader("Location") == "https://localhost:8443/"
    connection.close()
    print("TLS smoke passed: private certificate access, config reload, HTTPS readiness and canonical redirect")


if __name__ == "__main__":
    main()

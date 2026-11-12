#!/usr/bin/env python3
"""Exercise only the disposable Compose stack created by container CI."""
import json
import os
from pathlib import Path
import subprocess
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


if __name__ == "__main__":
    main()

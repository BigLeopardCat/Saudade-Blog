#!/usr/bin/env python3
"""Exercise only the disposable Compose stack created by container CI."""
import base64
import json
import http.client
import importlib.util
import os
from pathlib import Path
import subprocess
import ssl
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
if os.environ.get("GITHUB_ACTIONS") != "true":
    raise ValueError("smoke requires disposable GitHub runner state")
STATE = Path(os.environ["STACK_STATE"]).resolve()
RUNNER = Path(os.environ["RUNNER_TEMP"]).resolve()
if STATE == RUNNER or not STATE.is_relative_to(RUNNER):
    raise ValueError("smoke requires disposable GitHub runner state")
INSTALLATION = json.loads((STATE / "installation.json").read_text())
DC = ["docker", "compose", "--project-directory", str(STATE), "--env-file", str(STATE / "compose.env"),
      "-f", str(ROOT / "deploy/docker/compose.yaml")]
for enabled, profile in [(INSTALLATION["with_agent"], "agent"),
                         (INSTALLATION["with_scheduler"], "scheduler")]:
    if enabled:
        DC.extend(["--profile", profile])


def command(*args):
    return subprocess.run([*DC, *args], check=True, capture_output=True, text=True, timeout=60).stdout


def query(sql):
    return command("exec", "-T", "postgres", "psql", "-X", "-U", "postgres", "-d", "saudade_blog",
                   "-At", "-v", "ON_ERROR_STOP=1", "-c", sql).strip()


def featured_album(token):
    def api(path, body=None):
        headers = {"Authorization": f"Bearer {token}"} if path.startswith("/api/protect") else {}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        request = urllib.request.Request("http://127.0.0.1:8080" + path, data=data, headers=headers)
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    assert api("/api/public/featured-photos")["data"] == []
    original = api("/api/protected/websetting")["data"]
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==")
    for index in range(2):
        boundary = "saudade-album-ci-boundary"
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="album-{index}.png"\r\n'
                'Content-Type: image/png\r\n\r\n').encode() + png + f"\r\n--{boundary}--\r\n".encode()
        request = urllib.request.Request("http://127.0.0.1:8080/api/protect/upload", data=body,
            headers={"Authorization": f"Bearer {token}", "Content-Type": f"multipart/form-data; boundary={boundary}"})
        with urllib.request.urlopen(request, timeout=10) as response:
            assert json.load(response)["code"] == 200
    images = api("/api/protect/gallery/images?limit=2")["data"]["items"]
    selected = [{"imageId": image["imageKey"], "caption": f"春日 {index}"} for index, image in enumerate(images)]
    assert len(selected) == 2
    assert api("/api/protected/websetting", {"featuredPhotos": selected})["code"] == 200
    photos = api("/api/public/featured-photos")["data"]
    assert [photo["imageId"] for photo in photos] == [item["imageId"] for item in selected]
    assert all(set(photo) == {"imageId", "url", "caption"} for photo in photos)
    for photo in photos:
        assert photo["url"].startswith("/api/public/media/")
        with urllib.request.urlopen("http://127.0.0.1:8080" + photo["url"], timeout=10) as response:
            assert response.read() == png
    rejected = api("/api/protected/websetting", {"blogTitle": "must not be saved", "featuredPhotos": [{"imageId": 2147483647, "caption": "missing"}]})
    assert rejected["code"] != 200
    assert api("/api/protected/websetting")["data"]["blogTitle"] == original["blogTitle"]
    image_id = selected[0]["imageId"]
    # Exercise an older gallery entry that has not been assigned a stable public ID.
    query(f"BEGIN; UPDATE images SET image_url=(SELECT source_url FROM image_location WHERE image_id={image_id}) WHERE image_key={image_id}; DELETE FROM image_location WHERE image_id={image_id}; COMMIT;")
    assert api("/api/protected/websetting", {"featuredPhotos": selected})["code"] == 200
    legacy = api("/api/public/featured-photos")["data"][0]
    assert legacy["url"].startswith("/api/protect/download/")
    assert api("/api/protected/websetting", {"featuredPhotos": []})["code"] == 200
    assert api("/api/public/featured-photos")["data"] == []
    print("Featured album smoke passed: selected-only publication, real media, legacy images, order and atomic validation")


def main():
    config = json.loads(command("config", "--format", "json"))
    private_services = ["postgres", "backend"]
    if INSTALLATION["with_agent"]:
        private_services.append("agent")
    if INSTALLATION["with_scheduler"]:
        private_services.append("scheduler")
    for service in private_services:
        assert not config["services"][service].get("ports"), "private service has published ports"
    assert config["services"]["backend"].get("read_only")
    if INSTALLATION["with_agent"]:
        assert config["services"]["agent"].get("read_only")
    assert query("SELECT count(*) FROM public.\"user\" WHERE role = 'superadmin'") == "1"
    before = query('SELECT password FROM public."user" WHERE role = \'superadmin\'')
    assert before.startswith("$argon2id$"), "bootstrap must use the current password algorithm"
    command("run", "--rm", "--no-deps", "bootstrap")
    assert query('SELECT password FROM public."user" WHERE role = \'superadmin\'') == before, "bootstrap reset credentials"
    # Existing accounts are never promoted or reset, including an installation with no administrator.
    try:
        for role in ["admin", "user"]:
            query(f"UPDATE public.\"user\" SET role = '{role}'")
            snapshot = query('SELECT id,username,nickname,password,role FROM public."user" ORDER BY id')
            if role == "admin":
                command("run", "--rm", "--no-deps", "bootstrap")
            else:
                try:
                    command("run", "--rm", "--no-deps", "bootstrap")
                except subprocess.CalledProcessError as error:
                    assert "bootstrap requires an empty user table" in error.stderr
                else:
                    raise AssertionError("bootstrap promoted an existing non-administrator")
            assert query('SELECT id,username,nickname,password,role FROM public."user" ORDER BY id') == snapshot
    finally:
        query("UPDATE public.\"user\" SET role = 'superadmin'")
    assert query('SELECT password FROM public."user"') == before
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
    featured_album(login["data"])
    payload = login["data"].split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    assert claims["role"] == "superadmin", "first login did not receive superadministrator privileges"
    assert query('SELECT username FROM public."user"') == credentials["username"]
    with urllib.request.urlopen("http://127.0.0.1:8080/api/health/ready", timeout=10) as response:
        assert json.load(response)["ready"] is True
    with urllib.request.urlopen("http://127.0.0.1:8080/build-info.json", timeout=10) as response:
        assert json.load(response)["sha"] == os.environ["GITHUB_SHA"]
    if INSTALLATION["with_agent"]:
        probe = "import json,urllib.request; r=json.load(urllib.request.urlopen('http://127.0.0.1:8010/version',timeout=5)); assert r['sha']=='" + INSTALLATION["agent_revision"] + "'"
        command("exec", "-T", "agent", "python", "-c", probe)
    else:
        assert config["services"]["backend"]["environment"]["AGENT_URL"] == ""
    with urllib.request.urlopen("http://127.0.0.1:8080/api/public/notes", timeout=10) as response:
        assert json.load(response)["code"] == 200, "core article reads require an optional service"
    frontend_uid, frontend_gid = config["services"]["frontend"]["user"].split(":")
    assert int(frontend_uid) > 0
    assert command("exec", "-T", "frontend", "id", "-u").strip() == frontend_uid
    assert command("exec", "-T", "frontend", "stat", "-c", "%u:%g:%a", "/tmp").strip() == f"{frontend_uid}:{frontend_gid}:700"
    assert config["services"]["frontend"]["read_only"] is True
    assert config["services"]["frontend"]["cap_drop"] == ["ALL"]
    status = command("exec", "-T", "frontend", "cat", "/proc/1/status")
    assert int(next(line.split()[1] for line in status.splitlines() if line.startswith("CapEff:")), 16) == 0
    command("exec", "-T", "frontend", "nginx", "-t")
    command("exec", "-T", "frontend", "test", "-s", "/usr/share/doc/saudade/ASSETS-LICENSE.md")
    running = command("ps", "--status", "running", "--services").splitlines()
    assert running.count("agent") == int(INSTALLATION["with_agent"])
    assert running.count("scheduler") == int(INSTALLATION["with_scheduler"])
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
    stack.configure_frontend(STATE)
    assert (STATE / "tls").stat().st_mode & 0o777 == 0o700
    assert command("exec", "-T", "frontend", "stat", "-c", "%u:%g:%a", "/etc/nginx/tls/site.key").strip() == f"{frontend_uid}:{frontend_gid}:600"
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
    # nginx briefly serves the previous configuration while old workers drain.
    for attempt in range(20):
        connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=5)
        try:
            connection.request("GET", "/")
            response = connection.getresponse()
            observed = (response.status, response.getheader("Location"))
        finally:
            connection.close()
        if observed == (308, "https://localhost:8443/"):
            break
        if attempt == 19:
            raise AssertionError(f"TLS redirect did not converge: {observed}")
        time.sleep(0.25)
    command("up", "--no-build", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "60", "frontend")
    with urllib.request.urlopen("https://127.0.0.1:8443/api/health/ready", context=context, timeout=10) as response:
        assert json.load(response)["ready"] is True
    print("TLS smoke passed: private certificate access, config reload, clean restart and canonical redirect")


if __name__ == "__main__":
    main()

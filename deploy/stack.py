#!/usr/bin/env python3
"""Prepare private PostgreSQL stack configuration and run Docker Compose."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
from urllib.parse import quote, urlsplit

ROOT = Path(__file__).resolve().parents[1]


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def revision(source):
    value = run(["git", "-C", str(source), "rev-parse", "HEAD"],
                capture_output=True, text=True).stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError("source must have a full Git revision")
    return value


def private_file(path, text, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "w") as stream:
        stream.write(text)


def environment(values):
    for key, value in values.items():
        if "\n" in str(value) or "\r" in str(value) or "\x00" in str(value):
            raise ValueError(f"multiline environment value is not supported: {key}")
    return "".join(f"{key}={value}\n" for key, value in values.items())


def validate_site(value):
    url = urlsplit(value)
    if (url.scheme not in {"http", "https"} or not url.hostname or url.username
            or url.password or url.query or url.fragment or url.path not in {"", "/"}):
        raise ValueError("site URL must be an HTTP(S) origin without credentials or a path")
    if not re.fullmatch(r"[A-Za-z0-9.:-]+|\[[0-9A-Fa-f:]+\](?::[0-9]+)?", url.netloc):
        raise ValueError("invalid site URL")
    if url.port is not None and not 1 <= url.port <= 65535:
        raise ValueError("invalid site port")
    return value.rstrip("/")


def private_regular(path):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077
            or info.st_uid != os.geteuid()):
        raise ValueError("configuration must be a private regular file owned by the current user")


def safe_path(path):
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(path)):
        raise ValueError("deployment paths must be absolute without whitespace or shell metacharacters")


def agent_source(args, output):
    lock = json.loads((ROOT / "deploy/docker/agent.lock.json").read_text())
    commit = args.agent_revision or lock["revision"]
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Agent revision must be a full SHA")
    if args.agent_source:
        source = Path(args.agent_source).resolve()
    else:
        source = output / "agent-source"
        run(["git", "init", "--quiet", str(source)])
        run(["git", "-C", str(source), "fetch", "--depth=1", lock["repository"], commit])
        run(["git", "-C", str(source), "checkout", "--quiet", "--detach", "FETCH_HEAD"])
    if revision(source) != commit or not (source / "Dockerfile").is_file():
        raise ValueError("Agent source must match the revision and contain its Dockerfile")
    if run(["git", "-C", str(source), "status", "--porcelain", "--untracked-files=no"],
           capture_output=True, text=True).stdout:
        raise ValueError("Agent source has uncommitted tracked changes")
    return source, commit


def schema_text():
    path = ROOT / "scripts/migration/pg/ci_schema_files.py"
    spec = importlib.util.spec_from_file_location("saudade_schema", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return "\n".join((path.parent / name).read_text() for name in module.LOAD)


def nginx_text(tls, site):
    server = """server {
    listen 8080;
    server_name _;
    root /srv/frontend/dist;
    client_max_body_size 25m;
    include /etc/nginx/snippets/blog-headers/*.conf;
    location = /healthz { access_log off; return 200 'ok\\n'; }
    location /api/ {
        proxy_pass http://backend:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 360s;
    }
    location / { try_files $uri $uri/ /index.html; }
}
"""
    if tls:
        server = server.replace("listen 8080;", "listen 8443 ssl;\n    ssl_certificate /etc/nginx/tls/site.crt;\n    ssl_certificate_key /etc/nginx/tls/site.key;")
        server += ("server { listen 8080; server_name _; location = /healthz { return 200 'ok\\n'; } "
                   "location / { return 308 " + site + "$request_uri; } }\n")
    return server


def prepare(args, output):
    safe_path(output)
    safe_path(ROOT)
    site = validate_site(args.site_url)
    if args.with_scheduler and not args.with_agent:
        raise ValueError("--with-scheduler requires --with-agent")
    if bool(args.cert) != bool(args.key):
        raise ValueError("provide both --cert and --key")
    if args.cert and not site.startswith("https://"):
        raise ValueError("TLS certificates require an HTTPS site URL")
    if not 1 <= args.http_port <= 65535 or not 1 <= args.https_port <= 65535:
        raise ValueError("invalid published port")
    import ipaddress
    address = ipaddress.ip_address(args.bind)
    if not re.fullmatch(r"[A-Za-z0-9_.-]{3,64}", args.admin_user):
        raise ValueError("administrator username must contain 3-64 ASCII letters, digits, _, . or -")
    if not args.admin_nickname.strip() or len(args.admin_nickname) > 64:
        raise ValueError("invalid administrator nickname")
    if args.model_key_file:
        private_regular(Path(args.model_key_file))
    # Validate all user-controlled environment values before creating any files.
    environment({"model": args.model, "site": site})
    certificates = {name: Path(source).read_text() for name, source in
                    [("site.crt", args.cert), ("site.key", args.key)] if source}
    if certificates and not all(certificates.values()):
        raise ValueError("certificate and key must not be empty")
    if args.agent_source:
        safe_path(Path(args.agent_source).resolve())
    if output.exists() and any(output.iterdir()):
        raise ValueError("state directory is not empty; use --reuse to preserve existing configuration")
    key = ""
    if args.model_key_file:
        key_path = Path(args.model_key_file)
        if key_path.stat().st_mode & 0o077 or key_path.stat().st_size > 8192:
            raise ValueError("model key file must be private (0600) and at most 8192 bytes")
        key = key_path.read_text().strip()
    if args.with_agent and not key:
        raise ValueError("--with-agent requires a private --model-key-file")
    environment({"model key": key})
    output.mkdir(parents=True, mode=0o700, exist_ok=True)
    output.chmod(0o700)
    agent, agent_rev = (agent_source(args, output) if args.with_agent
                        else (ROOT, "disabled"))
    blog_rev = revision(ROOT)
    app_password, agent_password, pg_password = (secrets.token_hex(24) for _ in range(3))
    assertion = secrets.token_hex(32)
    credentials = {"username": args.admin_user, "nickname": args.admin_nickname,
                   "password": secrets.token_hex(20)}
    private_file(output / "administrator.json", json.dumps(credentials, ensure_ascii=False) + "\n")
    private_file(output / "postgres.env", environment({
        "POSTGRES_PASSWORD": pg_password, "POSTGRES_DB": "postgres",
        "SAUDADE_APP_PASSWORD": app_password, "SAUDADE_AGENT_PASSWORD": agent_password,
    }))
    private_file(output / "backend.env", environment({
        "DATABASE_URL": f"postgresql://saudade_app:{quote(app_password)}@postgres:5432/saudade_blog",
        "BLOG_BIND_ADDRESS": "0.0.0.0", "BLOG_PORT": 3000, "SITE_URL": site,
        "JWT_SECRET": secrets.token_hex(32), "BLOG_DELEGATION_SECRET": secrets.token_hex(32),
        "AGENT_ASSERTION_SECRET": assertion, "AGENT_URL": "http://agent:8010/chat",
        "UPLOAD_DIR": "/var/lib/saudade/uploads", "IOT_ENABLED": "0",
    }))
    private_file(output / "agent.env", environment({
        "LLM_PROVIDER": "opencode", "OPENCODE_API_KEY": key,
        "OPENCODE_BASE_URL": "https://opencode.ai/zen/go/v1",
        "OPENCODE_MODEL": args.model, "SAUDADE_IGNORE_ENV_FILE": "1",
        "AGENT_ASSERTION_SECRET": assertion, "AGENT_CONFIRM_SECRET": secrets.token_hex(32),
        "BLOG_API_BASE": site + "/api/public", "BLOG_INTERNAL_API_BASE": "http://backend:3000/api/public",
        "AGENT_ADMIN_BASE": "http://backend:3000",
        "CHECKPOINT_DSN": f"postgresql://saudade_agent:{quote(agent_password)}@postgres:5432/saudade_agent",
        "CHECKPOINT_FORBID_DB": "saudade_blog", "SCHEDULING_ENABLED": str(args.with_scheduler).lower(),
        "RAG_HYBRID_ENABLED": "false", "IOT_ENABLED": "false",
        "TRACE_DIR": "/var/lib/saudade-agent/traces",
        "DELEGATION_DIR": "/var/lib/saudade-agent/delegations",
    }))
    private_file(output / "schema.sql", schema_text(), 0o644)
    private_file(output / "nginx.conf", nginx_text(bool(args.cert), site), 0o644)
    tls_dir = output / "tls"
    tls_dir.mkdir(mode=0o700)
    for name, contents in certificates.items():
        private_file(tls_dir / name, contents)
    values = {"STACK_NAME": "saudade-" + hashlib.sha256(str(output).encode()).hexdigest()[:12],
              "BLOG_SOURCE": str(ROOT), "BLOG_REVISION": blog_rev,
              "AGENT_SOURCE": str(agent), "AGENT_REVISION": agent_rev,
              "SITE_URL": site, "BIND_ADDRESS": f"[{address}]" if address.version == 6 else str(address),
              "HTTP_PORT": args.http_port, "HTTPS_PORT": args.https_port,
              "CONFIG_UID": os.geteuid(), "CONFIG_GID": os.getegid()}
    private_file(output / "compose.env", environment(values))
    manifest = {"format": 1, "site_url": site, "with_agent": args.with_agent,
                "with_scheduler": args.with_scheduler, "blog_revision": blog_rev,
                "agent_revision": agent_rev}
    private_file(output / "installation.json", json.dumps(manifest, indent=2) + "\n")
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", default=str(Path.home() / ".local/share/saudade/compose"))
    parser.add_argument("--site-url", default="http://localhost:8080")
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--http-port", type=int, default=8080)
    parser.add_argument("--https-port", type=int, default=8443)
    parser.add_argument("--cert"); parser.add_argument("--key")
    parser.add_argument("--with-agent", action="store_true")
    parser.add_argument("--with-scheduler", action="store_true")
    parser.add_argument("--agent-source"); parser.add_argument("--agent-revision")
    parser.add_argument("--model-key-file")
    parser.add_argument("--model", default="deepseek-v4.1-flash")
    parser.add_argument("--admin-user", default="admin")
    parser.add_argument("--admin-nickname", default="站长")
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--no-build", action="store_true", help="use previously loaded SHA-tagged images")
    parser.add_argument("--reuse", action="store_true")
    parser.add_argument("--upgrade", action="store_true",
                        help="with --reuse, select the current clean blog revision after manual backup/schema review")
    args = parser.parse_args(argv)
    if args.upgrade and not args.reuse:
        raise ValueError("--upgrade requires --reuse")
    if Path(args.state_dir).expanduser().is_symlink():
        raise ValueError("state directory must not be a symlink")
    output = Path(args.state_dir).expanduser().resolve()
    safe_path(output)
    if args.reuse:
        if output.stat().st_mode & 0o077 or output.stat().st_uid != os.geteuid():
            raise ValueError("state directory must be private (0700)")
        private_regular(output / "installation.json")
        manifest = json.loads((output / "installation.json").read_text())
        if manifest.get("format") != 1:
            raise ValueError("unsupported installation format")
        for name in ["administrator.json", "backend.env", "agent.env", "postgres.env", "compose.env"]:
            private_regular(output / name)
        if args.upgrade:
            if run(["git", "-C", str(ROOT), "status", "--porcelain", "--untracked-files=no"],
                   capture_output=True, text=True).stdout:
                raise ValueError("upgrade from a clean committed checkout")
            commit = revision(ROOT)
            if commit != manifest["blog_revision"]:
                backup = output / ("before-" + manifest["blog_revision"] + "-" + secrets.token_hex(4))
                backup.mkdir(mode=0o700)
                for name in ["compose.env", "installation.json"]:
                    private_file(backup / name, (output / name).read_text())
                values = (output / "compose.env").read_text().splitlines()
                values = ["BLOG_REVISION=" + commit if line.startswith("BLOG_REVISION=") else
                          "BLOG_SOURCE=" + str(ROOT) if line.startswith("BLOG_SOURCE=") else line
                          for line in values]
                manifest["blog_revision"] = commit
                for name, contents in [("compose.env", "\n".join(values) + "\n"),
                                       ("installation.json", json.dumps(manifest, indent=2) + "\n")]:
                    temporary = output / (name + ".next")
                    private_file(temporary, contents)
                    temporary.replace(output / name)
    else:
        manifest = prepare(args, output)
    print(f"Private configuration: {output}; administrator credentials: {output / 'administrator.json'}")
    if args.prepare_only:
        return 0
    if run(["git", "-C", str(ROOT), "status", "--porcelain", "--untracked-files=no"],
           capture_output=True, text=True).stdout:
        raise ValueError("build from a clean committed checkout")
    if revision(ROOT) != manifest["blog_revision"]:
        raise ValueError("source revision changed; follow the documented upgrade procedure")
    version = run(["docker", "compose", "version", "--short"], capture_output=True, text=True).stdout
    numbers = re.search(r"(\d+)\.(\d+)", version)
    if not numbers or tuple(map(int, numbers.groups())) < (2, 30):
        raise ValueError("Docker Compose 2.30+ is required for raw environment files")
    command = ["docker", "compose", "--project-directory", str(output), "--env-file",
               str(output / "compose.env"), "-f", str(ROOT / "deploy/docker/compose.yaml")]
    for enabled, profile in [(manifest["with_agent"], "agent"), (manifest["with_scheduler"], "scheduler")]:
        if enabled:
            command += ["--profile", profile]
    run([*command, "up", "--no-build" if args.no_build else "--build",
         "--wait", "--wait-timeout", "180"])
    print("Stack ready. Database volumes and existing credentials are preserved on --reuse.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        # Do not include subprocess output, DSNs or supplied key values.
        print(f"Deployment stopped: {error if isinstance(error, ValueError) else type(error).__name__}", file=sys.stderr)
        sys.exit(1)

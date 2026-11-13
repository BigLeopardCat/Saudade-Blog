#!/usr/bin/env python3
"""Backup and restore only the disposable stack created by GitHub container CI."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def main():
    runner = Path(os.environ["RUNNER_TEMP"]).resolve()
    state = Path(os.environ["STACK_STATE"]).resolve()
    if os.environ.get("GITHUB_ACTIONS") != "true" or not state.is_relative_to(runner):
        raise ValueError("recovery drill requires the disposable GitHub runner state")
    dc = ["docker", "compose", "--project-directory", str(state), "--env-file",
          str(state / "compose.env"), "-f", str(ROOT / "deploy/docker/compose.yaml"),
          "--profile", "agent", "--profile", "scheduler"]

    def command(*args, **kwargs):
        options = {"check": True, "timeout": 180, "stderr": subprocess.PIPE}
        if not kwargs:
            options.update(capture_output=True, text=True)
            options.pop("stderr")
        return subprocess.run([*dc, *args], **options, **kwargs)

    def query(db, sql):
        return command("exec", "-T", "postgres", "psql", "-X", "-U", "postgres",
                       "-d", db, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql).stdout.strip()

    checkpoint_code = """
import json, os
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.base import empty_checkpoint
from langgraph.checkpoint.postgres import PostgresSaver
with PostgresSaver.from_conn_string(os.environ['CHECKPOINT_DSN']) as saver:
    saver.setup()
    checkpoint = empty_checkpoint()
    checkpoint['channel_values'] = {'messages': [HumanMessage(content='release recovery fixture')]}
    checkpoint['channel_versions'] = {'messages': '1'}
    config = saver.put({'configurable': {'thread_id': 'release-recovery', 'checkpoint_ns': ''}},
                       checkpoint, {'source': 'input', 'step': 0, 'parents': {}}, {'messages': '1'})
    print(json.dumps(config))
"""
    checkpoint = json.loads(command("exec", "-T", "agent", "python", "-c", checkpoint_code).stdout)
    marker = "saudade disposable restore fixture"
    command("exec", "-T", "backend", "sh", "-c",
            "printf '%s' 'saudade disposable restore fixture' > /var/lib/saudade/uploads/release-recovery.txt")
    original = query("saudade_blog", 'SELECT id,password FROM public."user" ORDER BY id')
    command("stop", "scheduler", "agent", "backend")
    with tempfile.TemporaryDirectory(prefix="saudade-backup-", dir=runner) as folder:
        backup = Path(folder)
        hashes = {}
        for source, restored in [("saudade_blog", "saudade_blog_restore"),
                                 ("saudade_agent", "saudade_agent_restore")]:
            path = backup / (source + ".dump")
            with path.open("xb") as stream:
                path.chmod(0o600)
                command("exec", "-T", "postgres", "pg_dump", "-U", "postgres", "-Fc", source,
                        stdout=stream)
            hashes[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
            command("exec", "-T", "postgres", "createdb", "-U", "postgres", restored)
            with path.open("rb") as stream:
                command("exec", "-T", "postgres", "pg_restore", "-U", "postgres", "--exit-on-error",
                        "-d", restored, stdin=stream, stdout=subprocess.DEVNULL)
        assert query("saudade_blog_restore", 'SELECT id,password FROM public."user" ORDER BY id') == original
        uploads = backup / "uploads.tar"
        with uploads.open("xb") as stream:
            uploads.chmod(0o600)
            command("run", "--rm", "--no-deps", "-T", "--entrypoint", "tar", "backend",
                    "-C", "/var/lib/saudade", "-cf", "-", "uploads",
                    stdout=stream)
        hashes[uploads.name] = hashlib.sha256(uploads.read_bytes()).hexdigest()
        command("run", "--rm", "--no-deps", "-T", "--entrypoint", "rm", "backend",
                "/var/lib/saudade/uploads/release-recovery.txt")
        with uploads.open("rb") as stream:
            command("run", "--rm", "--no-deps", "-T", "--entrypoint", "tar", "backend",
                    "-C", "/var/lib/saudade", "-xf", "-",
                    stdin=stream, stdout=subprocess.DEVNULL)
        command("up", "--no-build", "--wait", "--wait-timeout", "180")
        assert command("exec", "-T", "backend", "cat", "/var/lib/saudade/uploads/release-recovery.txt").stdout == marker
        verify = """
import json, os
from psycopg.conninfo import make_conninfo
from langgraph.checkpoint.postgres import PostgresSaver
config = json.loads(os.environ['RECOVERY_CHECKPOINT'])
with PostgresSaver.from_conn_string(make_conninfo(os.environ['CHECKPOINT_DSN'], dbname='saudade_agent_restore')) as saver:
    saved = saver.get_tuple(config)
    assert saved is not None
    assert saved.checkpoint['channel_values']['messages'][0].content == 'release recovery fixture'
"""
        command("exec", "-T", "-e", "RECOVERY_CHECKPOINT=" + json.dumps(checkpoint),
                "agent", "python", "-c", verify)
        # Reject an invalid configuration, then restore the same verified image and credentials.
        backend_hash = hashlib.sha256((state / "backend.env").read_bytes()).hexdigest()
        invalid = backup / "invalid-backend.yaml"
        invalid.write_text('services:\n  backend:\n    environment:\n      JWT_SECRET: short\n')
        try:
            command("-f", str(invalid), "up", "--no-build", "--no-deps", "--force-recreate",
                    "--wait", "--wait-timeout", "15", "backend")
        except subprocess.CalledProcessError:
            rejected = command("logs", "--no-color", "--tail", "80", "backend")
            assert "JWT_SECRET must be a private random key of at least 32 bytes" in rejected.stdout + rejected.stderr
        else:
            raise AssertionError("invalid configuration unexpectedly became ready")
        finally:
            command("up", "--no-build", "--no-deps", "--force-recreate",
                    "--wait", "--wait-timeout", "180", "backend")
        assert hashlib.sha256((state / "backend.env").read_bytes()).hexdigest() == backend_hash
        ready = command("exec", "-T", "backend", "curl", "--noproxy", "*", "--fail",
                        "--silent", "http://127.0.0.1:3000/api/health/ready").stdout
        assert json.loads(ready)["ready"] is True
        for database in ["saudade_blog_restore", "saudade_agent_restore"]:
            command("exec", "-T", "postgres", "dropdb", "-U", "postgres", database)
        print(json.dumps({"database_restore": True, "checkpoint_restore": True,
                          "uploads_restore": True, "failed_configuration_rollback": True,
                          "sha256": hashes}))


if __name__ == "__main__":
    main()

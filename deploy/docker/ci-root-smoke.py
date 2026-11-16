#!/usr/bin/env python3
"""Verify a root-owned installation using only disposable GitHub runner state."""
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def main():
    runner = Path(os.environ["RUNNER_TEMP"]).resolve()
    state = Path(os.environ["ROOT_STATE"]).resolve()
    if os.environ.get("GITHUB_ACTIONS") != "true" or state.parent != runner:
        raise ValueError("root smoke requires disposable GitHub runner state")
    environment = {"GITHUB_ACTIONS": "true", "RUNNER_TEMP": str(runner),
                   "STACK_STATE": str(state), "GITHUB_SHA": os.environ["GITHUB_SHA"],
                   "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "safe.directory",
                   "GIT_CONFIG_VALUE_0": str(ROOT)}

    def execute(*args):
        subprocess.run(["sudo", "-n", "env", *[f"{key}={value}" for key, value in environment.items()],
                        *args], check=True, timeout=240)

    password = runner / "root-bootstrap-password"
    execute("python3", "-c",
            "import os,sys; fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); "
            "os.write(fd,b'ci-only-custom-bootstrap-password'); os.close(fd)", str(password))
    try:
        execute("bash", str(ROOT / "deploy/install.sh"), "--state-dir", str(state),
                "--admin-user", "site-owner-ci", "--admin-nickname", "CI site owner",
                "--admin-password-file", str(password), "--prepare-only")
        execute("bash", str(ROOT / "deploy/install.sh"), "--state-dir", str(state), "--reuse", "--no-build")
        execute("python3", str(ROOT / "deploy/docker/ci-smoke.py"))
    finally:
        execute("rm", "-f", str(password))


if __name__ == "__main__":
    main()

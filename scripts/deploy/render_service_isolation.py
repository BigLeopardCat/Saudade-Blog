#!/usr/bin/env python3
"""Render service drop-ins without changing accounts, credentials or live units."""
import argparse
import re
from pathlib import Path


def safe_path(value: str) -> str:
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", value) or ".." in Path(value).parts:
        raise argparse.ArgumentTypeError("use an absolute path without whitespace, specifiers or ..")
    return value.rstrip("/")


def render(app_dir: str, release_root: str, output: Path) -> None:
    templates = Path(__file__).resolve().parents[2] / "deploy/systemd"
    sandbox = (templates / "service-sandbox.conf").read_text()
    for service, kind in [("saudade-rust", "rust"), ("saudade-agent", "agent"),
                          ("saudade-scheduler", "agent"), ("saudade-agent-maintenance", "agent")]:
        directory = output / (service + ".service.d")
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "90-sandbox.conf").write_text(sandbox)
        text = (templates / (kind + "-isolation.conf.template")).read_text()
        text = text.replace("__APP_DIR__", app_dir).replace("__RELEASE_ROOT__", release_root)
        (directory / "91-isolation.conf").write_text(text)
        if service == "saudade-scheduler":
            text = (templates / "scheduler-isolation.conf.template").read_text()
            (directory / "99-entry.conf").write_text(text.replace("__RELEASE_ROOT__", release_root))
        elif service == "saudade-agent-maintenance":
            (directory / "99-entry.conf").write_text(
                "[Service]\nExecStart=\nExecStart=" + release_root +
                "/current/.venv/bin/python -m eval.trace_retention --apply\n")
    for name in ["agent-maintenance.service", "agent-maintenance.timer"]:
        (output / ("saudade-" + name)).write_text((templates / name).read_text().replace(
            "/srv/saudade-agent", release_root))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-dir", required=True, type=safe_path)
    parser.add_argument("--release-root", type=safe_path, default="/srv/saudade-agent")
    parser.add_argument("--output", required=True, type=Path)
    options = parser.parse_args()
    render(options.app_dir, options.release_root, options.output)

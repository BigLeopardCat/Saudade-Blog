#!/usr/bin/env python3
"""Render complete service units and shared hardening without changing live services."""

import argparse
import re
from pathlib import Path


def safe_path(value: str) -> str:
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", value) or ".." in Path(value).parts:
        raise argparse.ArgumentTypeError("use an absolute path without whitespace, specifiers or ..")
    return value.rstrip("/") or "/"


def render(app_dir: str, release_root: str, output: Path) -> None:
    app_dir, release_root = safe_path(app_dir), safe_path(release_root)
    templates = Path(__file__).resolve().parents[2] / "deploy/systemd"
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError("use an empty output directory; existing overrides must be reviewed separately")
    sandbox = (templates / "service-sandbox.conf").read_text()
    agent = (templates / "saudade-agent.service.template").read_text()
    services = {
        "saudade-agent": ("Saudade Blog Agent", "simple", "scripts/serve.sh", "always"),
        "saudade-scheduler": ("Saudade administrator background tasks", "exec", "scripts/serve_scheduler.sh", "on-failure"),
        "saudade-agent-maintenance": ("Saudade Agent private trace retention", "oneshot", ".venv/bin/python -m eval.trace_retention --apply", "no"),
    }
    for service, (description, kind, command, restart) in services.items():
        text = agent.replace("__DESCRIPTION__", description).replace("__TYPE__", kind)
        text = text.replace("__COMMAND__", release_root + "/current/" + command)
        text = text.replace("__RESTART__", restart)
        (output / (service + ".service")).write_text(
            text.replace("__APP_DIR__", app_dir).replace("__RELEASE_ROOT__", release_root))
    (output / "saudade-rust.service").write_text(
        (templates / "saudade-rust.service.template").read_text().replace("__APP_DIR__", app_dir))
    for service in [*services, "saudade-rust"]:
        directory = output / (service + ".service.d")
        directory.mkdir()
        (directory / "90-sandbox.conf").write_text(sandbox)
    (output / "saudade-agent-maintenance.timer").write_text(
        (templates / "agent-maintenance.timer").read_text())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-dir", required=True, type=safe_path)
    parser.add_argument("--release-root", type=safe_path, default="/srv/saudade-agent")
    parser.add_argument("--output", required=True, type=Path)
    options = parser.parse_args()
    render(options.app_dir, options.release_root, options.output)

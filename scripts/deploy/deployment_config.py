"""Read deployment-only credentials without sourcing checkout configuration."""

import os
import stat
from pathlib import Path
from typing import Mapping

from dotenv import dotenv_values

R2_FIELDS = ("R2_ENDPOINT", "R2_ACCESS_KEY", "R2_SECRET_KEY", "R2_BUCKET")


def read_deployment_config(environ: Mapping[str, str] | None = None) -> dict[str, str]:
    env = os.environ if environ is None else environ
    explicit = env.get("SAUDADE_DEPLOY_ENV_FILE")
    base = Path(env.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    path = Path(explicit) if explicit else base / "saudade/deploy.env"
    if not path.is_absolute():
        raise ValueError("SAUDADE_DEPLOY_ENV_FILE must be an absolute path")

    values = {}
    # CI injects all four fields; it must not consult the runner's local files.
    if explicit or not all(env.get(key) for key in R2_FIELDS):
        if path.is_symlink():
            raise ValueError("deployment configuration must be a private regular file")
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid():
            raise ValueError("deployment configuration must be owner-only and owned by the current user")
        values = dict(dotenv_values(path, interpolate=False))
        if set(values) - set(R2_FIELDS):
            raise ValueError("deployment configuration may contain only the four R2 deployment fields")

    result = {key: env.get(key, values.get(key)) for key in R2_FIELDS}
    missing = [key for key, value in result.items() if not value or not value.strip()]
    if missing:
        raise ValueError("missing deployment configuration: " + ", ".join(missing))
    return result

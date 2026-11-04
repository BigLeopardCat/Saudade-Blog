#!/usr/bin/env python3
"""Read-only capacity check shared by monitoring and deployment."""

import argparse
import shutil


def require_capacity(path, *, min_free_mib=2048, extra_bytes=0, max_used_percent=95):
    usage = shutil.disk_usage(path)
    reserve = min_free_mib * 1024 * 1024
    available = usage.free - extra_bytes
    # free excludes filesystem-reserved blocks unavailable to the service user.
    used_percent = 100 * usage.used / (usage.used + usage.free)
    if available < reserve or used_percent >= max_used_percent:
        raise RuntimeError(
            f"disk_capacity path={path} used={used_percent:.1f}% "
            f"free_mib={usage.free // 1048576} required_mib={(reserve + extra_bytes) // 1048576}"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path")
    parser.add_argument("--min-free-mib", type=int, default=2048)
    parser.add_argument("--max-used-percent", type=int, default=95)
    args = parser.parse_args()
    try:
        require_capacity(args.path, min_free_mib=args.min_free_mib,
                         max_used_percent=args.max_used_percent)
    except (OSError, RuntimeError) as error:
        parser.exit(1, f"{error}\n")

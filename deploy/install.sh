#!/usr/bin/env bash
# First-install entry point; private configuration is generated without sourcing shell files.
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec python3 "$repo/deploy/stack.py" "$@"

#!/bin/bash
# Shared deployment and monitoring checks; uncertain results never pass readiness.

backend_ready() {
  local reply code body
  reply=$(curl --noproxy '*' --silent --connect-timeout 1 --max-time 3 \
    --max-filesize 4096 --write-out '\n%{http_code}' \
    "${SAUDADE_BACKEND_BASE_URL:-http://127.0.0.1:3000}/api/health/ready") || return 1
  code=${reply##*$'\n'}
  [ "$code" = "200" ] || return 1
  body=${reply%$'\n'*}
  printf '%s' "$body" | "${DEPLOY_PYTHON:-python3}" -c '
import json, sys
try:
    body = json.load(sys.stdin)
except (ValueError, OSError):
    raise SystemExit(1)
raise SystemExit(0 if isinstance(body, dict) and body.get("ready") is True else 1)
' 2>/dev/null
}

backend_unchanged() {
  local previous=$1 current=$2
  [[ "$previous" =~ ^[0-9a-f]{40}$ && "$current" =~ ^[0-9a-f]{40}$ ]] \
    && [ "$previous" != "$current" ] \
    && git cat-file -e "${previous}^{commit}" 2>/dev/null \
    && git cat-file -e "${current}^{commit}" 2>/dev/null \
    && git diff --quiet "$previous" "$current" -- src Cargo.toml Cargo.lock 2>/dev/null
}

#!/usr/bin/env bash

set -euo pipefail

VENV=/app/.venv
SITE_CRT=/etc/ssl/extra/trusted.crt
BUNDLE=/tmp/saudade-ca-bundle.pem

if [ ! -x "$VENV/bin/python" ]; then
    echo "✗ 找不到 $VENV/bin/python —— 镜像没装好（uv sync 那一步失败了？）" >&2
    exit 1
fi

CERTIFI="$("$VENV/bin/python" -c 'import certifi; print(certifi.where())')"
if [ ! -f "$CERTIFI" ]; then
    echo "✗ certifi 的根证书包不存在：$CERTIFI" >&2
    exit 1
fi

# 缺席 = 硬失败：静默放行会让站内只读工具全部降级为"服务不可用"，且日志没有 ERROR。
if [ ! -f "$SITE_CRT" ]; then
    echo "✗ 站点证书不在 $SITE_CRT —— 宿主侧没跑 prepare.sh，或者 generated/ssl/trusted.crt 没挂进来。" >&2
    echo "  （不装信任的后果不是报错，是站内只读工具全部静默降级成「服务不可用」。）" >&2
    exit 1
fi

cat "$CERTIFI" "$SITE_CRT" > "$BUNDLE"
export SSL_CERT_FILE="$BUNDLE"
echo "[entrypoint] CA bundle 已就位：$(grep -c 'BEGIN CERTIFICATE' "$BUNDLE" || true) 张证书（certifi + 站点自签）"

# 参数与 systemd 模板逐字一致：--host 127.0.0.1 是硬编码回环；--no-access-log 必须保留，
# 可观测性由 server.py 的生命周期日志提供。只有 worker 数可调（默认 4，与 unit 同值），
# 小内存机器设 AGENT_WORKERS=2，其余参数不要改。
exec "$VENV/bin/uvicorn" server:app \
    --host 127.0.0.1 \
    --port 8010 \
    --workers "${AGENT_WORKERS:-4}" \
    --no-access-log

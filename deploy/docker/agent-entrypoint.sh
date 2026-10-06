#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  agent 容器的入口：**先让站点的自签证书受信，再起 uvicorn**
#
#  为什么必须有这一步：agent 的每一个只读工具都走 `tools/base.py` 的 httpx 客户端，而那里
#  刻意保留 `verify=True`（20260829 的 TLS 加固，不许改成 False——一改就是"证书错也照样
#  把内容读进来"，属于静默降级里最坏的一种）。自签证书下不装信任的后果**不是报错**，
#  而是全部站内工具返回 `unavailable`：对话照常回，只是它永远说"我查不到"。
#
#  做法是**拼接**而不是替换：`certifi` 那份是公共 CA（对话侧调 LLM 的 HTTPS 靠它），
#  站点证书另接在末尾。httpx 打开 `trust_env=True` 时会读 `SSL_CERT_FILE`，所以只要
#  这个变量在 exec 之前 export 好，父进程 fork 出来的 4 个 worker 全部继承。
#
#  ⚠️ bundle 写 /tmp 而不是 /run 或 /app：容器可能以**宿主用户**的身份跑（compose 的
#     `user:`，为了让宿主目录里的 uploads/traces 属主正常），而那两处对它不可写。
# ═══════════════════════════════════════════════════════════════════════════════
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

# 缺席 = 硬失败。这里的失败必须是响亮的：静默放行的话，症状是几周后有人问
# "为什么看板娘答不出站里的事"，而日志里一条 ERROR 都没有。
if [ ! -f "$SITE_CRT" ]; then
    echo "✗ 站点证书不在 $SITE_CRT —— 宿主侧没跑 prepare.sh，或者 generated/ssl/trusted.crt 没挂进来。" >&2
    echo "  （不装信任的后果不是报错，是站内只读工具全部静默降级成「服务不可用」。）" >&2
    exit 1
fi

cat "$CERTIFI" "$SITE_CRT" > "$BUNDLE"
export SSL_CERT_FILE="$BUNDLE"
echo "[entrypoint] CA bundle 已就位：$(grep -c 'BEGIN CERTIFICATE' "$BUNDLE" || true) 张证书（certifi + 站点自签）"

# 参数与 systemd 模板逐字一致（--host 127.0.0.1 是硬编码的回环；--no-access-log 是必须的：
# 可观测性由 server.py 自己的生命周期日志提供，access log 只会把同一条信息再说一遍）。
# 只有 worker 数留了一个拨盘（默认 4，与 unit 同值）——小内存机器上想降到 2 就设
# AGENT_WORKERS=2，其余参数不要改。
exec "$VENV/bin/uvicorn" server:app \
    --host 127.0.0.1 \
    --port 8010 \
    --workers "${AGENT_WORKERS:-4}" \
    --no-access-log

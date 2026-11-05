#!/bin/bash
# Run deployment independently of SSH lifetime and propagate its result to CI.

set -e

cd "${PROJECT_DIR:-/home/ubuntu/Saudade-Blog}"

SHA="${1:-}"
mkdir -p logs
LOG="logs/deploy.log"


RULE="================================================================================"
banner() {
  echo "" >> "$LOG"
  echo "$RULE" >> "$LOG"
  echo "$1" >> "$LOG"
  echo "$RULE" >> "$LOG"
}
close_deploy() {
  echo "$RULE" >> "$LOG"
  echo "--- $(date '+%Y-%m-%d %H:%M:%S') 部署结束：$1 ---" >> "$LOG"
  echo "$RULE" >> "$LOG"
  echo "" >> "$LOG"
}

if [ -n "$SHA" ]; then
  banner "=== $(date '+%Y-%m-%d %H:%M:%S') 触发部署 sha=$SHA ==="
else
  banner "=== $(date '+%Y-%m-%d %H:%M:%S') 触发部署（未指定 sha，脚本按 latest.txt 解析）==="
fi

DEPLOY_SHA="$SHA" nohup bash scripts/deploy/deploy_from_r2.sh >> "$LOG" 2>&1 &
PID=$!

# 等它结束，上限 10 分钟（正常：下载 + 解压 + 重启 ≈ 10-60 秒）
for _ in $(seq 1 120); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 5
done

if kill -0 "$PID" 2>/dev/null; then
  close_deploy "未结束（等满 10 分钟，部署仍在后台跑）"
  echo "❌ $(date '+%H:%M:%S') 等满 10 分钟仍未结束（部署仍在后台跑，见 $LOG）"
  exit 2
fi
if wait "$PID"; then
  close_deploy "成功"
  echo "✅ $(date '+%H:%M:%S') 部署成功"
else
  close_deploy "失败（详见本段日志）"
  echo "❌ $(date '+%H:%M:%S') 部署失败，详见 $LOG"
  exit 1
fi

#!/bin/bash
# CI 的部署触发入口（服务器侧）。用法：bash scripts/deploy/trigger_deploy.sh <完整提交号>
#
# 为什么要有它：原先 CI 那步是
#   ssh ... "nohup bash deploy_from_r2.sh > logs/deploy.log 2>&1 &"
# 挂到后台就立刻返回，**部署崩了 CI 照样是绿的**。20260923 实测：两个 run 互相覆盖产物、
# 后端那一半根本没落地，而两次 CI 都是 success——CI 的绿灯对部署结果没有任何含义。
#
# 这里同样把部署放进 nohup（ssh 断线不会让部署半路夭折），但**在同一个 ssh 会话里等它结束**，
# 于是 ssh 的退出码 = 部署结果，CI 的绿灯才真的代表"部署成功"。
set -e
cd /home/ubuntu/memory_blog_rust

SHA="${1:-}"
mkdir -p logs
LOG="logs/deploy.log"

if [ -n "$SHA" ]; then
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') 触发部署 sha=$SHA ===" >> "$LOG"
else
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') 触发部署（未指定 sha，脚本按 latest.txt 解析）===" >> "$LOG"
fi

DEPLOY_SHA="$SHA" nohup bash scripts/deploy/deploy_from_r2.sh >> "$LOG" 2>&1 &
PID=$!

# 等它结束，上限 10 分钟（正常：下载 + 解压 + 重启 ≈ 10-60 秒）
for _ in $(seq 1 120); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 5
done

if kill -0 "$PID" 2>/dev/null; then
  echo "❌ $(date '+%H:%M:%S') 等满 10 分钟仍未结束（部署仍在后台跑，见 $LOG）"
  exit 2
fi
if wait "$PID"; then
  echo "✅ $(date '+%H:%M:%S') 部署成功"
else
  echo "❌ $(date '+%H:%M:%S') 部署失败，详见 $LOG"
  exit 1
fi

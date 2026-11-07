#!/bin/bash
# Check services and incremental logs; keep optional job and diagnostic results distinct.
# Read-only service and capacity monitoring, run once per minute.
umask 077
PROJECT_DIR="${PROJECT_DIR:-/home/ubuntu/Saudade-Blog}"
LOG="$PROJECT_DIR/logs/health.log"
STAMP="$PROJECT_DIR/logs/.health_state"
TS=$(date "+%Y-%m-%d %H:%M:%S%z")
fail() { echo "$TS $*" >> "$LOG"; }
mkdir -p "$PROJECT_DIR/logs"
exec 8>"$PROJECT_DIR/logs/.health.lock"
flock -n 8 || exit 0
if [ -f "$STAMP" ]; then . "$STAMP"; fi
capacity=$(python3 "$PROJECT_DIR/scripts/check_disk_capacity.py" "$PROJECT_DIR" --max-used-percent 90 2>&1) ||
  { fail "WARN $capacity"; logger -t saudade-health -- "$capacity"; }

source "$(dirname "${BASH_SOURCE[0]}")/deploy/backend_checks.sh"
backend_ready || fail "FAIL Rust 3000 /api/health/ready"
agent_code=$(curl --noproxy '*' -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:8010/ready)
[ "$agent_code" != "200" ] && fail "FAIL agent 8010 /ready HTTP $agent_code"

# systemd tracks the service independently of entrypoint names and worker counts.
for service in saudade-rust saudade-agent; do
  restarts=$(systemctl show "$service" -p NRestarts --value 2>/dev/null)
  case "$restarts" in ''|*[!0-9]*) fail "WARN 无法读取 $service 重启计数"; continue ;; esac
  key=${service//-/_}_restarts
  previous=${!key:-}
  if [ -n "$previous" ] && [ "$restarts" -gt "$previous" ]; then
    fail "WARN $service 自动重启计数 $previous → $restarts"
  fi
  printf -v "$key" '%s' "$restarts"
done
printf 'saudade_rust_restarts=%s\nsaudade_agent_restarts=%s\n' "${saudade_rust_restarts:-0}" "${saudade_agent_restarts:-0}" > "$STAMP"


NGX_ERR="${NGX_ERR_LOG:-/var/log/nginx/error.log}"
ngx_size=$(stat -c %s "$NGX_ERR" 2>/dev/null || echo 0)
[ "$ngx_size" -lt "${NGX_ERR_SIZE:-0}" ] && NGX_ERR_SIZE=0
if [ "$ngx_size" -gt "${NGX_ERR_SIZE:-0}" ]; then
  matched=$(tail -c $((ngx_size - ${NGX_ERR_SIZE:-0})) "$NGX_ERR" | grep -E "\[(error|crit|alert|emerg)\]" | tail -3 | tr '\n' ';')
  [ -n "$matched" ] && fail "WARN nginx error.log 新错误级日志（截取3条）: $matched"
fi
echo "NGX_ERR_SIZE=$ngx_size" >> "$STAMP"

PW_MAX_MIN=60
for p in $(pgrep -f 'ms-playwright/chromium-[0-9]' 2>/dev/null); do
  et=$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' ')
  [ -z "$et" ] && continue
  [ "$et" -le $((PW_MAX_MIN * 60)) ] && continue

  killed=0
  for q in $(pgrep -f 'ms-playwright/chromium-[0-9]' 2>/dev/null); do
    case "$(readlink -f /proc/$q/exe 2>/dev/null)" in
      *ms-playwright*) kill -9 "$q" 2>/dev/null && killed=$((killed + 1)) ;;
    esac
  done
  fail "WARN 无头浏览器残留 pid=$p 已跑 $((et / 3600))h（验收脚本被掐断留下的孤儿）→ 清理 $killed 个进程"
  break
done

SENTINELS="$HOME/agent_regression.failed $HOME/sandbox_regression.failed"
sent_sig=""
for s in $SENTINELS; do
  [ -f "$s" ] && sent_sig="$sent_sig $(basename "$s"):$(stat -c %Y "$s" 2>/dev/null || echo 0)"
done
if [ -n "$sent_sig" ] && [ "$sent_sig" != "${LAST_SENTINEL:-}" ]; then
  fail "WARN 夜间任务留下失败哨兵:$sent_sig（看 ~/agent_regression.log、~/sandbox_regression.log）"
fi
echo "LAST_SENTINEL='$sent_sig'" >> "$STAMP"


AGENT_LOG="$PROJECT_DIR/logs/agent/agent.log"
agent_size=$(stat -c %s "$AGENT_LOG" 2>/dev/null || echo 0)
[ "$agent_size" -lt "${AGENT_LOG_SIZE:-0}" ] && AGENT_LOG_SIZE=0
if [ "$agent_size" -gt "${AGENT_LOG_SIZE:-0}" ]; then
  wire=$(tail -c $((agent_size - ${AGENT_LOG_SIZE:-0})) "$AGENT_LOG" \
         | grep -c "wire_illegal" || true)
  [ "${wire:-0}" -gt 0 ] && fail "WARN agent 出站序列不合严格服务商协议 ${wire} 次；请核对对应 trace 与服务商响应"
fi
echo "AGENT_LOG_SIZE=$agent_size" >> "$STAMP"


hdr_sh="$PROJECT_DIR/scripts/check_security_headers.sh"
if [ -f "$hdr_sh" ]; then
  hdr_out=$(bash "$hdr_sh" 2>&1) || \
    fail "WARN 安全响应头缺失：$(printf '%s' "$hdr_out" | tr '\n' '; ' | cut -c1-180)"
else
  fail "WARN 安全响应头这一项没验（找不到 $hdr_sh）"
fi


METRICS_DAY="$PROJECT_DIR/logs/.health_metrics_day"
TODAY=$(date +%Y%m%d)
if [ "$(cat "$METRICS_DAY" 2>/dev/null)" != "$TODAY" ]; then
  echo "$TODAY" > "$METRICS_DAY"     # 先落印再跑：当天失败不重复执行，避免每分钟刷告警
  AGENT_DIR="$PROJECT_DIR/saudade-blog-agent"
  dm="$AGENT_DIR/eval/daily_metrics.py"
  if [ -f "$dm" ]; then
    dm_out=$(cd "$AGENT_DIR" && timeout 180 .venv/bin/python eval/daily_metrics.py 2>&1)
    dm_rc=$?
    if [ "$dm_rc" = "0" ] && [ -n "$dm_out" ]; then
      echo "$TS METRICS $dm_out" >> "$LOG"
    else
      fail "WARN 每日观测没跑出来（rc=$dm_rc）：$(printf '%s' "$dm_out" | tail -2 | tr '\n' ';' | cut -c1-200)"
    fi
  else
    fail "WARN 每日观测脚本不在场（$dm），本轮未采集每日观测"
  fi
fi
exit 0

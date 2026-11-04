#!/bin/bash
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

# GET on the POST-only login route verifies that the router is reachable.
code=$(curl --noproxy '*' -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:3000/api/login)
[ "$code" != "405" ] && [ "$code" != "200" ] && fail "FAIL Rust 3000 HTTP $code"
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

# 4. nginx error.log 增量扫描（20260830，监控补齐 C）：nginx 日志保持 distro 位置
# （/var/log/nginx，发行版 logrotate 管轮转），探针盯增量——记录上次字节数，
# tail -c 增量段 grep 错误级别（error/crit/alert/emerg），发现即 WARN。
# 文件变小（轮转/截断）时重置基线。
NGX_ERR="${NGX_ERR_LOG:-/var/log/nginx/error.log}"
ngx_size=$(stat -c %s "$NGX_ERR" 2>/dev/null || echo 0)
[ "$ngx_size" -lt "${NGX_ERR_SIZE:-0}" ] && NGX_ERR_SIZE=0
if [ "$ngx_size" -gt "${NGX_ERR_SIZE:-0}" ]; then
  matched=$(tail -c $((ngx_size - ${NGX_ERR_SIZE:-0})) "$NGX_ERR" | grep -E "\[(error|crit|alert|emerg)\]" | tail -3 | tr '\n' ';')
  [ -n "$matched" ] && fail "WARN nginx error.log 新错误级日志（截取3条）: $matched"
fi
echo "NGX_ERR_SIZE=$ngx_size" >> "$STAMP"
# 5. 无头浏览器残留（20260917 事故：load 3.9 的根因）
#    验收脚本被 timeout 掐断 / 崩掉时，Playwright 的 Chromium 会变成**孤儿进程**
#    （父进程死 → 被 init 收养）继续跑：2026-08-31 启动的那只带软件 WebGL
#    （--use-angle=swiftshader-webgl），GPU 进程常驻 216% CPU + 一个 renderer 28%，
#    跑了 16 天没人发现，把 load average 顶到 3.9。合法测试不会超过一小时 ⇒
#    超过 60 分钟一律判残留：记 WARN 并清掉（否则会一直烧 CPU / 拖慢整机）。
PW_MAX_MIN=60
for p in $(pgrep -f 'ms-playwright/chromium-[0-9]' 2>/dev/null); do
  et=$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' ')
  [ -z "$et" ] && continue
  [ "$et" -le $((PW_MAX_MIN * 60)) ] && continue
  # ⚠️ 杀之前**按 /proc/<pid>/exe 复核**：不用 pkill -f 模式匹配——调用方命令行里
  #    恰好含这个模式时（比如手工带参跑），pkill 会把调用方自己一起杀掉（踩过两次）。
  killed=0
  for q in $(pgrep -f 'ms-playwright/chromium-[0-9]' 2>/dev/null); do
    case "$(readlink -f /proc/$q/exe 2>/dev/null)" in
      *ms-playwright*) kill -9 "$q" 2>/dev/null && killed=$((killed + 1)) ;;
    esac
  done
  fail "WARN 无头浏览器残留 pid=$p 已跑 $((et / 3600))h（验收脚本被掐断留下的孤儿）→ 清理 $killed 个进程"
  break
done
# 6. 夜间任务失败哨兵（20260924）
#    夜间两班（04:00 的 agent 回归 saudade-blog-agent/scripts/nightly_regression.sh、
#    04:40 的前端渲染层沙箱 scripts/nightly_sandboxes.sh）失败时会在 ~ 下留一个
#    *.failed 哨兵文件，**存在 = 上次运行失败**；全绿则自己删掉。
#    这里把两个哨兵的 mtime 拼成签名，只在**签名变化**时报一条 WARN——边沿触发，不会
#    每分钟刷屏。哨兵每晚失败都被 touch（mtime 前进），所以"一直失败"是每晚一条、
#    "修好了"则签名变空、静默（干净夜里 health.log 一行都不多）。
#    判 WARN 不判 FAIL：服务都还活着，是测试套件红，不是线上挂了。
#    ⚠️ **20261017 起两班都"默认不装"**（仓库口径：公开仓库不替克隆的人决定每天烧多少额度；
#    开关分别是 agent 仓的 scripts/enable_nightly.sh 与下面的 crontab 行）。**没装 ⇒ 两个哨兵
#    恒不存在 ⇒ 这一项恒静默**。静默在这里**不是绿**，是"这一项没在验"——缺键绝不读成 0
#    （本仓老账）。所以别拿"health.log 里没有哨兵 WARN"当夜间跑过且通过的证据。
SENTINELS="$HOME/agent_regression.failed $HOME/sandbox_regression.failed"
sent_sig=""
for s in $SENTINELS; do
  [ -f "$s" ] && sent_sig="$sent_sig $(basename "$s"):$(stat -c %Y "$s" 2>/dev/null || echo 0)"
done
if [ -n "$sent_sig" ] && [ "$sent_sig" != "${LAST_SENTINEL:-}" ]; then
  fail "WARN 夜间任务留下失败哨兵:$sent_sig（看 ~/agent_regression.log、~/sandbox_regression.log）"
fi
echo "LAST_SENTINEL='$sent_sig'" >> "$STAMP"

# 7. agent.log 出站协议违规增量扫描（20261012）
#    `agent/graph.py` 在 narrator 那次 LLM 调用之前挂了一道**出站合规绊线**
#    （`context.strict_wire_issues`）：序列不合严格服务商协议时只记一条 ERROR
#    （含 `wire_illegal` 锚点）与一条 trace 事件，**绝不改序列**（理由见那里）。
#    问题在于**生产跑在 qwen 上时它永远是绿的**——qwen 容忍那两条非法形状，
#    于是 20260928 那个"`tool_call_id` 重复"的洞在库里躺了 8 天，直到换服务商才炸
#    （deepseek 整轮 400）。**绊线红了却只在日志里 = 没有出口**，这一项就是那个出口：
#    形状与第 4 项（nginx error.log 增量）逐条相同——记字节基线、只扫增量段、
#    文件变小（logrotate copytruncate）就重置基线。
#    取证锚点用 ASCII 单 token `wire_illegal`（与 trace 事件同名），**不 grep 那句中文**：
#    句子改一个字就断的取证，断掉时是静默的。
AGENT_LOG="$PROJECT_DIR/logs/agent/agent.log"
agent_size=$(stat -c %s "$AGENT_LOG" 2>/dev/null || echo 0)
[ "$agent_size" -lt "${AGENT_LOG_SIZE:-0}" ] && AGENT_LOG_SIZE=0
if [ "$agent_size" -gt "${AGENT_LOG_SIZE:-0}" ]; then
  wire=$(tail -c $((agent_size - ${AGENT_LOG_SIZE:-0})) "$AGENT_LOG" \
         | grep -c "wire_illegal" || true)
  [ "${wire:-0}" -gt 0 ] && fail "WARN agent 出站序列不合严格服务商协议 ${wire} 次（绊线只报不修；查 graph._frame_id 与 context.with_tool_call_pairs 的配对）"
fi
echo "AGENT_LOG_SIZE=$agent_size" >> "$STAMP"

# 8. 全站安全响应头（20261015）
#    五条头（nosniff / Referrer-Policy / X-Frame-Options / Permissions-Policy / HSTS）
#    **只活在 /etc/nginx**：不在部署包里、不经 CI、不受任何测试覆盖，改坏它此前
#    没有任何东西会红——正是本仓反复吃过的那类"配置漂移无人喊"。
#    判据只有一份：`scripts/check_security_headers.sh`（`deploy_from_r2.sh` 末尾跑的
#    是同一个；那份是**非致命**的部署日志，真正的喊人出口是这里 —— 写 health.log）。
#    这一项只判"头在不在"：nginx 挂了拿不到响应由第 1/4 项负责，不在这里重复报。
hdr_sh="$PROJECT_DIR/scripts/check_security_headers.sh"
if [ -f "$hdr_sh" ]; then
  hdr_out=$(bash "$hdr_sh" 2>&1) || \
    fail "WARN 安全响应头缺失：$(printf '%s' "$hdr_out" | tr '\n' '; ' | cut -c1-180)"
else
  # 判据不在场 ≠ 头齐备（本仓的老账：**缺键绝不读成 0**）。这条 WARN 说的是"这一项
  # 这轮没验"，不是"头没了"——两种情况的话得分开说，否则修错方向。
  fail "WARN 安全响应头这一项没验（找不到 $hdr_sh）"
fi

# 9. 每日零成本观测一行（20261016）
#    20261012 起夜间回归整体挂起（主人「钱包扛不住」），而 nightly_regression.sh 把
#    L1/L2/L3 + trace_alert + golden_draft 装在**同一个脚本**里 ⇒ 一停全停，生产健康
#    只剩本探针每分钟那八项。`eval/token_cost_report.py`（成本/前缀缓存）与
#    `eval/trace_metrics.py`（真实流量效率）是两件**零 LLM 成本**的读数装置，却没有任何
#    自动通道——代价有现场：20261016 planner 的前缀缓存命中率 84.6% → 51.8%（当天改了
#    提示词 = 整段前缀失效 = 多花钱），这件事此前**没有任何东西会报**。
#    形状与第 6 项（哨兵）同款：**按天边沿触发**，一天最多一行，不每分钟刷屏。
#    跑挂了当天也留一行 WARN——**不重试是刻意的**：脚本本身坏掉时每分钟重试会刷屏，
#    而"每天一条 WARN"照样看得见。判 WARN 不判 FAIL：服务活着，断的是观测线。
#    ⚠️ **20261017 补**：本机当天重新开了夜间那班（主人「不是因为坏了，是之前成本暂停了」），
#    但**仓库口径改成了"默认不装"**（开关在 agent 仓 scripts/enable_nightly.sh）。上面写的
#    "挂起"是 20261016 那天的**事实**，留着不改；要读的是这条推论——**在默认部署里夜间不在场
#    ⇒ 这一项（第 9 项）就是那个部署下唯一的自动观测通道**，它坏了就真的没有别的了。
METRICS_DAY="$PROJECT_DIR/logs/.health_metrics_day"
TODAY=$(date +%Y%m%d)
if [ "$(cat "$METRICS_DAY" 2>/dev/null)" != "$TODAY" ]; then
  echo "$TODAY" > "$METRICS_DAY"     # 先落印再跑：跑挂了也不重试（理由见上）
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
    # 「判据不在场」≠「没问题」（同第 8 项那条纪律）。它在 agent 仓的 main 上，
    # 生产树 pull 之后才有——这条 WARN 说的是"这一项这轮没验"，不是"线上坏了"。
    fail "WARN 每日观测脚本不在场（$dm）——它在 agent 仓 main 上，生产树 pull 之后才有"
  fi
fi
exit 0

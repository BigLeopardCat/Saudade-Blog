#!/bin/bash
# 心跳探针（cron 每分钟）——20260829 事故后补的可观测性缺口：
# uvicorn worker 静默崩溃时 systemd/uvicorn 都不留痕（无 traceback、无 OOM 日志），
# 此脚本对比 worker 进程 pid 集合，发现"新 pid 顶替旧 pid"即判定发生过崩溃重启。
# 20260830 增第 4 项：nginx error.log 增量扫描（监控补齐 C）。
# 异常只追加 logs/health.log（轻量、不打扰），未来可接告警通道。
LOG=/home/ubuntu/memory_blog_rust/logs/health.log
STAMP=/tmp/health_state
TS=$(date "+%Y-%m-%d %H:%M:%S")
fail() { echo "$TS $*" >> "$LOG"; }

# 1. Rust 后端存活（3000）：/api/login 是 POST 路由，GET 返回 405 = 服务活着
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:3000/api/login)
[ "$code" = "000" ] && fail "FAIL Rust 3000 无响应"
[ "$code" != "405" ] && [ "$code" != "200" ] && fail "WARN Rust 3000 异常响应 HTTP $code"

# 2. Agent 存活（8010）
ready=$(curl -s --max-time 5 http://127.0.0.1:8010/health | grep -o '"agent_ready":true')
[ -z "$ready" ] && fail "FAIL agent 8010 /health 异常（${ready:-无响应}）"

# 3. uvicorn worker 崩溃检测
# master 按命令行匹配（[u]vicorn 技巧防匹配自身命令行）；
# workers 按 master 子进程找（uvicorn --workers 的 worker 是 multiprocessing
# spawn 子进程，cmdline 是 python3 -c spawn_main，按命令行匹配不到）
master=$(pgrep -f "[u]vicorn server:app" | sort -n | head -1)
procs=$(pgrep -P "$master" | sort -n)
[ -z "$master" ] && { fail "FAIL uvicorn 进程组不存在"; exit 0; }

# 加载上次状态（首次运行初始化基线）
if [ -f "$STAMP" ]; then . "$STAMP"; fi
if [ "${MASTER_PID:-}" != "$master" ]; then
  fail "WARN uvicorn master 更换 ${MASTER_PID:-无} → $master（服务重启/崩溃拉起）"
  LAST_PIDS=""
fi
new=""
for p in $procs; do
  [ "$p" = "$master" ] && continue
  new="$new $p"
  echo " $LAST_PIDS " | grep -qw "$p" || fail "WARN 新 worker pid=$p 出现（worker 崩溃 respawn——12:29 事故同类）"
done
echo "MASTER_PID=$master" > "$STAMP"
echo "LAST_PIDS='$new'" >> "$STAMP"

# 4. nginx error.log 增量扫描（20260830，监控补齐 C）：nginx 日志保持 distro 位置
# （/var/log/nginx，发行版 logrotate 管轮转），探针盯增量——记录上次字节数，
# tail -c 增量段 grep 错误级别（error/crit/alert/emerg），发现即 WARN。
# 文件变小（轮转/截断）时重置基线。
NGX_ERR=/var/log/nginx/error.log
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
exit 0

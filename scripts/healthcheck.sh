#!/bin/bash
# 心跳探针（cron 每分钟）——20260829 事故后补的可观测性缺口：
# uvicorn worker 静默崩溃时 systemd/uvicorn 都不留痕（无 traceback、无 OOM 日志），
# 此脚本对比 worker 进程 pid 集合，发现"新 pid 顶替旧 pid"即判定发生过崩溃重启。
# （worker 集的正确取法与"主动重启 vs 崩溃自愈"的区分见第 3 节的 20260923 修正注释）
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
# spawn 子进程，cmdline 是 python3 -c spawn_main，按命令行匹配不到）。
# ⚠️ 20260923 修正三处（此前每次重启都刷 3 行假"崩溃 respawn"，全量 15 行里真阳性 0）：
#   ① 子进程里有一个 `multiprocessing.resource_tracker`，它**不是 worker** ⇒ 按 cmdline
#      里的 `multiprocessing-fork` 过滤（uvicorn --workers 2 的真 worker 就是那 2 个）。
#   ② master 换了的时候**不再逐个报子进程**：master 换 ⇒ 子进程 pid 必然全新，逐个报
#      等于"必然全中"。原代码把 `LAST_PIDS=""` 当"上次没有 worker"用，方向正好写反了。
#   ③ 主动重启 vs 崩溃自愈用 systemd 的 NRestarts 区分（实测：`systemctl restart` 不增这个
#      计数——13:56 那次主动重启前后都是 0；Restart=always 拉起来才会涨）⇒ 涨了才是崩溃。
#      另加"worker 数 ≠ 期望"的判据：静默死掉一个是 12:29 事故的形状，旧版反而看不出来。
EXPECT_WORKERS=2
master=$(pgrep -f "[u]vicorn server:app" | sort -n | head -1)
[ -z "$master" ] && { fail "FAIL uvicorn 进程组不存在"; exit 0; }
workers=""
for p in $(pgrep -P "$master" | sort -n); do
  tr -d '\0' < "/proc/$p/cmdline" 2>/dev/null | grep -q 'multiprocessing-fork' && workers="$workers $p"
done

# 加载上次状态（首次运行初始化基线）
if [ -f "$STAMP" ]; then . "$STAMP"; fi
nrestarts=$(systemctl show saudade-agent -p NRestarts --value 2>/dev/null | tr -d ' ')
master_changed=0
if [ "${MASTER_PID:-}" != "$master" ]; then
  master_changed=1
  if [ -n "$nrestarts" ] && [ -n "${LAST_NRESTARTS:-}" ] && [ "$nrestarts" -gt "${LAST_NRESTARTS:-0}" ] 2>/dev/null; then
    fail "WARN uvicorn master 更换 ${MASTER_PID:-无} → $master（systemd 崩溃自愈第 $nrestarts 次——12:29 事故同类）"
  else
    # 主动重启（部署后 restart）是预期操作，记 INFO 不记 WARN——WARN 只留给"没人动它却变了"
    echo "$TS INFO uvicorn master 更换 ${MASTER_PID:-无} → $master（主动重启：NRestarts=${nrestarts:-未知} 未增）" >> "$LOG"
  fi
fi
if [ "$master_changed" = "0" ]; then
  for p in $workers; do
    echo " ${LAST_PIDS:-} " | grep -qw "$p" || fail "WARN 新 worker pid=$p 出现（worker 崩溃 respawn——12:29 事故同类）"
  done
fi
wcount=$(echo $workers | wc -w)
[ "$wcount" != "$EXPECT_WORKERS" ] && fail "WARN uvicorn worker 数 $wcount ≠ $EXPECT_WORKERS（pids:$(echo $workers | tr ' ' ',')）"
echo "MASTER_PID=$master" > "$STAMP"
echo "LAST_PIDS='$workers'" >> "$STAMP"
echo "LAST_NRESTARTS=${nrestarts:-}" >> "$STAMP"

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
# 6. 夜间任务失败哨兵（20260924）
#    夜间两班（04:00 的 agent 回归 saudade-blog-agent/scripts/nightly_regression.sh、
#    04:40 的前端渲染层沙箱 scripts/nightly_sandboxes.sh）失败时会在 ~ 下留一个
#    *.failed 哨兵文件，**存在 = 上次运行失败**；全绿则自己删掉。
#    这里把两个哨兵的 mtime 拼成签名，只在**签名变化**时报一条 WARN——边沿触发，不会
#    每分钟刷屏。哨兵每晚失败都被 touch（mtime 前进），所以"一直失败"是每晚一条、
#    "修好了"则签名变空、静默（干净夜里 health.log 一行都不多）。
#    判 WARN 不判 FAIL：服务都还活着，是测试套件红，不是线上挂了。
SENTINELS="$HOME/agent_regression.failed $HOME/sandbox_regression.failed"
sent_sig=""
for s in $SENTINELS; do
  [ -f "$s" ] && sent_sig="$sent_sig $(basename "$s"):$(stat -c %Y "$s" 2>/dev/null || echo 0)"
done
if [ -n "$sent_sig" ] && [ "$sent_sig" != "${LAST_SENTINEL:-}" ]; then
  fail "WARN 夜间任务留下失败哨兵:$sent_sig（看 ~/agent_regression.log、~/sandbox_regression.log）"
fi
echo "LAST_SENTINEL='$sent_sig'" >> "$STAMP"
exit 0

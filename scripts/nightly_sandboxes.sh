#!/usr/bin/env bash
# 前端渲染层沙箱夜间批跑（20260924）
#
# 为什么要有这个脚本：`frontend/tests/` 下的 9 个 Playwright 沙箱（真组件 + 无头 Chrome 的
# 数值断言）此前**没有任何东西跑它们**——CI 明确不收（要 Playwright，见 deploy.yml 的
# check job 注释），也没进任何 shell 脚本。结果是这一类缺陷只能靠人点：
# 20260923 那起「确认卡片弹出来几十毫秒后被消息流孤儿清理删掉」正是它——静态断言
# 看不见（两段代码各自看都对），单源扫描看不见，只有真模块 + 真时序能看见。
#
# 触发：crontab `40 4 * * *`（避开 04:00 的 agent nightly golden 与 04:20 的 apt-daily）。
# 结果追加到 ~/sandbox_regression.log；任一套件失败会在 ~/sandbox_regression.failed
# 留下标记（存在 = 上次运行失败）。**哨兵由 scripts/healthcheck.sh 每分钟顺带检查**，
# 新出现时往 logs/health.log 写一条 WARN——所以「夜间挂了」这件事有人看得见。
#
# 本机就是生产服务器（3.7G 内存、swap 常年在高位）⇒ 三条纪律：
#   ① 串行跑，绝不并发第二个 chromium；
#   ② 每个套件加外部超时（几条沙箱内部的 subprocess.run 没有超时，Playwright 的 30s
#      也盖不住 browser.close() / httpd.shutdown()）；
#   ③ 与夜间 golden 撞车就跳过——golden 正常 04:12-04:16 结束，但它没有全局时长上限
#      （单条 STREAM_TOTAL_TIMEOUT=300s × 109 条），坏情况下能跑到早上。
#
# 跳过（SKIP）不是通过也不是失败：不写哨兵、不清哨兵，只在日志里留痕。
#
# 离线演练：`DRY=1 bash scripts/nightly_sandboxes.sh`（只回显要跑什么，不启 chromium。
# LOG/MARK 可临时指到 /tmp 以便连汇总与哨兵那段一起验）。
set -u

REPO=/home/ubuntu/memory_blog_rust
LOG=${LOG:-"$HOME/sandbox_regression.log"}
MARK=${MARK:-"$HOME/sandbox_regression.failed"}
TS=$(date '+%Y-%m-%d %H:%M:%S')
DRY=${DRY:-0}

# 沙箱要 node（esbuild）与 python3（playwright 在 ~/.local，chromium 在 ~/.cache）——
# cron 的 PATH 很短，显式给全，免得"人在终端跑得过、cron 里找不到命令"。
export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"

cd "$REPO" || { echo "$TS FAIL 进不了 $REPO" >> "$LOG"; exit 1; }

say() { echo "$*" >> "$LOG"; }
if [ "$DRY" = "1" ]; then say() { echo "$*" | tee -a "$LOG"; }; fi

say "=== nightly sandboxes $TS ==="

# ── 守卫：与夜间 golden / 已存在的无头浏览器撞车就跳过 ────────────────────────────
# pgrep 的模式用 `[r]un` 写法（同 healthcheck 的 `[u]vicorn` 技巧）：模式文本本身
# 不会命中自己，避免"调用者的命令行里恰好有这个名字"就误跳。
if pgrep -f '[r]un_golden\.py|[g]olden_full_run\.py' >/dev/null; then
  say "[$TS] SKIP 夜间 golden 仍在跑（本机 3.7G，不叠第二个重活；哨兵不动）"
  exit 0
fi
if pgrep -f 'ms-playwright/chromium-[0-9]' >/dev/null; then
  say "[$TS] SKIP 已有无头浏览器在跑（不并发第二个 chromium；哨兵不动）"
  exit 0
fi

# ── 预检：python3 / playwright 不可用就别让 9 条各报一次错 ──────────────────────
if ! python3 -c 'import playwright' >/dev/null 2>&1; then
  say "[$TS] FAIL python3 里没有 playwright（9 个沙箱全跑不了）——检查 ~/.local 安装"
  touch "$MARK"
  exit 1
fi

# 套件 = frontend/tests/ 下所有 *.py（8 个 *.test.py + wordgraph_render.py，后者同样是
# 带数值断言与性能闸的套件）。按目录 glob 而不是写死名单：加了新沙箱不用改这里。
SUITES=(frontend/tests/*.py)
if [ ! -e "${SUITES[0]}" ]; then
  say "[$TS] FAIL frontend/tests/ 下没有 *.py 沙箱（glob 没命中，脚本要修）"
  touch "$MARK"
  exit 1
fi

fail=0
n=0
nfail=0
for t in "${SUITES[@]}"; do
  n=$((n + 1))
  name=$(basename "$t")
  say "--- $name ---"
  if [ "$DRY" = "1" ]; then
    say "[DRY] timeout -k 30 480 python3 $t"
    continue
  fi
  if timeout -k 30 480 python3 "$t" >>"$LOG" 2>&1; then
    say "[$TS] $name OK"
  else
    rc=$?
    fail=1
    nfail=$((nfail + 1))
    say "[$TS] $name FAILED（退出码 $rc，超时上限 480s）"
  fi
done

say "════ $((n - nfail))/$n 个沙箱通过 ════"
if [ "$DRY" = "1" ]; then
  say "[DRY] 不改哨兵 $MARK"
  exit 0
fi
if [ "$fail" -eq 0 ]; then
  say "[$TS] ALL PASS"
  rm -f "$MARK"
else
  say "[$TS] FAILED — 见上方输出（哨兵 $MARK 已置位，healthcheck 会报一次）"
  touch "$MARK"
fi

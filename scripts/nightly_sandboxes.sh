#!/usr/bin/env bash
# 前端渲染层沙箱夜间批跑（20260924）
#
# 为什么要有这个脚本：`frontend/tests/` 下的那批 Playwright 沙箱（真组件 + 无头 Chrome 的
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
#      （单条 STREAM_TOTAL_TIMEOUT=300s × golden 全量），坏情况下能跑到早上。
#
# 跳过（SKIP）不是通过也不是失败：不写哨兵、不清哨兵，只在日志里留痕。
#
# 离线演练：`DRY=1 bash scripts/nightly_sandboxes.sh`（只回显要跑什么，不启 chromium。
# LOG/MARK 可临时指到 /tmp 以便连汇总与哨兵那段一起验）。
set -u

# PROJECT_DIR 可覆盖（20261001 开源前准备）：默认仍是原开发机的绝对路径（线上 cron 零变化）；
# 别人克隆到别处时 `PROJECT_DIR=... bash scripts/nightly_sandboxes.sh`。
# LOG/MARK 默认落在 $HOME 而不是仓库里，所以那个不用跟着改。
REPO="${PROJECT_DIR:-/home/ubuntu/Saudade-Blog}"
LOG=${LOG:-"$HOME/sandbox_regression.log"}
MARK=${MARK:-"$HOME/sandbox_regression.failed"}
TS=$(date '+%Y-%m-%d %H:%M:%S')
DRY=${DRY:-0}

# ── 临时目录隔离（20261006）────────────────────────────────────────────────────
# 此前沙箱里的 `tempfile.mkdtemp(prefix=…)` 全撒在 /tmp 根上，而**绝大多数套件跑完不删**
# （37 个 .py 里只有 10 个在 happy path 末尾删一次，异常/超时路径不执行）。实测攒到
# 2265 个目录 / 4.76G——占整个 /tmp 的 85%（单 `comment-layout-` 一族就 141 个 / 2.5G）。
#
# 现在每个套件拿到一个**专属 TMPDIR**：它的 mkdtemp 全部落在这一格里。
#   通过 ⇒ 删掉这一格；失败 ⇒ **留下**（那是排障材料：截图、构建产物）并把路径写进日志。
# 选择"由运行器统一隔离"而不是"改 61 个套件的源码各自清理"，就因为运行器知道**过没过**，
# 套件自己分不出这两种结局。新增套件也自动被覆盖，不必注册。
SANDBOX_TMP=${SANDBOX_TMP:-/tmp/saudade-sandboxes}
RUN="$SANDBOX_TMP/$(date +%Y%m%dT%H%M%S)"

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

# ── 预检：python3 / playwright 不可用就别让每一条各报一次错 ─────────────────────
if ! python3 -c 'import playwright' >/dev/null 2>&1; then
  say "[$TS] FAIL python3 里没有 playwright（全部沙箱都跑不了）——检查 ~/.local 安装"
  touch "$MARK"
  exit 1
fi

# 套件 = frontend/tests/ 下所有 *.py（`*.test.py` 那批 + wordgraph_render.py，后者同样是
# 带数值断言与性能闸的套件）。按目录 glob 而不是写死名单：加了新沙箱不用改这里。
#
# **这里的条数刻意不写**（20260929）：原注释写着「9 个沙箱」「8 个 *.test.py」，而实测
# 已有 16 个 `*.test.py`（+ wordgraph_render.py = 17 条）——哨兵自己在报一个过期的分母，
# 与 R2 `--keep 3`、logrotate `rotate 14`、golden `--min-pass-rate` 那几处同族：
# **一个必须靠人手同步的数字，迟早不同步**。脚本里下面那个 glob 才是唯一事实源，
# 汇总行的条数是跑出来的（`n`），不是写出来的。父仓 CLAUDE.md 目录树里那条也已改成同口径。
SUITES=(frontend/tests/*.py)
if [ ! -e "${SUITES[0]}" ]; then
  say "[$TS] FAIL frontend/tests/ 下没有 *.py 沙箱（glob 没命中，脚本要修）"
  touch "$MARK"
  exit 1
fi

fail=0
n=0
nfail=0
say "[$TS] 本轮临时目录：$RUN"
for t in "${SUITES[@]}"; do
  n=$((n + 1))
  name=$(basename "$t")
  suite_tmp="$RUN/${name%.py}"
  say "--- $name ---"
  if [ "$DRY" = "1" ]; then
    say "[DRY] mkdir -p $suite_tmp && TMPDIR=$suite_tmp timeout -k 30 480 python3 $t"
    continue
  fi
  # **必须真建出来**：TMPDIR 指向一个不存在的目录时，tempfile.gettempdir() 会**静默回落到
  # /tmp**——隔离看着生效、实际一行没生效，正是本仓最怕的那类半死。
  if ! mkdir -p "$suite_tmp"; then
    fail=1
    nfail=$((nfail + 1))
    say "[$TS] $name FAILED（建不出临时目录 $suite_tmp）"
    continue
  fi
  if TMPDIR="$suite_tmp" timeout -k 30 480 python3 "$t" >>"$LOG" 2>&1; then
    rm -rf "$suite_tmp"
    say "[$TS] $name OK"
  else
    rc=$?
    fail=1
    nfail=$((nfail + 1))
    say "[$TS] $name FAILED（退出码 $rc，超时上限 480s）；现场留在 $suite_tmp"
  fi
done
# 轮次目录只收**空的**：失败现场那一格还装着东西，rmdir 会自然失败、不动它。
rmdir "$RUN" 2>/dev/null || true

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

# ── 清扫（20261006）：扫走隔离盖不住的那些 ──────────────────────────────────────
# TMPDIR 隔离能盖住"由运行器拉起来的套件"，盖不住**手跑单个套件**
# （`python3 frontend/tests/xxx.test.py` 没人给它 TMPDIR）与中途被 kill 的轮次——
# 那些仍旧落在 /tmp 根上。清扫脚本按**从套件源码推出的前缀**认领它们（不写手写名单），
# 另收 24h 以上的陈旧轮次目录；判据是白名单 + 年龄闸 + 路径必须在根之下。
# 默认只列不删，这里显式 --apply。清扫失败**不影响**沙箱结果——账单卫生不该把一次
# 真实的套件失败搅浑（同 agent 仓 nightly 调 trace_retention.py 的做法）。
say "[$TS] 清扫临时目录："
python3 scripts/prune_sandbox_tmp.py --apply >>"$LOG" 2>&1 \
  || say "[$TS] 清扫运行异常（不影响沙箱结果）"

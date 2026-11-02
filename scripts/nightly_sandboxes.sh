#!/usr/bin/env bash
# Serial frontend screenshot sandboxes. Requires uv, Node and Playwright Chromium.
# Python packages come from frontend/tests/requirements.txt in an isolated uv env.
# Schedule explicitly after a successful manual run; this script does not install cron.
# Passing suites remove only their own temporary directory; failures retain evidence.
# DRY=1 prints planned work without resolving packages or starting browsers.
set -u

REPO="${PROJECT_DIR:-/home/ubuntu/Saudade-Blog}"
LOG=${LOG:-"$HOME/sandbox_regression.log"}
MARK=${MARK:-"$HOME/sandbox_regression.failed"}
TS=$(date '+%Y-%m-%d %H:%M:%S')
DRY=${DRY:-0}
UV_BIN=${UV_BIN:-uv}
SANDBOX_PYTHON=("$UV_BIN" run --no-project --isolated --python 3.12
  --with-requirements "$REPO/frontend/tests/requirements.txt" python -I)

SANDBOX_TMP=${SANDBOX_TMP:-/tmp/saudade-sandboxes}
RUN="$SANDBOX_TMP/$(date +%Y%m%dT%H%M%S)"

export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"

cd "$REPO" || { echo "$TS FAIL 进不了 $REPO" >> "$LOG"; exit 1; }

say() { echo "$*" >> "$LOG"; }
if [ "$DRY" = "1" ]; then say() { echo "$*" | tee -a "$LOG"; }; fi

say "=== nightly sandboxes $TS ==="

if pgrep -f '[r]un_golden\.py|[g]olden_full_run\.py' >/dev/null; then
  say "[$TS] SKIP 夜间 golden 仍在跑（本机 3.7G，不叠第二个重活；哨兵不动）"
  exit 0
fi
if pgrep -f 'ms-playwright/chromium-[0-9]' >/dev/null; then
  say "[$TS] SKIP 已有无头浏览器在跑（不并发第二个 chromium；哨兵不动）"
  exit 0
fi

# Isolated Python must resolve the pinned packages before starting any browser.
if [ "$DRY" != "1" ] && ! "${SANDBOX_PYTHON[@]}" -c '
import importlib.metadata, sys
import PIL, playwright
assert sys.prefix != sys.base_prefix, "sandbox Python must be isolated"
print("sandbox Python:", sys.executable)
print("Pillow:", importlib.metadata.version("Pillow"),
      "Playwright:", importlib.metadata.version("playwright"))
' >>"$LOG" 2>&1; then
  say "[$TS] FAIL 无法准备隔离的截图测试依赖（检查 uv 与 requirements）"
  touch "$MARK"
  exit 1
fi

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
# Run browsers serially and retain failed suite directories for diagnosis.
for t in "${SUITES[@]}"; do
  n=$((n + 1))
  name=$(basename "$t")
  suite_tmp="$RUN/${name%.py}"
  say "--- $name ---"
  if [ "$DRY" = "1" ]; then
    say "[DRY] mkdir -p $suite_tmp && TMPDIR=$suite_tmp timeout -k 30 480 ${SANDBOX_PYTHON[*]} $t"
    continue
  fi
  if ! mkdir -p "$suite_tmp"; then
    fail=1
    nfail=$((nfail + 1))
    say "[$TS] $name FAILED（建不出临时目录 $suite_tmp）"
    continue
  fi
  if TMPDIR="$suite_tmp" timeout -k 30 480 "${SANDBOX_PYTHON[@]}" "$t" >>"$LOG" 2>&1; then
    rm -rf "$suite_tmp"
    say "[$TS] $name OK"
  else
    rc=$?
    fail=1
    nfail=$((nfail + 1))
    say "[$TS] $name FAILED（退出码 $rc，超时上限 480s）；现场留在 $suite_tmp"
  fi
done
# Never remove a nonempty run directory.
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

# Cleanup failures do not alter the suite result.
say "[$TS] 清扫临时目录："
"${SANDBOX_PYTHON[@]}" scripts/prune_sandbox_tmp.py --apply >>"$LOG" 2>&1 \
  || say "[$TS] 清扫运行异常（不影响沙箱结果）"

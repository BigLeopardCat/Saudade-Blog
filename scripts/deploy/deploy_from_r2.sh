#!/bin/bash
# 部署脚本（服务器侧）：从 R2 拉取**指定提交**的部署包并落地。
#
# 20260923 改造（此前的问题：部署哪一版由"谁最后上传"决定，两个 run 并行时产物互相覆盖，
# 后端那一半可能根本没落地，而 CI 一直是绿的）：
#   · 产物按提交号归档 deploy/<sha>/deploy.tar.gz，sha 由 CI 显式传进来（DEPLOY_SHA）；
#     没传就按 R2 上的 deploy/latest.txt 解析（手动部署路径，见 CLAUDE.md §6）。
#   · flock 串行化：两个部署同时解压同一份 frontend/dist 时，nginx 可能服务到半写文件。
#   · 后端**按源码是否变化**决定要不要重启（`git diff src/ Cargo.*` 比较上一版与本次的提交），
#     没变就不动服务——"每个 run 都重启一次"会白掐在途对话。
#   · 落地后做存活探测，并写 frontend/dist/build-info.json（线上 curl 即知跑的是哪个提交）。
#
# ⚠️ 改这个文件之前先确认没有部署在跑（pgrep -af deploy_from_r2）：
#    bash 是按字节偏移增量读脚本的，执行中被覆盖会读到半截。
set -e
cd /home/ubuntu/memory_blog_rust

mkdir -p logs
exec 9>logs/.deploy.lock
flock -w 300 9 || { echo "❌ $(date '+%H:%M:%S') 等了 300 秒仍拿不到部署锁（有另一个部署在跑）"; exit 1; }

export $(grep -v '^\s*#' .env | grep -v '^\s*$' | xargs) 2>/dev/null || true

# 上一版是哪个提交（后端要不要重启的判据），必须赶在下面 python 覆盖它之前读
PREV_SHA="$(cat logs/.last_deploy_sha 2>/dev/null || true)"

echo "=== $(date '+%Y-%m-%d %H:%M:%S') 从 R2 拉取更新（DEPLOY_SHA=${DEPLOY_SHA:-未指定}）==="

# ── 解析 key + 下载 + 解压（key 由提交号决定）────────────────────────────
DEPLOY_SHA="${DEPLOY_SHA:-}" python3 <<'PYEOF2'
import os, re, sys
import boto3, tarfile
from botocore.config import Config

s3 = boto3.client('s3',
    endpoint_url=os.environ['R2_ENDPOINT'],
    aws_access_key_id=os.environ['R2_ACCESS_KEY'],
    aws_secret_access_key=os.environ['R2_SECRET_KEY'],
    config=Config(signature_version='s3v4'),
    region_name='auto')
bucket = os.environ['R2_BUCKET']

sha = os.environ.get('DEPLOY_SHA', '').strip()
if not sha:
    try:
        sha = s3.get_object(Bucket=bucket, Key='deploy/latest.txt')['Body'].read().decode().strip()
    except Exception as exc:
        sys.exit(f'❌ 既没给 DEPLOY_SHA，也读不到 deploy/latest.txt：{exc}')
    print(f'ℹ️ 未指定 DEPLOY_SHA，按 deploy/latest.txt 解析到 {sha[:12]}')
if not re.fullmatch(r'[0-9a-f]{40}', sha):
    sys.exit(f'❌ 提交号必须是完整的 40 位小写十六进制（git rev-parse HEAD）：{sha!r}')

key = f'deploy/{sha}/deploy.tar.gz'
try:
    s3.download_file(bucket, key, '/tmp/deploy.tar.gz')
except Exception as exc:
    sys.exit(f'❌ 取不到部署包 {key}：{exc}（该提交没有产物？或上传还没完成）')
with tarfile.open('/tmp/deploy.tar.gz') as tar:
    # A10 修复：filter='data' 拒绝 ../ 等路径穿越条目（Python 3.12 默认值，显式声明防回归）
    tar.extractall(filter='data')
os.remove('/tmp/deploy.tar.gz')
with open('logs/.last_deploy_sha', 'w', encoding='utf-8') as fh:
    fh.write(sha)
print(f'✅ 部署文件下载解压完成（{key}）')
PYEOF2

SHA="$(cat logs/.last_deploy_sha)"

# ── 前端：至少得有一个 index.html 才算落地 ───────────────────────────────
[ -f frontend/dist/index.html ] || { echo "❌ 部署包里没有 frontend/dist/index.html"; exit 1; }
echo "✅ $(date '+%H:%M:%S') 前端已更新"

# ── 后端：ELF 校验 → 按源码变化决定要不要重启 ────────────────────────────
RESTART=0
if [ -f saudade_blog_bin ]; then
  # A10 修复补充：后端二进制必须是 ELF 可执行文件，拒绝被替换为任意脚本/文件
  if ! file saudade_blog_bin | grep -q "ELF"; then
    echo "❌ $(date '+%H:%M:%S') saudade_blog_bin 不是 ELF 可执行文件，部署中止"
    rm -f saudade_blog_bin
    exit 1
  fi
  cp -f saudade_blog_bin target/release/saudade_blog_bin
  chmod +x target/release/saudade_blog_bin
  rm -f saudade_blog_bin
  # 源码没变就不重启（判据取 git 历史里两版之间的 src/ 与 Cargo.*；取不到就老实重启）
  if [ -n "$PREV_SHA" ] && [ "$PREV_SHA" != "$SHA" ] \
     && git cat-file -e "${PREV_SHA}^{commit}" 2>/dev/null \
     && git diff --quiet "$PREV_SHA" "$SHA" -- src Cargo.toml Cargo.lock; then
    echo "ℹ️ 与上一版（${PREV_SHA:0:12}）相比后端源码没变，跳过重启"
  else
    RESTART=1
  fi
else
  echo "⚠️ 部署包里没有后端二进制（这一步只构建了前端？）"
fi

# ── 存活探测：该重启就重启；不响应就补一次；仍不响应即失败 ────────────────
alive() {
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3000/api/login || true)
  [ -n "$code" ] && [ "$code" != "000" ]
}
if [ "$RESTART" = "1" ] || ! alive; then
  [ "$RESTART" = "0" ] && echo "⚠️ 后端不响应（活着的进程掉了？），重启一次"
  sudo systemctl restart saudade-rust
  for _ in $(seq 1 20); do alive && break; sleep 1; done
  if alive; then
    echo "✅ $(date '+%H:%M:%S') 后端已更新并重启（存活探测 HTTP $code）"
  else
    echo "❌ $(date '+%H:%M:%S') 后端重启后 20 秒仍不响应，部署失败"
    exit 1
  fi
else
  echo "✅ $(date '+%H:%M:%S') 后端无需变动（存活探测 HTTP $code）"
fi

# ── 构建信息：线上 curl 这个文件即知部署的是哪个提交 ──────────────────────
printf '{"sha":"%s","deployed_at":"%s"}\n' "$SHA" "$(date '+%Y-%m-%d %H:%M:%S%z')" \
  > frontend/dist/build-info.json
echo "✅ $(date '+%H:%M:%S') 部署完成（sha=${SHA:0:12}）"

# ── R2 产物清理（20260924，用户报"R2 会被写爆产生账单"）────────────────────
# 放到**落地成功之后**：这一步跑到了就说明这次的包已经不需要留在云上了，R2 回到
# 「latest.txt + 最近 3 个提交包」这个不变量（保留 3 = 留一条约 3 次部署的手动回滚
# 窗口；被删的包只能重跑 CI 用那个提交号重建）。--keep-sha 是双保险：本次部署的包
# 无论如何不删（正常情况下它本来就是最新的那个）。
# **清理失败不影响部署结果**——账单卫生不该把一次成功的部署标红，只记一行警告。
if [ -f scripts/deploy/prune_r2.py ]; then
  if python3 scripts/deploy/prune_r2.py --keep 3 --keep-sha "$SHA" --apply; then
    echo "✅ $(date '+%H:%M:%S') R2 产物已清理（保留 latest.txt + 最近 3 个包）"
  else
    echo "⚠️ $(date '+%H:%M:%S') R2 产物清理失败（不影响本次部署，可手动跑 scripts/deploy/prune_r2.py）"
  fi
else
  echo "⚠️ 找不到 scripts/deploy/prune_r2.py，跳过 R2 产物清理"
fi

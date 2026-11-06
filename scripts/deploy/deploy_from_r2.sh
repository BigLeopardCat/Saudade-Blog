#!/bin/bash
# Deploy an immutable R2 artifact under a deployment lock; verify readiness before pruning known old assets.
# Do not edit this script while a deployment is running.

set -euo pipefail

cd "${PROJECT_DIR:-/home/ubuntu/Saudade-Blog}"

DEPLOY_PYTHON="${SAUDADE_DEPLOY_PYTHON:-${XDG_DATA_HOME:-$HOME/.local/share}/saudade/deploy-venv/bin/python}"
[ -x "$DEPLOY_PYTHON" ] || { echo "部署工具环境不存在，请先安装 scripts/deploy/requirements.txt" >&2; exit 1; }
"$DEPLOY_PYTHON" scripts/check_disk_capacity.py .

mkdir -p logs
exec 9>logs/.deploy.lock
flock -w 300 9 || { echo "❌ $(date '+%H:%M:%S') 等了 300 秒仍拿不到部署锁（有另一个部署在跑）"; exit 1; }


PREV_SHA="$(cat logs/.last_deploy_sha 2>/dev/null || true)"

echo "=== $(date '+%Y-%m-%d %H:%M:%S') 从 R2 拉取更新（DEPLOY_SHA=${DEPLOY_SHA:-未指定}）==="

DEPLOY_SHA="${DEPLOY_SHA:-}" "$DEPLOY_PYTHON" <<'PYEOF2'
import os, re, sys
import boto3, tarfile
sys.path.insert(0, "scripts/deploy")
from deployment_config import read_deployment_config
sys.path.insert(0, "scripts")
from check_disk_capacity import require_capacity
from botocore.config import Config

credentials = read_deployment_config()
s3 = boto3.client('s3',
    endpoint_url=credentials['R2_ENDPOINT'],
    aws_access_key_id=credentials['R2_ACCESS_KEY'],
    aws_secret_access_key=credentials['R2_SECRET_KEY'],
    config=Config(signature_version='s3v4'),
    region_name='auto')
bucket = credentials['R2_BUCKET']

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
    size = s3.head_object(Bucket=bucket, Key=key)["ContentLength"]
    require_capacity("/tmp", extra_bytes=size)
    s3.download_file(bucket, key, '/tmp/deploy.tar.gz')
except Exception as exc:
    sys.exit(f'❌ 取不到部署包 {key}：{exc}（该提交没有产物？或上传还没完成）')
with tarfile.open('/tmp/deploy.tar.gz') as tar:

    members = [m.name for m in tar.getmembers()
               if m.name.startswith('frontend/dist/') and not m.isdir()]
    require_capacity('.', extra_bytes=sum(m.size for m in tar.getmembers() if m.isfile()))
    tar.extractall(filter='data')
os.remove('/tmp/deploy.tar.gz')
with open('logs/.deploy_manifest.txt', 'w', encoding='utf-8') as fh:
    fh.write('\n'.join(members) + '\n')
with open('logs/.last_deploy_sha', 'w', encoding='utf-8') as fh:
    fh.write(sha)
print(f'✅ 部署文件下载解压完成（{key}；前端 dist 本代 {len(members)} 个）')
PYEOF2

SHA="$(cat logs/.last_deploy_sha)"

[ -f frontend/dist/index.html ] || { echo "❌ 部署包里没有 frontend/dist/index.html"; exit 1; }
echo "✅ $(date '+%H:%M:%S') 前端已更新"

# 内容哈希 JS/CSS 保留 24 小时，供部署前已打开的页面加载懒模块。
# 清单缺失、过小或缺少 index.html 时中止清理。
"$DEPLOY_PYTHON" - <<'PYEOF3' || echo "⚠️ $(date '+%H:%M:%S') 前端死块清理失败（不影响本次部署，下次部署再清）"
import os, re, time
ROOT = 'frontend/dist'
GRACE_SECONDS = 24 * 3600
HASHED_CHUNK = re.compile(r'-[A-Za-z0-9_-]{8,}\.(?:js|css)$')
cutoff = time.time() - GRACE_SECONDS
# build-info is written after extraction, so it is not part of the artifact manifest.
KEEP = {os.path.join(ROOT, 'build-info.json')}
try:
    with open('logs/.deploy_manifest.txt', encoding='utf-8') as fh:
        current = {ln.strip() for ln in fh if ln.strip()}
except OSError as exc:
    raise SystemExit(f'⚠️ 读不到本代清单 logs/.deploy_manifest.txt（{exc}）⇒ 不清（宁可留旧块也不冒险）')
if len(current) < 50:
    raise SystemExit(f'⚠️ 本代清单只有 {len(current)} 条，太小 ⇒ 不清（判据可疑时宁可留旧块）')
if os.path.join(ROOT, 'index.html') not in current:
    raise SystemExit('⚠️ 本代清单里没有 frontend/dist/index.html ⇒ 它不像"整棵 dist"的清单，不清')
if not os.path.isdir(ROOT) or os.path.islink(ROOT):
    raise SystemExit(f'⚠️ {ROOT} 不是普通目录（软链或不存在）⇒ 不清')
dead, retained = [], 0
for root, _subdirs, files in os.walk(ROOT):
    for name in files:
        p = os.path.join(root, name)
        if p in current or p in KEEP:
            continue
        if os.path.isfile(p) and not os.path.islink(p):
            if HASHED_CHUNK.search(name) and os.stat(p).st_mtime >= cutoff:
                retained += 1
                continue
            dead.append(p)
freed = 0
for p in dead:
    try:
        freed += os.stat(p).st_size
        os.unlink(p)
    except OSError:
        pass
empty = 0
for root, _subdirs, _files in os.walk(ROOT, topdown=False):
    if root == ROOT:
        continue
    try:
        os.rmdir(root)
        empty += 1
    except OSError:
        pass
print(f'🧹 前端死块：清掉上一代 {len(dead)} 个 / {freed / 1048576:.1f}MB'
      f'（本代 {len(current)} 个保留；宽限期旧块 {retained} 个；删除 {empty} 个空目录）')
if dead:
    print('   ' + '、'.join(os.path.basename(p) for p in dead[:5]) + ('…' if len(dead) > 5 else ''))
PYEOF3

RESTART=0
if [ -f saudade_blog_bin ]; then
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

printf '{"sha":"%s","deployed_at":"%s"}\n' "$SHA" "$(date '+%Y-%m-%d %H:%M:%S%z')" \
  > frontend/dist/build-info.json
echo "✅ $(date '+%H:%M:%S') 部署完成（sha=${SHA:0:12}）"


if [ -f scripts/deploy/prune_r2.py ]; then
  if "$DEPLOY_PYTHON" scripts/deploy/prune_r2.py --keep 3 --keep-sha "$SHA" --apply; then
    echo "✅ $(date '+%H:%M:%S') R2 产物已清理（保留 latest.txt + 最近 3 个包）"
  else
    echo "⚠️ $(date '+%H:%M:%S') R2 产物清理失败（不影响本次部署，可手动跑 scripts/deploy/prune_r2.py）"
  fi
else
  echo "⚠️ 找不到 scripts/deploy/prune_r2.py，跳过 R2 产物清理"
fi


if [ -f scripts/check_security_headers.sh ]; then
  if out=$(bash scripts/check_security_headers.sh 2>&1); then
    echo "✅ $(date '+%H:%M:%S') 安全响应头齐备"
  else
    echo "⚠️ $(date '+%H:%M:%S') 安全响应头缺失（不影响本次部署）：$(printf '%s' "$out" | tr '\n' '; ' | cut -c1-200)"
  fi
else
  echo "⚠️ 找不到 scripts/check_security_headers.sh，跳过安全响应头复核"
fi

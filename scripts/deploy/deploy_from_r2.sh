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
#   · 落地后清掉上一代的前端死哈希块（20260925 补，见下方"清上一代死块"一节）：
#     解包是直接覆盖、从不清理 ⇒ 实测一天涨约 100MB、累积到 1.15G（手工清出 737MB）。
#     判据 = 解压时记下的本代清单（logs/.deploy_manifest.txt）做集合差，精确、不猜。
#
# ⚠️ 改这个文件之前先确认没有部署在跑（pgrep -af deploy_from_r2）：
#    bash 是按字节偏移增量读脚本的，执行中被覆盖会读到半截。
set -e
# PROJECT_DIR 可覆盖（20261001 开源前准备）：默认仍是原开发机的绝对路径 ⇒ 线上（CI 调用
# trigger_deploy.sh，两者都不带这个变量）行为零变化。**注意它是路径、不是仓库根配置**：
# 下面的 `git diff` 判据、logs/ 与 frontend/dist/ 都相对于这个目录。
cd "${PROJECT_DIR:-/home/ubuntu/Saudade-Blog}"

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
    # 顺手记下包里的前端文件清单——它就是"本代"的权威定义（CI 每次全新构建，包里
    # 的 frontend/dist 全部来自这一次构建），下一步清死块直接拿它做集合差，不猜
    #
    # 20261002：清单从"三个目录"扩到 **frontend/dist/ 整棵**。此前只记
    # js/、vendor/（20260925）与 live2d-widgets/（20261001），于是**别的目录从来没被扫过**：
    # 实测线上积了 104 个 / 24.3MB 本代之外的残留，其中 92 个是 `css/index-<hash>.css`
    # （约 250–300KB × 每次部署），另有 mp4/、graph/、woff2/、icons/ 与 **dist 顶层**。
    # 顶层那两个的教训最硬：`8854cd4`（2026-09-30）为开源把 `public/QQ.png` /
    # `QQ-Email.png`（含真名与真号的个人二维码）从源码里删了，源码删了、**线上仍在公网 200**，
    # 因为顶层不在任何 DIRS 里。清单只记被扫的目录 = 那些文件永远不在"本代"里 = 永远清不掉。
    # 同一条坑 20261001 已经以"live2d-widgets 改名后旧名字永不消失"的形态出现过一次。
    # 用 getmembers() 按**类型**排目录，不用 `endswith('/')`：包里那 18 个目录项的名字
    # 并不带尾斜杠（`frontend/dist/css`），所以那个写法是死代码——20261002 把前缀放宽到
    # `frontend/dist/` 之后，它们就混进"文件清单"里了（251 条里 18 条是目录）。集合差本身
    # 不受影响（目录名永远不等于某个文件路径），但清单是排障时给人读的，多 18 行幽灵条目
    # 只会让人以为自己数错了。
    members = [m.name for m in tar.getmembers()
               if m.name.startswith('frontend/dist/') and not m.isdir()]
    tar.extractall(filter='data')
os.remove('/tmp/deploy.tar.gz')
with open('logs/.deploy_manifest.txt', 'w', encoding='utf-8') as fh:
    fh.write('\n'.join(members) + '\n')
with open('logs/.last_deploy_sha', 'w', encoding='utf-8') as fh:
    fh.write(sha)
print(f'✅ 部署文件下载解压完成（{key}；前端 dist 本代 {len(members)} 个）')
PYEOF2

SHA="$(cat logs/.last_deploy_sha)"

# ── 前端：至少得有一个 index.html 才算落地 ───────────────────────────────
[ -f frontend/dist/index.html ] || { echo "❌ 部署包里没有 frontend/dist/index.html"; exit 1; }
echo "✅ $(date '+%H:%M:%S') 前端已更新"

# ── 清理不再使用的前端资源 ───────────────────────────────────────────
# 内容哈希 JS/CSS 保留 24 小时，供部署前已打开的页面加载懒模块。
# 本代清单、build-info 与符号链接受保护；其他过期文件按清单清理。
# 清单缺失、过小或缺少 index.html 时中止清理。
python3 - <<'PYEOF3' || echo "⚠️ $(date '+%H:%M:%S') 前端死块清理失败（不影响本次部署，下次部署再清）"
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
        pass   # 非空（还有本代文件）或权限问题 ⇒ 留着
print(f'🧹 前端死块：清掉上一代 {len(dead)} 个 / {freed / 1048576:.1f}MB'
      f'（本代 {len(current)} 个保留；宽限期旧块 {retained} 个；删除 {empty} 个空目录）')
if dead:
    print('   ' + '、'.join(os.path.basename(p) for p in dead[:5]) + ('…' if len(dead) > 5 else ''))
PYEOF3

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

# ── 安全响应头复核（20261015）：非致命，待遇同上面的 R2 清理 ──────────────
# 这五条头只活在 /etc/nginx（不在部署包里、不受任何测试覆盖），而"部署"正是
# nginx 配置最可能被动过的时刻（同一批人、同一台机器、同一段时间）。**不改部署结果**：
# 配置漂移不该把一次成功的部署标红——真正喊人靠探针（healthcheck 第 8 项，写 health.log）。
# 判据只有一份，就是下面这个脚本（探针跑的是同一个）。
if [ -f scripts/check_security_headers.sh ]; then
  if out=$(bash scripts/check_security_headers.sh 2>&1); then
    echo "✅ $(date '+%H:%M:%S') 安全响应头齐备"
  else
    echo "⚠️ $(date '+%H:%M:%S') 安全响应头缺失（不影响本次部署）：$(printf '%s' "$out" | tr '\n' '; ' | cut -c1-200)"
  fi
else
  echo "⚠️ 找不到 scripts/check_security_headers.sh，跳过安全响应头复核"
fi

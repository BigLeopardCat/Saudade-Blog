import boto3, io, os, re, subprocess, sys, tarfile
from botocore.config import Config

# 部署产物按**提交号**归档（20260923）。
#
# 此前所有部署都写同一个键 deploy/deploy.tar.gz，于是"部署哪一版"由**谁最后上传**决定。
# 实测事故：两个 run 同时跑，较旧那个的包（含后端二进制）先上传，较新那个的包（只改前端
# ⇒ 只构建前端 ⇒ 包里没有二进制）后上传把它覆盖；较旧那个随后触发部署，拉到的却是较新
# 那个的包 ⇒ 它自己的后端那一半**从未落地**（线上 /api/protected/messages/drafts 恒 404），
# 而两次 CI 都是绿的。
#
# 现在 key = deploy/<sha>/deploy.tar.gz，部署时由 CI **显式**把 sha 传给服务器
# （见 .github/workflows/deploy.yml 与 scripts/deploy/trigger_deploy.sh）——
# "部署哪一版"是参数，不再是时序运气。


def resolve_sha() -> str:
    sha = (os.environ.get('DEPLOY_SHA') or os.environ.get('GITHUB_SHA') or '').strip()
    if not sha:
        try:
            sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
        except Exception as exc:
            sys.exit(f'❌ 拿不到提交号（DEPLOY_SHA / GITHUB_SHA 都没给，git 也读不到）：{exc}')
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        sys.exit(f'❌ 提交号必须是完整的 40 位小写十六进制：{sha!r}')
    return sha


s3 = boto3.client('s3',
    endpoint_url=os.environ['R2_ENDPOINT'],
    aws_access_key_id=os.environ['R2_ACCESS_KEY'],
    aws_secret_access_key=os.environ['R2_SECRET_KEY'],
    config=Config(signature_version='s3v4'),
    region_name='auto')

sha = resolve_sha()
bucket = os.environ['R2_BUCKET']
key = f'deploy/{sha}/deploy.tar.gz'

buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode='w:gz') as tar:
    backend_bin = 'target/release/saudade_blog_bin'
    frontend_dist = 'frontend/dist'

    if os.path.exists(backend_bin):
        tar.add(backend_bin, arcname='saudade_blog_bin')
        print(f'✅ 添加后端二进制: {backend_bin}')
    else:
        print('⚠️ 后端二进制不存在，跳过')

    if os.path.exists(frontend_dist):
        tar.add(frontend_dist, arcname='frontend/dist')
        print(f'✅ 添加前端构建产物: {frontend_dist}')
    else:
        print('⚠️ 前端构建产物不存在，跳过')

if not buf.getbuffer().nbytes:
    print('❌ 没有文件可打包')
    sys.exit(1)

buf.seek(0)
s3.upload_fileobj(buf, bucket, key)
print(f'✅ 已上传 {key}')

# 指最新一次的产物，**只给手动部署路径用**（CLAUDE.md §6：上传完直接跑 deploy_from_r2.sh）。
# CI 的部署不读它——CI 显式传 sha，否则就回到"谁最后上传谁说了算"。
s3.put_object(Bucket=bucket, Key='deploy/latest.txt', Body=sha.encode(),
              ContentType='text/plain', CacheControl='no-store')
print(f'✅ 已更新 deploy/latest.txt = {sha[:12]}')

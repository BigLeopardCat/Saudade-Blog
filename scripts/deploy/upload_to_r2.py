# Archive deployment artifacts under deploy/<full-sha>/deploy.tar.gz.
import boto3, io, os, re, subprocess, sys, tarfile
from botocore.config import Config
from deployment_config import read_deployment_config
from database_indexes import load_contract, MAX_CONTRACT_BYTES, CONTRACT_MEMBER


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


credentials = read_deployment_config()
s3 = boto3.client('s3',
    endpoint_url=credentials['R2_ENDPOINT'],
    aws_access_key_id=credentials['R2_ACCESS_KEY'],
    aws_secret_access_key=credentials['R2_SECRET_KEY'],
    config=Config(signature_version='s3v4'),
    region_name='auto')

sha = resolve_sha()
bucket = credentials['R2_BUCKET']
key = f'deploy/{sha}/deploy.tar.gz'

contract_path = os.environ.get('DATABASE_INDEX_CONTRACT', 'database-indexes.json')
if os.path.getsize(contract_path) > MAX_CONTRACT_BYTES:
    sys.exit('Database index contract exceeds size limit')
with open(contract_path, 'rb') as contract_file:
    load_contract(contract_file.read(MAX_CONTRACT_BYTES + 1), sha)

buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode='w:gz') as tar:
    tar.add(contract_path, arcname=CONTRACT_MEMBER)
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

# CI pins DEPLOY_SHA; latest.txt is only for manual deployments without a revision.
s3.put_object(Bucket=bucket, Key='deploy/latest.txt', Body=sha.encode(),
              ContentType='text/plain', CacheControl='no-store')
print(f'✅ 已更新 deploy/latest.txt = {sha[:12]}')

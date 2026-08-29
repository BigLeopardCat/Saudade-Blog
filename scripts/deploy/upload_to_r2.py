import boto3, tarfile, io, os, sys
from botocore.config import Config

s3 = boto3.client('s3',
    endpoint_url=os.environ['R2_ENDPOINT'],
    aws_access_key_id=os.environ['R2_ACCESS_KEY'],
    aws_secret_access_key=os.environ['R2_SECRET_KEY'],
    config=Config(signature_version='s3v4'),
    region_name='auto')

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
s3.upload_fileobj(buf, os.environ['R2_BUCKET'], 'deploy/deploy.tar.gz')
print('✅ 全部文件打包上传完成')

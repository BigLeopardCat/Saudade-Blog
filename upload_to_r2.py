import boto3, tarfile, io, os
from botocore.config import Config

s3 = boto3.client('s3',
    endpoint_url=os.environ['R2_ENDPOINT'],
    aws_access_key_id=os.environ['R2_ACCESS_KEY'],
    aws_secret_access_key=os.environ['R2_SECRET_KEY'],
    config=Config(signature_version='s3v4'),
    region_name='auto')

buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode='w:gz') as tar:
    tar.add('target/release/saudade_blog_bin', arcname='saudade_blog_bin')
    tar.add('frontend/dist', arcname='frontend/dist')
buf.seek(0)
s3.upload_fileobj(buf, os.environ['R2_BUCKET'], 'deploy/deploy.tar.gz')
print('✅ 全部文件打包上传完成')

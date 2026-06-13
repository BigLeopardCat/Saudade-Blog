import boto3, tarfile, io
from botocore.config import Config

s3 = boto3.client('s3',
    endpoint_url='https://f3bdcb44deeea98157f2a9298ad43ab0.r2.cloudflarestorage.com',
    aws_access_key_id='f5c83240b6dd56f0062811b769a5cde9',
    aws_secret_access_key='8a973b6ce131fc16b53ebd83b19a795fedc898140b21743e76c576f06161bd36',
    config=Config(signature_version='s3v4'),
    region_name='auto')

buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode='w:gz') as tar:
    tar.add('target/release/saudade_blog_bin', arcname='saudade_blog_bin')
    tar.add('frontend/dist', arcname='frontend/dist')
buf.seek(0)
s3.upload_fileobj(buf, 'saudade-blog', 'deploy/deploy.tar.gz')
print('✅ 全部文件打包上传完成')

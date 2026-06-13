import boto3, os
from botocore.config import Config

s3 = boto3.client('s3',
    endpoint_url='https://f3bdcb44deeea98157f2a9298ad43ab0.r2.cloudflarestorage.com',
    aws_access_key_id='f5c83240b6dd56f0062811b769a5cde9',
    aws_secret_access_key='8a973b6ce131fc16b53ebd83b19a795fedc898140b21743e76c576f06161bd36',
    config=Config(signature_version='s3v4'),
    region_name='auto')

s3.upload_file('target/release/saudade_blog_bin', 'saudade-blog', 'deploy/saudade_blog_bin')

for root, dirs, files in os.walk('frontend/dist'):
    for f in files:
        path = os.path.join(root, f)
        key = 'deploy/' + path.replace('\\', '/')
        s3.upload_file(path, 'saudade-blog', key)

print('✅ 已上传到 R2')

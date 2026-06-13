#!/bin/bash
# 从 R2 拉取最新构建产物并部署
cd /home/ubuntu/memory_blog_rust

python3 << 'PYEOF'
import boto3, os, shutil
from botocore.config import Config

BUCKET = 'saudade-blog'
PREFIX = 'deploy/'
LOCAL = '/home/ubuntu/memory_blog_rust'

s3 = boto3.client('s3',
    endpoint_url='https://f3bdcb44deeea98157f2a9298ad43ab0.r2.cloudflarestorage.com',
    aws_access_key_id='f5c83240b6dd56f0062811b769a5cde9',
    aws_secret_access_key='8a973b6ce131fc16b53ebd83b19a795fedc898140b21743e76c576f06161bd36',
    config=Config(signature_version='s3v4'),
    region_name='auto')

paginator = s3.get_paginator('list_objects_v2')
pages = paginator.paginate(Bucket=BUCKET, Prefix=PREFIX)

for page in pages:
    for obj in page.get('Contents', []):
        key = obj['Key']
        rel_path = key[len(PREFIX):]
        local_path = os.path.join(LOCAL, rel_path)
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        s3.download_file(BUCKET, key, local_path)
        print(f"Downloaded: {rel_path}")

print("✅ R2 同步完成")
PYEOF

# 重启后端
pkill -f saudade_blog_bin 2>/dev/null || true
sleep 2
chmod +x target/release/saudade_blog_bin
nohup ./target/release/saudade_blog_bin > server_run.log 2>&1 &
sleep 1
echo "✅ 后端已重启"

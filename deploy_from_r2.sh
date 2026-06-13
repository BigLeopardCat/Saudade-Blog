#!/bin/bash
set -e
cd /home/ubuntu/memory_blog_rust
echo "=== 从 R2 拉取更新 ==="

python3 << 'PYEOF'
import boto3, tarfile, os
from botocore.config import Config

s3 = boto3.client('s3',
    endpoint_url='https://f3bdcb44deeea98157f2a9298ad43ab0.r2.cloudflarestorage.com',
    aws_access_key_id='f5c83240b6dd56f0062811b769a5cde9',
    aws_secret_access_key='8a973b6ce131fc16b53ebd83b19a795fedc898140b21743e76c576f06161bd36',
    config=Config(signature_version='s3v4'),
    region_name='auto')

s3.download_file('saudade-blog', 'deploy/deploy.tar.gz', '/tmp/deploy.tar.gz')
with tarfile.open('/tmp/deploy.tar.gz') as tar:
    tar.extractall()
os.remove('/tmp/deploy.tar.gz')
print("✅ 部署文件下载解压完成")
PYEOF

chmod +x target/release/saudade_blog_bin
pkill -f saudade_blog_bin 2>/dev/null || true
sleep 2
nohup ./target/release/saudade_blog_bin > server_run.log 2>&1 &
sleep 1
echo "✅ 部署完成"

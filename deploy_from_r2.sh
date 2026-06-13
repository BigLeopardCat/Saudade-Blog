#!/bin/bash
set -e
cd /home/ubuntu/memory_blog_rust

export $(grep -v '^\s*#' .env | grep -v '^\s*$' | xargs) 2>/dev/null || true
echo "=== 从 R2 拉取更新 ==="

python3 << 'PYEOF'
import boto3, tarfile, os
from botocore.config import Config

s3 = boto3.client('s3',
    endpoint_url=os.environ['R2_ENDPOINT'],
    aws_access_key_id=os.environ['R2_ACCESS_KEY'],
    aws_secret_access_key=os.environ['R2_SECRET_KEY'],
    config=Config(signature_version='s3v4'),
    region_name='auto')

s3.download_file(os.environ['R2_BUCKET'], 'deploy/deploy.tar.gz', '/tmp/deploy.tar.gz')
with tarfile.open('/tmp/deploy.tar.gz') as tar:
    tar.extractall()
os.remove('/tmp/deploy.tar.gz')
print("✅ 部署文件下载解压完成")
PYEOF

# 复制新二进制到 target/release/
cp -f saudade_blog_bin target/release/saudade_blog_bin
chmod +x target/release/saudade_blog_bin
rm -f saudade_blog_bin

pkill -f saudade_blog_bin 2>/dev/null || true
sleep 2
nohup ./target/release/saudade_blog_bin > server_run.log 2>&1 &
sleep 1
echo "✅ 部署完成"

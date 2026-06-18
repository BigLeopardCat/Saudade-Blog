#!/bin/bash
set -e
cd /home/ubuntu/memory_blog_rust

export $(grep -v '^\s*#' .env | grep -v '^\s*$' | xargs) 2>/dev/null || true
echo "=== $(date "+%Y-%m-%d %H:%M:%S") 从 R2 拉取更新 ==="

python3 << 'PYEOF2'
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
PYEOF2

# 如果存在后端二进制则替换并重启
if [ -f saudade_blog_bin ]; then
  cp -f saudade_blog_bin target/release/saudade_blog_bin
  chmod +x target/release/saudade_blog_bin
  rm -f saudade_blog_bin
  pkill -f saudade_blog_bin 2>/dev/null || true
  sleep 2
  nohup ./target/release/saudade_blog_bin > server_run.log 2>&1 &
  echo "✅ $(date "+%H:%M:%S") 后端已更新并重启"
else
  echo "ℹ️ $(date "+%H:%M:%S") 后端无变更，跳过重启"
fi

# 前端 dist 已直接解压到正确位置，Nginx 自动服务新文件
echo "✅ $(date "+%H:%M:%S") 前端已更新"
echo "✅ $(date "+%H:%M:%S") 部署完成"

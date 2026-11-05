#!/usr/bin/env python3
"""列出或清理 R2 deploy/ 下的旧产物，默认只列清单。

保留 latest.txt 和最近 N 个完整提交包；其余 deploy/ 对象属于清理候选。
默认保留三个提交，删除后的包需要重新构建才能恢复。
使用 --keep 调整窗口，确认后加 --apply；不处理 deploy/ 之外的数据。
"""
import argparse
import os
import re
import sys

import boto3
from botocore.config import Config

PREFIX = "deploy/"
LATEST_KEY = "deploy/latest.txt"
_SHA_KEY_RE = re.compile(r"^deploy/([0-9a-f]{40})/deploy\.tar\.gz$")


def main() -> int:
    ap = argparse.ArgumentParser(description="R2 部署产物清理（默认只列不删）")
    ap.add_argument("--keep", type=int, default=3,
                    help="保留最近这么多个提交包（默认 3；0 = 全删，回滚窗口为零）")
    ap.add_argument("--keep-sha", default="",
                    help="这个提交的包无论如何都保留（通常是本次刚部署的那个）")
    ap.add_argument("--apply", action="store_true", help="真删；不加则只打印将要删的内容")
    args = ap.parse_args()

    for k in ("R2_ENDPOINT", "R2_ACCESS_KEY", "R2_SECRET_KEY", "R2_BUCKET"):
        if not os.environ.get(k):
            sys.exit(f"❌ 缺环境变量 {k}，请按 docs/deployment-and-ops.md 配置私有发布环境")

    s3 = boto3.client("s3",
                      endpoint_url=os.environ["R2_ENDPOINT"],
                      aws_access_key_id=os.environ["R2_ACCESS_KEY"],
                      aws_secret_access_key=os.environ["R2_SECRET_KEY"],
                      config=Config(signature_version="s3v4"),
                      region_name="auto")
    bucket = os.environ["R2_BUCKET"]

    objs = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=PREFIX):
        objs.extend(page.get("Contents") or [])

    packages, others = [], []
    for o in objs:
        m = _SHA_KEY_RE.match(o["Key"])
        (packages if m else others).append(o)

    # 新的在前：按 LastModified 倒序（同刻按 Key 稳定排序，避免两次跑出不同结论）
    packages.sort(key=lambda o: (str(o["LastModified"]), o["Key"]), reverse=True)
    keep = packages[:max(args.keep, 0)]
    if args.keep_sha:
        keep += [o for o in packages if o["Key"].split("/")[1] == args.keep_sha]
    # 去重（--keep-sha 通常就在最近 N 个里）：不按 Key 去重会把同一个包数两遍
    keep = list({o["Key"]: o for o in keep}.values())
    keep_keys = {o["Key"] for o in keep}
    drop = [o for o in packages if o["Key"] not in keep_keys] + [
        o for o in others if o["Key"] != LATEST_KEY]

    def mb(n):
        return f"{n / 1024 / 1024:.1f}MB"

    print(f"桶内 {PREFIX} 前缀：{len(objs)} 个对象 / {mb(sum(o['Size'] for o in objs))}")
    print(f"保留 {len(keep)} 个提交包（--keep {args.keep}"
          + (f"，--keep-sha {args.keep_sha[:12]}" if args.keep_sha else "") + "）：")
    for o in keep:
        print(f"    keep  {str(o['LastModified'])[:16]}  {o['Key']}  {mb(o['Size'])}")
    print(f"要删 {len(drop)} 个对象 / {mb(sum(o['Size'] for o in drop))}：")
    for o in drop[:20]:
        print(f"    del   {str(o['LastModified'])[:16]}  {o['Key']}  {mb(o['Size'])}")
    if len(drop) > 20:
        print(f"    …其余 {len(drop) - 20} 个（同一族）")
    # 留一份计数便于在部署日志里一眼看出"这一族清了没有"
    if not args.apply:
        print("（只列不删；要真删加 --apply）")
        return 0

    gone = 0
    for i in range(0, len(drop), 1000):     # DeleteObjects 单次上限 1000 个键
        batch = [{"Key": o["Key"]} for o in drop[i:i + 1000]]
        resp = s3.delete_objects(Bucket=bucket, Delete={"Objects": batch, "Quiet": True})
        errs = resp.get("Errors") or []
        if errs:
            print(f"⚠️ 有 {len(errs)} 个键没删掉（前两个：{errs[:2]}）")
        gone += len(batch) - len(errs)
    print(f"✅ 已删除 {gone} 个对象；R2 现在只剩 latest.txt + {len(keep)} 个提交包")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

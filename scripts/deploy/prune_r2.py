#!/usr/bin/env python3
"""R2 产物清理：只保留最近 N 个提交的部署包，其余 deploy/ 下的对象一律删掉。

为什么要有它（20260924，用户报"R2 会被写爆产生账单"）：实测桶内 `deploy/` 前缀下
11323 个对象 / 2735MB，构成是——

  · 11299 个 `deploy/frontend/dist/**`（2432MB）：CI 的「for CDN」那一步把构建产物
    **逐文件**上传（每次部署约 4986 次 PUT ⇒ 一个月 8 次/天就超过 R2 免费档的
    100 万次 Class A 写入）。这一步**没有任何消费方**：nginx 服务的是本机
    `frontend/dist`，`VITE_CDN_BASEURL` 重写的是 `/api/protect/download/` 图片接口、
    与这些静态对象无关；内容与 `deploy/<sha>/deploy.tar.gz` 里的 frontend/dist 完全
    重复。⇒ 那一步已从工作流里删掉，本脚本负责把存量清掉。
  · 21 个 `deploy/<sha>/deploy.tar.gz`（289MB）：真正的部署产物，按提交号归档。
  · 2 个 20260923 改造前的遗留单文件键（`deploy/frontend.tar.gz`、`deploy/saudade_blog_bin`）。

保留策略（用户 20260924 拍板）：**最近 3 个提交的包**——留一条约 3 次部署的回滚窗口
（手动回滚 = `DEPLOY_SHA=<旧提交> bash scripts/deploy/deploy_from_r2.sh`，见 CLAUDE.md §6）。
被删掉的包就取不回来了，只能重跑 CI 用那个提交号重新构建（所以窗口别设成 0）。

判据是**白名单**，不是"删得干净"：只留 `deploy/latest.txt` 与最近 N 个
`deploy/<40 位提交号>/deploy.tar.gz`，`deploy/` 下其余任何键都算残留（含前端那一棵树、
遗留单文件键、以及将来误传的散键）。

用法（默认**只列不删**，要真删得显式加 `--apply`）：
    python3 scripts/deploy/prune_r2.py                  # 看会删掉什么
    python3 scripts/deploy/prune_r2.py --apply          # 真删（保留最近 3 个包）
    python3 scripts/deploy/prune_r2.py --apply --keep 5
    python3 scripts/deploy/prune_r2.py --apply --keep-sha "$(git rev-parse HEAD)"

`deploy_from_r2.sh` 在一次部署**落地成功之后**调用它（`--keep-sha` = 本次部署的提交），
所以每次部署结束 R2 都会回到"latest.txt + 最近 N 个包"这个不变量上。清理失败**不影响**
部署结果（账单卫生不该把一次成功的部署标红）。

凭据只从环境变量读（与 upload_to_r2.py / deploy_from_r2.sh 同一套：
R2_ENDPOINT / R2_ACCESS_KEY / R2_SECRET_KEY / R2_BUCKET），本脚本不打印任何凭据。
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
            sys.exit(f"❌ 缺环境变量 {k}（照 README/CLAUDE.md §6：先在 shell 里 export .env 那几行）")

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

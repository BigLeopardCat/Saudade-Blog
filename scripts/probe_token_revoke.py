#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""令牌收回与账号冻结的**真链路**活体探针（20260926，对应 docs/security-boundary.md §7⑫）。

为什么必须真打一遍：这一整套判据全是"库里的值与令牌里的值比一次"，而它的失效方式
恰恰是**静默**的——列不存在 ⇒ 每个请求都 401（全站登不进来）、列存在但判据读错了列
⇒ 收回不生效（看起来一切正常）。两种都不会抛异常，只有真发请求才能分辨。

它自己建一个**一次性账号**（`probe_revoke_<时间戳>`）来当靶子，跑完删掉自己——
**不碰任何真实用户**（冻结会顺手把令牌代次 +1，落在真人账号上等于把人踢下线）。
靶子账号与真密码都不会被打印。

用法：
    .venv/bin/python scripts/probe_token_revoke.py --admin-uid <管理员的 uid>
    # 或者让它自己从库里挑一个（只挑用户名带 agent_test_ / probe_ 前缀的测试账号）
    .venv/bin/python scripts/probe_token_revoke.py

凭据从 `memory_blog_rust/.env` 的 `DATABASE_URL` / `JWT_SECRET` 现读，**不回显、不落盘**。
"""
import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUST = os.environ.get("RUST_BASE", "http://127.0.0.1:3000")

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


def env(name):
    txt = (ROOT / ".env").read_text(encoding="utf-8")
    m = re.search(rf"^{name}=(.*)$", txt, re.M)
    if not m:
        sys.exit(f".env 里没有 {name}")
    return m.group(1).strip().strip('"').strip("'")


SECRET = env("JWT_SECRET")


def b64(b: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def sign(sub: int, ver=None, ttl: int = 300) -> str:
    """签一枚登录令牌。`ver=None` 时**不带代次声明**——那是 agent 代调令牌与部署前
    旧令牌的形状（`authz::check_token` 对它只判冻结、跳过代次比对）。"""
    payload = {"sub": sub, "exp": int(time.time()) + ttl, "role": "user"}
    if ver is not None:
        payload["ver"] = ver
    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = b64(json.dumps(payload).encode())
    sig = b64(hmac.new(SECRET.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest())
    return f"{head}.{body}.{sig}"


def token_of(r):
    """从响应里取令牌。**两种形状都认**：登录返回的是裸字符串
    （`ApiResponse<String>`），改密码返回的是 `{token}` 对象
    （`ApiResponse<PasswordChangedDto>`）——同一个"令牌"在两条接口上形状不同，
    第一次跑就是被这个绊住的（`data` 是 str 却去 `.get("token")`）。"""
    if not isinstance(r, dict):
        return None
    d = r.get("data")
    if isinstance(d, str):
        return d or None
    if isinstance(d, dict):
        return d.get("token") or None
    return None


def call(method, path, token=None, body=None):
    """返回 (http_status, json_or_text)。绝不打印 token。"""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(RUST + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read().decode("utf-8", "replace")
            status = r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read().decode("utf-8", "replace"), e.code
    try:
        return status, json.loads(raw)
    except Exception:
        return status, raw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--admin-uid", type=int, default=0,
                    help="用一个管理员账号的 uid 发起冻结/解冻（它自己必须是 admin）")
    ap.add_argument("--keep", action="store_true", help="跑完不删靶子账号（默认删）")
    args = ap.parse_args()
    if not args.admin_uid:
        sys.exit("请用 --admin-uid 指定一个管理员 uid（探针不会替你猜哪个是管理员）")

    admin_uid = args.admin_uid
    admin = sign(admin_uid, ver=0)
    stamp = time.strftime("%Y%m%d%H%M%S")
    name = f"probe_revoke_{stamp}"
    pw = secrets.token_urlsafe(18)
    target_id = None

    print(f"【零】前置：管理员 uid={admin_uid} 的后台权限")
    st, r = call("GET", "/api/protected/stats/users", admin)
    check("管理员令牌打得开后端（不是 401/403）", st == 200, f"http={st}")
    if st != 200:
        sys.exit("管理员身份就不通，后面的结论都没有意义——先查 --admin-uid 对不对")

    print("\n【一】冻结前：靶子账号能正常用")
    st, r = call("POST", "/api/temp-users",
                 admin, {"username": name, "password": pw})
    check("建出一个一次性靶子账号", st == 200 and r.get("code") == 200,
          f"http={st} code={r.get('code') if isinstance(r, dict) else r}")
    if st != 200 or r.get("code") != 200:
        sys.exit("建不出靶子账号，停手（是否重名？）")
    st, r = call("GET", "/api/temp-users", admin)
    target_id = next((u["id"] for u in r if u.get("username") == name), None)
    check("靶子账号出现在后台列表里（列表含全部已登记角色）", target_id is not None,
          f"id={target_id} status={next((u.get('status') for u in r if u.get('username') == name), None)}")

    st, r = call("POST", "/api/login", None, {"username": name, "password": pw})
    check("靶子能登录", st == 200 and r.get("code") == 200, f"http={st} code={r.get('code')}")
    tok = token_of(r)
    if not tok:
        sys.exit("登录没拿到令牌")
    st, r = call("GET", "/api/protected/profile", tok)
    check("冻结前：它的令牌能访问受保护接口", st == 200 and r.get("code") == 200,
          f"http={st} code={r.get('code')}")

    try:
        print("\n【二】冻结 ⇒ 已签发的令牌当场失效")
        st, r = call("POST", f"/api/temp-users/{target_id}/status", admin, {"frozen": True})
        check("管理员能冻结它", st == 200 and r.get("code") == 200,
              f"http={st} msg={r.get('message') if isinstance(r, dict) else r}")
        st, r = call("GET", "/api/protected/stats/users", tok)
        check("旧令牌打后台接口 → 401（auth_guard 那条闸）", st == 401, f"http={st}")
        st, r = call("GET", "/api/protected/profile", tok)
        check("旧令牌打普通受保护接口 → 带原因的拒绝（auth_uid 那个出口）",
              st == 200 and r.get("code") == 500 and "冻结" in (r.get("message") or ""),
              f"http={st} code={r.get('code')} msg={r.get('message') if isinstance(r, dict) else r}")
        st, r = call("POST", "/api/login", None, {"username": name, "password": pw})
        check("冻结账号连登录都进不来（口令正确也一样）",
              st == 200 and r.get("code") == 500 and "冻结" in (r.get("message") or ""),
              f"http={st} msg={r.get('message') if isinstance(r, dict) else r}")
        # 下面两条锁的是当天同时收口的两处旁路：graph.rs（向量图谱）与 talks.rs（河灯）
        # 此前各自手写「只验签不查库」的 current_uid ⇒ 冻结账号照旧能刷 embedding、放河灯。
        # 它们现在走 auth_uid，冻结即解析不出身份 ⇒ 在这两条路径上表现为"像没登录"。
        st, r = call("POST", "/api/public/graph/query", tok, {"q": "冻结旁路"})
        check("冻结令牌打向量图谱查询 → 401（旁路一已收口）",
              st == 401 and isinstance(r, dict) and r.get("reason") == "login_required",
              f"http={st} reason={r.get('reason') if isinstance(r, dict) else r}")
        st, r = call("GET", "/api/protect/board/mine", tok)
        check("冻结令牌打河灯（自家留言）→ 拒绝登录（旁路二已收口）",
              st == 200 and r.get("code") != 200 and "登录" in (r.get("message") or ""),
              f"http={st} code={r.get('code')} msg={r.get('message') if isinstance(r, dict) else r}")

        print("\n【三】解冻 ⇒ 不复活冻结前的登录态（代次只增不减）")
        st, r = call("POST", f"/api/temp-users/{target_id}/status", admin, {"frozen": False})
        check("管理员能解冻它", st == 200 and r.get("code") == 200,
              f"http={st} msg={r.get('message') if isinstance(r, dict) else r}")
        st, r = call("GET", "/api/protected/profile", tok)
        check("解冻后**那枚旧令牌仍然 401/被拒**（不是「又能用了」）",
              not (st == 200 and r.get("code") == 200),
              f"http={st} code={r.get('code')} msg={r.get('message') if isinstance(r, dict) else r}")
        st, r = call("POST", "/api/login", None, {"username": name, "password": pw})
        check("解冻后重新登录能进", st == 200 and r.get("code") == 200,
              f"http={st} code={r.get('code')}")
        tok2 = token_of(r)
        st, r = call("GET", "/api/protected/profile", tok2)
        check("新令牌可用", st == 200 and r.get("code") == 200, f"http={st} code={r.get('code')}")

        print("\n【四】无代次声明的令牌（agent 60 秒代调令牌的形状）只判冻结")
        st, r = call("GET", "/api/protected/profile", sign(int(target_id), ver=None))
        check("不带 ver 的令牌照常放行（不会被当成「代次 0 的旧令牌」误伤）",
              st == 200 and r.get("code") == 200, f"http={st} code={r.get('code')}")

        print("\n【五】改密码 ⇒ 本机拿到新令牌，其他令牌全废")
        newpw = secrets.token_urlsafe(18)
        st, r = call("PUT", "/api/protected/profile/password", tok2,
                     {"oldPassword": pw, "newPassword": newpw})
        fresh = token_of(r)
        check("改密码成功并返回一枚新令牌", st == 200 and r.get("code") == 200 and bool(fresh),
              f"http={st} code={r.get('code')} has_token={bool(fresh)}")
        st, r = call("GET", "/api/protected/profile", tok2)
        check("改密码之前的那枚令牌已失效", not (st == 200 and r.get("code") == 200),
              f"http={st} code={r.get('code')}")
        st, r = call("GET", "/api/protected/profile", fresh)
        check("改密码返回的新令牌可用（本机不掉线）", st == 200 and r.get("code") == 200,
              f"http={st} code={r.get('code')}")

        print("\n【六】不能冻结自己")
        st, r = call("POST", f"/api/temp-users/{admin_uid}/status", admin, {"frozen": True})
        check("管理员冻结自己 → 后端拒绝",
              st == 200 and r.get("code") != 200 and "自己" in (r.get("message") or ""),
              f"http={st} msg={r.get('message') if isinstance(r, dict) else r}")
        st, r = call("GET", "/api/protected/stats/users", admin)
        check("拒绝之后自己**仍然可用**（半截状态没留下）", st == 200, f"http={st}")

        print("\n【七】非普通账号不能被这个入口删掉")
        st, r = call("DELETE", f"/api/temp-users/{admin_uid}", admin)
        check("删管理员 uid → 后端拒绝",
              st == 200 and r.get("code") != 200 and "普通用户" in (r.get("message") or ""),
              f"http={st} msg={r.get('message') if isinstance(r, dict) else r}")
    finally:
        if target_id and not args.keep:
            st, r = call("DELETE", f"/api/temp-users/{target_id}", admin)
            ok = st == 200 and isinstance(r, dict) and r.get("code") == 200
            check("收尾：靶子账号已删除", ok,
                  f"http={st} msg={r.get('message') if isinstance(r, dict) else r}")
        elif target_id:
            print(f"  ⚠️ --keep：靶子账号 id={target_id}（{name}）留在库里，请自己清理")

    print("\n" + ("全部通过" if not FAILS else f"失败 {len(FAILS)} 项：" + "; ".join(FAILS)))
    return 1 if FAILS else 0


if __name__ == "__main__":
    raise SystemExit(main())

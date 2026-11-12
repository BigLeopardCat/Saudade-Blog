#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""令牌收回与账号冻结的**真链路**活体探针。"""
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
    ap.add_argument("--no-self-probe", action="store_true",
                    help="跳过【六】【七】（对管理员自己的 uid 发冻结/删除请求，期望被拒）"
                         "——夜间无人值守跑法用它，别让 cron 每晚真发这两个写请求")
    args = ap.parse_args()
    if not args.admin_uid:
        sys.exit("请用 --admin-uid 指定一个管理员 uid（探针不会替你猜哪个是管理员）")

    admin_uid = args.admin_uid

    admin = sign(admin_uid, ver=None)
    stamp = time.strftime("%Y%m%d%H%M%S")
    name = f"probe_revoke_{stamp}"
    pw = secrets.token_urlsafe(18)
    target_id = None

    print(f"【零】前置：管理员 uid={admin_uid} 的后台权限")
    st, r = call("GET", "/api/protected/stats/users", admin)
    check("管理员令牌打得开后端（不是 401/403）", st == 200, f"http={st}")
    if st != 200:

        print(f"\n⚠ 前置不可用：管理员 uid={admin_uid} 的令牌打不开后台（http={st}）"
              "——这一夜**没有评估**收回语义，不是「有回归」。"
              "换一个角色相符、未被冻结的 uid 后重跑（先看 eval/identity_preflight.py 的判据）。")
        return 3

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

        if args.no_self_probe:
            # --no-self-probe 禁用针对真实管理员的冻结和删除拒绝探针，供无人值守运行使用。
            print(f"\n【六】【七】--no-self-probe：跳过对 uid={admin_uid} 的冻结/删除尝试"
                  "（负向断言，夜间不做真请求；手动跑请不带此开关）")
        else:
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

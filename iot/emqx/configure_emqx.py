#!/usr/bin/env python3
"""EMQX 生产级配置（幂等，纯 REST API）—— schema 依据 EMQX 5.8.9 实测校准：
   1. Dashboard 登录 → 轮换管理员口令 → 创建 API Key（5.8 起 REST 仅接受 API Key）
   2. JWT 认证：mechanism=jwt, algorithm=hmac-based, 复用博客 JWT_SECRET, 校验 exp
   3. 授权：no_match=deny + built-in database 规则（PUT 全量替换）
   4. 验证（不打印任何密钥）

用法：
    EMQX_ADMIN_PASS='<dashboard 管理员口令>' python3 iot/emqx/configure_emqx.py

环境变量（都有可推导的默认值，一般不用配）：
    EMQX_ADMIN_USER   默认 admin
    EMQX_ADMIN_PASS   **没有默认值**，必填（见下）
    EMQX_API          REST 根，默认 http://127.0.0.1:18083/api/v5
    BLOG_ENV          博客 .env 的路径，默认本脚本上溯两级（= 仓库根）的 .env
    DEVICE_AUTH_URL   设备认证回调，默认 http://127.0.0.1:3100/api/devices/auth

⚠️ `EMQX_ADMIN_PASS` 刻意**不给默认值**：它只能来自 EMQX 初次安装时那个口令，而
"猜一个常见默认口令试着登录"在别人的机器上既是错的、也是不该有的行为。没设就退出，
并把该做什么打出来。
"""
import base64, json, os, re, secrets, urllib.error, urllib.request

BASE = os.environ.get("EMQX_API", "http://127.0.0.1:18083/api/v5")
DIR = os.path.dirname(os.path.abspath(__file__))
KEY_FILE = os.path.join(DIR, ".api_key")        # api_key:secret (0600)
CREDS_FILE = os.path.join(DIR, ".admin_creds")  # dashboard 用户凭据 (0600)
# 博客 .env：默认从本脚本上溯两级（emqx/ → iot/ → 仓库根）。换部署位置/改仓库目录名都不用改代码。
BLOG_ENV = os.environ.get("BLOG_ENV", os.path.join(DIR, "..", "..", ".env"))

ADMIN_USER = os.environ.get("EMQX_ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("EMQX_ADMIN_PASS")

def read_jwt_secret():
    """从博客 .env 取 JWT_SECRET —— EMQX 用**同一个密钥**验博客签发的令牌。

    这也是这套东西的信任边界所在：broker 只验签与 exp，**不查库** ⇒ 冻结账号/收回令牌
    管不到设备侧（见仓库 docs/security-boundary.md）。换 JWT_SECRET 时两边一起换，
    漏了这里表现为"网页能开、设备与控制台全连不上"。
    """
    path = os.path.abspath(BLOG_ENV)
    try:
        with open(path) as f:
            for line in f:
                m = re.match(r"JWT_SECRET=(.*)", line.strip())
                if m:
                    return m.group(1)
    except FileNotFoundError:
        raise SystemExit(f"找不到博客 .env：{path}\n"
                         f"（用 BLOG_ENV=<路径> 指定，或确认本脚本还在仓库的 iot/emqx/ 下）")
    raise SystemExit(f"{path} 里没有 JWT_SECRET —— 博客后端起不来，先把那边配好")

def raw(method, path, body=None, headers=None):
    req = urllib.request.Request(BASE + path, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data) as r:
            text = r.read()
            try:
                return r.status, json.loads(text or b"{}")
            except Exception:
                return r.status, text.decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:500]

def basic(u, p):
    return {"Authorization": "Basic " + base64.b64encode(f"{u}:{p}".encode()).decode()}

def main():
    secret = read_jwt_secret()
    H = None

    # ---------- 1. 登录 → 轮换口令 → 创建/复用 API Key ----------
    if os.path.exists(KEY_FILE):
        with open(KEY_FILE) as f:
            key, key_secret = f.read().strip().split(":", 1)
        H = basic(key, key_secret)
        code, _ = raw("GET", "/authentication", headers=H)
        print(f"[1] 复用 API Key（校验 HTTP {code}）")
    else:
        if not ADMIN_PASS:
            raise SystemExit(
                "没有 API Key（还没配过），要登录 Dashboard 才谈得上配置 —— 但没给管理员口令。\n"
                "  EMQX_ADMIN_PASS='<口令>' python3 iot/emqx/configure_emqx.py\n"
                "（口令是 EMQX 初次安装时那个；本脚本不给默认值，也不去猜。）")
        code, login = raw("POST", "/login", {"username": ADMIN_USER, "password": ADMIN_PASS})
        assert code == 200, f"dashboard 登录失败 HTTP {code}: {login}"
        token = login["token"]
        bearer = {"Authorization": "Bearer " + token}

        # 轮换管理员口令（/users 路径仅接受 Bearer）
        new_pass = secrets.token_urlsafe(18)
        code, resp = raw("PUT", f"/users/{ADMIN_USER}",
                         {"old_password": ADMIN_PASS, "password": new_pass}, headers=bearer)
        if code == 200:
            with open(CREDS_FILE, "w") as f:
                f.write(f"{ADMIN_USER}:{new_pass}\n")
            os.chmod(CREDS_FILE, 0o600)
            print(f"[1] Dashboard 口令已轮换，凭据落盘 {CREDS_FILE} (0600)")
        else:
            print(f"[1] 口令轮换跳过（HTTP {code} {resp}），沿用现有口令")

        code, resp = raw("POST", "/api_key",
                         {"name": "saudade-iot", "enable": True,
                          "desc": "iot device platform (blog console / device auth)",
                          "expired_at": "2036-01-01T00:00:00+08:00"},
                         headers=bearer)
        assert code == 200, f"API Key 创建失败 HTTP {code}: {resp}"
        key, key_secret = resp["api_key"], resp["api_secret"]
        with open(KEY_FILE, "w") as f:
            f.write(f"{key}:{key_secret}\n")
        os.chmod(KEY_FILE, 0o600)
        print(f"[1] API Key 已创建并落盘 {KEY_FILE} (0600)")
        H = basic(key, key_secret)

    # ---------- 2. JWT 认证（5.8 schema：algorithm=hmac-based, 无 backend 字段） ----------
    code, existing = raw("GET", "/authentication", headers=H)
    assert code == 200, f"读取认证链失败 HTTP {code}: {existing}"
    jwt_id = next((c["id"] for c in existing if c.get("mechanism") == "jwt"), None)
    # 5.8 schema：verify_claims 是 claim->期望值映射；exp 由 broker 自动校验（disconnect_after_expire 策略）
    body = {
        "mechanism": "jwt",
        "use_jwks": False,
        "algorithm": "hmac-based",
        "secret": secret,
        "secret_base64_encoded": False,
        "from": "password",
        "enable": True,
    }
    if jwt_id:
        code, resp = raw("PUT", f"/authentication/{jwt_id}", body, headers=H)
        print(f"[2] JWT 认证链已更新 (HTTP {code})")
        if code >= 300:
            print("    ", resp)
    else:
        code, resp = raw("POST", "/authentication", body, headers=H)
        print(f"[2] JWT 认证链已创建 (HTTP {code})")
        if code >= 300:
            print("    ", resp)

    # ---------- 3. 授权（no_match=deny + 规则全量 PUT） ----------
    code, _ = raw("PUT", "/authorization/settings",
                  {"cache": {"enable": True, "max_size": 32, "ttl": "1m"},
                   "deny_action": "ignore", "no_match": "deny"}, headers=H)
    print(f"[3] 默认权限 no_match=deny (HTTP {code})")
    # 5.8 schema：/rules/all 的 POST 为【替换式写入】而非追加（实测：只发缺失规则会把
    # 未包含的旧规则清掉，导致设备发布被静默拒绝）。幂等策略：全量对齐——先清空再写入全部。
    needed = [
        {"permission": "allow", "action": "all", "topic": "broadcast/#"},
        {"permission": "allow", "action": "all", "topic": "users/${username}/#"},
        {"permission": "allow", "action": "all", "topic": "devices/${username}/#"},
        {"permission": "allow", "action": "all", "topic": "console/${username}/#"},
    ]
    code, resp = raw("GET", "/authorization/sources/built_in_database/rules/all", headers=H)
    existing_topics = sorted(r.get("topic", "") for r in resp.get("rules", []))
    want_topics = sorted(r["topic"] for r in needed)
    if existing_topics != want_topics:
        code, _ = raw("DELETE", "/authorization/sources/built_in_database/rules/all", headers=H)
        code, resp = raw("POST", "/authorization/sources/built_in_database/rules/all",
                         {"rules": needed}, headers=H)
        print(f"[3] 规则已全量对齐 (HTTP {code} {resp})")
    else:
        print("[3] 规则已齐备，跳过")

    # ---------- 3.5 设备 HTTP 认证链（device_id + device_key -> 设备服务校验） ----------
    code, existing = raw("GET", "/authentication", headers=H)
    http_id = next((c["id"] for c in existing if c.get("mechanism") == "password_based"
                    and c.get("backend") == "http"), None)
    http_body = {
        "mechanism": "password_based",
        "backend": "http",
        "method": "post",
        "url": os.environ.get("DEVICE_AUTH_URL", "http://127.0.0.1:3100/api/devices/auth"),
        "body": {"username": "${username}", "password": "${password}"},
        "headers": {"content-type": "application/json"},
        "connect_timeout": "5s",
        "request_timeout": "5s",
        "pool_size": 8,
        "enable": True,
    }
    if http_id:
        code, resp = raw("PUT", f"/authentication/{http_id}", http_body, headers=H)
        print(f"[3.5] 设备 HTTP 认证链已更新 (HTTP {code} {resp})")
    else:
        code, resp = raw("POST", "/authentication", http_body, headers=H)
        print(f"[3.5] 设备 HTTP 认证链已创建 (HTTP {code} {resp})")
        if code >= 300:
            print("    ", resp)

    # ---------- 4. 验证 ----------
    code, st = raw("GET", "/status", headers=H)
    print(f"[4] broker status: HTTP {code} {st}")
    code, chains = raw("GET", "/authentication", headers=H)
    for c in chains:
        print(f"[4] 认证链: mechanism={c.get('mechanism')} algorithm={c.get('algorithm')} "
              f"enable={c.get('enable')} (id={c.get('id')})")
    code, settings = raw("GET", "/authorization/settings", headers=H)
    print(f"[4] 授权设置: no_match={settings.get('no_match')} deny_action={settings.get('deny_action')}")

if __name__ == "__main__":
    main()

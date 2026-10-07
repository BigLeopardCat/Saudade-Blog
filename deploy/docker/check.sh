#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  Docker 安装路的**离线判据**：本机没装 docker 也能跑，一个命令看完全部结论。
#
#    bash deploy/docker/check.sh
#
#  它判的都是"错了就静默"的那几件事，每一条都能判死：
#   ① 所有脚本 `bash -n` 过；prepare.sh 的 `--dry-run` / `--print` **一个字都不写**
#      （并且它 stderr 里不许出现 `command not found` —— 不带引号的 heredoc 正文里
#       一个反引号就会被当命令执行掉，那是最容易漏的一种自伤）
#   ② compose.yaml 解析得过、host 网络的服务没有 ports、healthcheck / depends_on 语义对得上、
#      引用的文件与插值键都齐（后两档要先跑过 prepare.sh；没跑过就是"跳过"，不是"红"）
#   ③ **渲染字节比对**：docker 侧的 nginx 配置 == 裸机 install.sh 的产物（同输入）
#      —— 这条是这一整套里最值钱的判据（本机无 docker 也能跑）
#   ④ 键集合不漂：prepare.sh 会写进两份 .env 的键，全都在两份 `.env.example` ∪
#      install.sh ∪ Rust `env::var` 那张名单里；且 **IOT_ENABLED 不在 agent 那份里**
#      （空串给 bool 字段 ⇒ pydantic ValidationError ⇒ agent 导入期崩，见 CONTRIBUTING）
#   ⑤ 三个镜像里那几条"不写就会静默出错"的指令都在（构建顺序、产物断言、tzdata…），
#      外加**后端那条 `find … touch`**：cargo 按 mtime 判新鲜度，而 BuildKit 的 COPY 保留
#      clone 时的旧 mtime ⇒ 不刷新就等于"真源码一个字都没编、空桩上线"（20261007 实测）；
#      有 cargo 的机器上还会把这条机制**可执行地复刻**一遍（⑤.1）
#   ⑥ prepare.sh 写进 agent.env 的键，agent 那边真的有读取路径（Settings 字段 or os.environ）
#   ⑦ db-init.sh 的控制流：拿一个**桩 mysql**（只录不连）跑五种场景 —— 空库/已有表/
#      已有管理员/建库假成功/同名非管理员账号。这是它在上线前的唯一一次被执行。
#   ⑧ **裸机安装器 `deploy/install.sh` 的 `setup_env` 真跑一遍**（把脚本复制到 scratch、
#      摘掉末尾的 `main "$@"` 再 source）：全新 `.env` 里不许留下 `.env.example` 的占位值
#      （那正是 20261007 之前那条 bug：占位值未被覆盖 ⇒ 后端连不上库、而安装器全绿），
#      已有的 `.env` 一个键都不许被改；顺带钉住**两份 urlenc 实现输出逐字相同**（那份
#      连接串拼装现在有两个消费者：dotenvy 与 compose/env_file 两条解析路）。
#
#  **不判**（要靠真 docker 机器）：镜像能构建、容器能起来、证书受信、对话能调工具 ——
#  那些在 README 的《验收清单》里，每条都给了能判死的命令。
# ═══════════════════════════════════════════════════════════════════════════════
set -uo pipefail     # 故意**不用 -e**：要把每条判据都跑完再报总账（每条自己判）

cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
REPO_DIR="$(cd ../.. && pwd)"
AGENT_DIR="$REPO_DIR/saudade-blog-agent"
FAIL=0
pass() { printf '  ✅ %s\n' "$*"; }
fail() { printf '  ✗ %s\n' "$*"; FAIL=$((FAIL + 1)); }
skip() { printf '  ↷ %s\n' "$*"; }
sec()  { printf '\n══ %s ══\n' "$*"; }
# 断言辅助：assert_has <文件> <正则> <说明>
assert_has() { grep -qE "$2" "$1" && pass "$3" || fail "$3（$1 里没有 /$2/）"; }

SCRATCH="$(mktemp -d -t saudade-check-XXXXXX)" || exit 1
# 只删**自己刚建的这个**（路径由 mktemp 给、变量在手），不碰 /tmp 里其它任何东西
cleanup() { case "$SCRATCH" in /tmp/saudade-check.*) rm -rf "$SCRATCH" ;; esac; }
trap cleanup EXIT

# ═══ ① 语法 + dry-run 不写盘 ═══════════════════════════════════════════════════
sec "① 脚本语法与 dry-run 的边界"
for f in prepare.sh db-init.sh agent-entrypoint.sh check.sh ../../deploy/nginx/render.sh ../../deploy/install.sh; do
    if bash -n "$f" 2>"$SCRATCH/n.err"; then pass "bash -n $f"
    else fail "bash -n $f：$(head -2 "$SCRATCH/n.err" | tr '\n' ' ')"; fi
done

snapshot() {   # 产物 + 仓库外那两处"绝不该被 docker 那套碰"的东西，一起留指纹
    { ls -la generated .env 2>/dev/null; md5sum generated/* generated/.credentials generated/ssl/* .env 2>/dev/null
      md5sum "$REPO_DIR/.env" 2>/dev/null; ls -la "$REPO_DIR/deploy/.credentials" 2>/dev/null
      md5sum "$REPO_DIR"/deploy/nginx/* 2>/dev/null; } | sed 's/[0-9]\{2\}:[0-9]\{2\}/TIME/' >"$1"
}
snapshot "$SCRATCH/before.txt"
bash prepare.sh --dry-run --yes --domain check.example.com --data-dir "$SCRATCH/data" \
     --provider deepseek --api-key x >"$SCRATCH/dry.out" 2>"$SCRATCH/dry.err"
dryrc=$?
[ "$dryrc" = 0 ] && pass "prepare.sh --dry-run 退出码 0" || fail "prepare.sh --dry-run 退出码 $dryrc"
grep -q 'command not found' "$SCRATCH/dry.err" \
    && fail "dry-run 的 stderr 里有 command not found（heredoc 正文里有没转义的反引号，被当命令跑了）" \
    || pass "dry-run 没有误执行的反引号"
bash prepare.sh --print blog.conf --domain check.example.com >"$SCRATCH/print.conf" 2>"$SCRATCH/print.err" \
    && pass "prepare.sh --print blog.conf 退出码 0" || fail "prepare.sh --print blog.conf 失败"
snapshot "$SCRATCH/after.txt"
if diff -q "$SCRATCH/before.txt" "$SCRATCH/after.txt" >/dev/null; then
    pass "--dry-run / --print 一个字都没写（含仓库根 .env、deploy/.credentials、deploy/nginx/*）"
else
    fail "--dry-run / --print 动了文件："; diff "$SCRATCH/before.txt" "$SCRATCH/after.txt" | sed 's/^/      /'
fi

# ═══ ② compose.yaml：解析 + 引用 + 网络 ════════════════════════════════════════
sec "② compose.yaml"
python3 - "$SCRATCH" <<'PY'
import sys, os, re, subprocess, pathlib
try:
    import yaml
except ImportError:
    print("  ↷ 没装 PyYAML，跳过（pip install pyyaml）"); sys.exit(0)
scratch = sys.argv[1]
bad = []
# 生成物在不在场，判据分两档：**结构/网络语义不需要生成物**（fresh clone 也判），
# "引用的文件真的在吗"与"插值键齐不齐"必须有 .env 与 generated/ 才判得了 ——
# 那几条在还没跑过 prepare.sh 时是"跳过"，不是"红"（红要意味着"有东西坏了"）。
have_products = pathlib.Path(".env").exists() and pathlib.Path("generated").is_dir()
doc = yaml.safe_load(pathlib.Path("compose.yaml").read_text())
print(f"  ✅ YAML 解析通过：{len(doc.get('services', {}))} 个服务 {list(doc['services'])}")
if not have_products:
    print("  ↷ 还没跑过 prepare.sh（没有 .env / generated/）⇒ 本次只判结构与网络语义，"
          "引用的文件与插值键那两档跳过")
if doc.get("name") != "saudade-blog":
    bad.append("name: 必须固定成 saudade-blog（不然数据卷名字会随目录名漂）")
env = {}
for line in pathlib.Path(".env").read_text().splitlines() if pathlib.Path(".env").exists() else []:
    line = line.strip()
    if line and not line.startswith("#"):
        k, _, v = line.partition("="); env[k] = v
# 2.1 host 网络的服务不许有 ports（compose 自己也会报错，早一点更清楚）
for n, s in doc["services"].items():
    if s.get("network_mode") == "host" and "ports" in s:
        bad.append(f"{n}: host 网络不能写 ports（要发布端口就只能走桥接）")
# 2.2 MySQL 必须有 healthcheck，且 db-init 必须等它；应用服务必须等 db-init 跑完
mysql = doc["services"].get("mysql", {})
if "healthcheck" not in mysql: bad.append("mysql: 没有 healthcheck（db-init 会抢在 MySQL 前连库）")
legal = {"service_started", "service_healthy", "service_completed_successfully"}
for n, s in doc["services"].items():
    dep = s.get("depends_on") or {}
    dep = {k: (v if isinstance(v, dict) else {}) for k, v in dep.items()} if isinstance(dep, dict) else {}
    for target, cfg in dep.items():
        c = cfg.get("condition", "service_started")
        if c not in legal: bad.append(f"{n}: depends_on.{target} 的 condition 非法：{c}")
        if target not in doc["services"]: bad.append(f"{n}: 依赖了不存在的服务 {target}")
if doc["services"].get("db-init", {}).get("restart") != "no":
    bad.append("db-init: 是一次性任务，restart 必须是 \"no\"（否则失败会被无限重试掩盖）")
if doc["services"].get("agent", {}).get("stop_grace_period") != "120s":
    bad.append("agent: stop_grace_period 必须 120s（对齐 systemd 的 TimeoutStopSec，默认 10s 会砍掉在途 SSE）")
# 2.3 文件系统上真的存在：build.context / volumes 源 / env_file
for n, s in doc["services"].items():
    b = s.get("build")
    if isinstance(b, dict):
        for k in ("context", "dockerfile"):
            p = os.path.join(b.get("context", "."), b.get(k, "")) if k == "dockerfile" else b.get(k, "")
            if not os.path.exists(p): bad.append(f"{n}.build.{k} 不存在：{p}")
    if not have_products: continue
    for f in (s.get("env_file") or []):
        p = f if isinstance(f, str) else (f.get("source") or f.get("path"))
        if not os.path.exists(p): bad.append(f"{n}.env_file 不存在：{p}（prepare.sh 没跑成功？）")
    for v in s.get("volumes", []):
        src = (v if isinstance(v, str) else v.get("source", "")).split(":")[0]
        if src.startswith((".", "/")):
            if not os.path.exists(src): bad.append(f"{n}.volumes 源不存在：{src}（prepare.sh 没建这个目录？）")
# 2.4 插值键：引用 .env 里没有、又没给缺省值的 ${X} ⇒ compose 会报错退出。
#     `:-` 是缺省值（`${AGENT_WORKERS:-4}` / `${NODE_HEAP:-3072}` 这类拨盘**故意**不在 .env 里：
#     写进去就会被当成"用户显式要的值"，而这几个的语义是"不设就用代码里的默认"）。
#     `:?` 是必填（缺了就报错退出）——那种仍然要出现在 .env 里。
for n, s in (doc["services"].items() if have_products else []):
    for m in re.finditer(r'\$\{([A-Z_][A-Z0-9_]*)(:?[-?][^}]*)?\}', yaml.safe_dump(s)):
        mod = m.group(2) or ""
        if m.group(1) not in env and not mod.startswith(("-", ":-")):
            bad.append(f"{n}: 引用了 {m.group(1)}，但 .env 里没有它（也没写 :- 缺省）")
for b in bad: print("  ✗ " + b)
if not bad: print("  ✅ 结构与网络语义对得上" + ("（含引用的文件与插值键）" if have_products else ""))
sys.exit(1 if bad else 0)
PY
[ $? = 0 ] || FAIL=$((FAIL + 1))

# ═══ ③ 渲染字节比对：docker 侧 == 裸机侧 ═══════════════════════════════════════
sec "③ nginx 配置：docker 侧与裸机侧逐字节一致"
# install.sh 的产物落在一个 mktemp 目录里（它自己打印路径，但这里直接按前缀找最新的一个），
# 把 TMPDIR 收到我们的 scratch 下 ⇒ 它建的那些临时物跟着一起被清掉，不留在 /tmp。
TMPDIR="$SCRATCH" APP_DIR=/srv bash "$REPO_DIR/deploy/install.sh" --dry-run -y \
    --domain check.example.com --cert selfsigned >"$SCRATCH/inst.out" 2>&1
inst_rc=$?
STAGE="$(ls -dt "$SCRATCH"/saudade-dryrun-* 2>/dev/null | head -1)"
if [ "$inst_rc" != 0 ] || [ -z "$STAGE" ]; then
    fail "install.sh --dry-run 没跑出产物（rc=$inst_rc）：$(tail -3 "$SCRATCH/inst.out" | tr '\n' ' ')"
elif diff -u "$STAGE/etc/nginx/sites-available/blog" "$SCRATCH/print.conf" >"$SCRATCH/conf.diff"; then
    pass "两侧产物逐字节一致（$(wc -l <"$SCRATCH/print.conf") 行）"
else
    fail "两侧产物有差异（说明 render.sh 之外还有第二份渲染实现）："
    head -30 "$SCRATCH/conf.diff" | sed 's/^/      /'
fi
# 反面：换了输入要变 —— 否则上面那条"一致"可能只是因为两边都渲染成了空文件
bash prepare.sh --print blog.conf --domain other.example.com >"$SCRATCH/print2.conf" 2>/dev/null
diff -q "$SCRATCH/print.conf" "$SCRATCH/print2.conf" >/dev/null \
    && fail "换了域名产物居然不变 ⇒ 上面那条判据没有分辨力" \
    || pass "换域名会变（判据有分辨力）"

# ═══ ④ 键集合不漂 ══════════════════════════════════════════════════════════════
sec "④ 键集合：prepare.sh 写的键都在既有名单里（且 IOT_ENABLED 不在 agent 那份）"
named() { grep -ohE "^#?[[:space:]]*$1=" "$2" | sed -E "s/^#?[[:space:]]*//; s/=$//" | sort -u; }
{
    named '[A-Z][A-Z0-9_]*' "$REPO_DIR/.env.example"
    named '[A-Z][A-Z0-9_]*' "$AGENT_DIR/.env.example"
    # install.sh 会写的键：三种写法的**键名都是最后一个字段**（put_env 比另两个多一个文件参数）
    grep -ohE '(add_env_if_missing|set_env|put_env)( "[^"]*" ){1,2}[A-Z0-9_]+' "$REPO_DIR/deploy/install.sh" | awk '{print $NF}'
    grep -rhoE 'env::var\("[A-Z0-9_]+"' "$REPO_DIR/src" | sed -E 's/.*"//'
} | sort -u >"$SCRATCH/whitelist.txt"

# prepare.sh 写进去的键（静态抽，不需要先跑一遍）
{ grep -ohE 'set_env "[^"]*" [A-Z0-9_]+' prepare.sh | awk '{print $3}'
  grep -ohE '"\$\{PROV_UPPER\}_[A-Z]+"' prepare.sh | sed 's/[^A-Z_]//g'; } | sort -u >"$SCRATCH/written.txt"
n_keys=$(wc -l <"$SCRATCH/written.txt")
bad_keys="$(comm -23 "$SCRATCH/written.txt" "$SCRATCH/whitelist.txt")"
if [ -z "$bad_keys" ]; then
    pass "prepare.sh 会写的 $n_keys 个键全部在名单里（两个 .env.example ∪ install.sh ∪ Rust env::var）"
else
    fail "prepare.sh 写了名单里没有的键（拼错了？）：$(echo "$bad_keys" | tr '\n' ' ')"
fi
# <PROVIDER>_API_KEY / _BASE_URL 这两个是拼出来的：逐个提供方都得真的存在
for prov in deepseek qwen openai; do
    for suffix in API_KEY BASE_URL; do
        grep -qE "^#?[[:space:]]*$(echo "$prov" | tr '[:lower:]' '[:upper:]')_$suffix=" "$AGENT_DIR/.env.example" \
            || fail "agent/.env.example 里没有 ${prov}_$suffix（prepare.sh 会按提供方拼出这个键）"
    done
done
pass "三个提供方的 <PROVIDER>_API_KEY / _BASE_URL 在 agent/.env.example 里都在"
# IOT_ENABLED：**空串**会让 agent 导入期崩（pydantic 对 bool 字段收空串 = ValidationError）
if grep -qE "^[[:space:]]*IOT_ENABLED=" "$AGENT_DIR/.env.example"; then
    fail "agent/.env.example 里还有未注释的空 IOT_ENABLED=（agent 会导入期崩，INSTALL 那套也会中招）"
else
    pass "agent/.env.example 的 IOT_ENABLED 是注释掉的（空串那一行没了）"
fi
grep -qE '^[[:space:]]*IOT_ENABLED=' "$AGENT_DIR/.env.example" \
    || pass "（同上，另一侧）"
# 生成物真在场时，顺手验一遍它们的权限与忽略规则
if [ -f generated/.credentials ]; then
    [ "$(stat -c %a generated/.credentials)" = 600 ] && pass "generated/.credentials 是 0600" \
        || fail "generated/.credentials 权限是 $(stat -c %a generated/.credentials)（应 600）"
    for f in .env generated/backend.env generated/agent.env generated/.credentials generated/ssl/selfsigned.key; do
        git check-ignore -q "$f" && pass "$f 被 .gitignore 挡住" || fail "$f **没有**被忽略（秘密会进 git）"
    done
    jb="$(grep -hE '^JWT_SECRET=' generated/backend.env)"; ja="$(grep -hE '^JWT_SECRET=' generated/agent.env)"
    [ -n "$jb" ] && [ "$jb" = "$ja" ] && pass "两份 .env 的 JWT_SECRET 逐字相同（不同的话登录态会互不认账）" \
        || fail "两份 .env 的 JWT_SECRET 不一致：backend=[${jb:+有}] agent=[${ja:+有}]"
else
    skip "还没有 generated/（没跑过 prepare.sh）—— 权限与忽略规则那两条本次跳过"
fi

# ═══ ⑤ 镜像里那几条"不写就静默出错"的指令 ═════════════════════════════════════
sec "⑤ Dockerfile 承重指令"
assert_has Dockerfile.frontend 'npm ci' "前端先 npm ci"
assert_has Dockerfile.frontend 'npm run fetch:widget' "前端跑 fetch:widget"
assert_has Dockerfile.frontend 'npm run vendor:live2d' "前端跑 vendor:live2d"
assert_has Dockerfile.frontend 'test -f dist/live2d-widgets/chat-stream.js' "产物断言：看板娘脚本在 dist 里"
assert_has Dockerfile.frontend 'test -f dist/live2d_model/agent_2.model3.json' "产物断言：模型清单在 dist 里"
assert_has Dockerfile.frontend 'rm -f /etc/nginx/conf.d/default.conf' "删掉官方镜像的 default.conf（它的 80 default_server 会撞车）"
assert_has Dockerfile.frontend 'tzdata' "前端运行镜像装 tzdata（alpine 里 TZ 否则是空操作）"
assert_has Dockerfile.frontend 'command -v git|git ca-certificates|git \\' "前端构建阶段装 git（fetch:widget 要稀疏检出）"
# 顺序承重：fetch:widget 必须在 vendor:live2d 之前（反过来刚取的 vendor/ 会被整树替换抹掉）
l_fetch="$(grep -n 'npm run fetch:widget' Dockerfile.frontend | cut -d: -f1 | head -1)"
l_vendor="$(grep -n 'npm run vendor:live2d' Dockerfile.frontend | cut -d: -f1 | head -1)"
[ -n "$l_fetch" ] && [ -n "$l_vendor" ] && [ "$l_fetch" -lt "$l_vendor" ] \
    && pass "三条命令顺序：fetch:widget（L$l_fetch）→ vendor:live2d（L$l_vendor）" \
    || fail "fetch:widget / vendor:live2d 顺序不对（L${l_fetch:-无} / L${l_vendor:-无}）"
assert_has Dockerfile.backend 'mkdir -p /srv/logs/frontend' "后端镜像预建监控日志目录（打不开也返回 200 ⇒ 只能靠预建）"
[ "$(grep -c 'cargo build --release --locked' Dockerfile.backend)" = 2 ] && pass "后端两次 --locked（桩层缓存 + 真源码）" \
    || fail "后端 cargo build 不是两次 --locked"
# ⚠️ 桩层缓存有一处"删掉就静默"的前提（20261007 用户那台机器实测）：cargo 按 **mtime**
# 判目标新不新，而 BuildKit 的 COPY **保留 clone 时的旧 mtime** ⇒ 真源码反比刚编出来的桩
# 产物更旧 ⇒ cargo 报 `Finished` 一个字节都不编，`cp` 复制的还是 `fn main() {}`。
# 症状：镜像构建全绿、容器退出码 0、无限 Restarting，二进制里没有一句启动日志。
assert_has Dockerfile.backend 'find src -type f -exec touch' "真源码 COPY 进来后刷新 mtime（不刷新 ⇒ cargo 拿空桩当已最新）"
l_copy="$(grep -n '^COPY src \./src' Dockerfile.backend | cut -d: -f1 | head -1)"
l_touch="$(grep -n 'find src -type f -exec touch' Dockerfile.backend | cut -d: -f1 | head -1)"
l_build="$(grep -n 'cargo build --release --locked' Dockerfile.backend | tail -1 | cut -d: -f1)"
[ -n "$l_copy" ] && [ -n "$l_touch" ] && [ -n "$l_build" ] \
    && [ "$l_copy" -lt "$l_touch" ] && [ "$l_touch" -lt "$l_build" ] \
    && pass "顺序承重：COPY src（L$l_copy）→ touch（L$l_touch）→ 真构建（L$l_build）" \
    || fail "COPY src / touch / 真构建 的顺序不对（L${l_copy:-无} / L${l_touch:-无} / L${l_build:-无}）"
# 光有 touch 还不够：它哪天被删掉时，构建必须**响亮地失败**而不是静静出个空桩。
assert_has Dockerfile.backend "grep -aq 'DATABASE_URL'" "构建期断言：产物里必须有 DATABASE_URL（空桩没有）"
assert_has Dockerfile.backend 'stat -c %s target/release/saudade_blog_bin' "构建期断言：体积下限（真二进制 18.3 MiB，空桩差一个数量级）"
# 只看**指令行**：这两个 Dockerfile 都有一段注释专门解释"为什么这里不许出现 X"，
# 直接 grep 全文会被自己的注释判红（假红比漏判更坏——它会训练人忽略这条判据）。
grep -v '^[[:space:]]*#' Dockerfile.backend | grep -q 'cargo test' \
    && fail "Dockerfile.backend 里跑了 cargo test：那会让 release 构建依赖看板娘那棵被 .dockerignore 排掉的树" \
    || pass "后端构建**没有** cargo test（include_str! 那个测试是 #[cfg(test)] 专属）"
assert_has Dockerfile.agent 'uv sync --frozen --no-dev' "agent 用 --frozen --no-dev"
assert_has Dockerfile.agent 'tzdata' "agent 镜像装 tzdata（否则 TRACE_DIR 的按天目录会差一天）"
assert_has Dockerfile.agent 'uv==0.11.28' "agent 的 uv 版本钉死（与产线同一版）"
assert_has agent-entrypoint.sh 'SSL_CERT_FILE' "入口脚本 export SSL_CERT_FILE"
assert_has agent-entrypoint.sh 'cat "\$CERTIFI" "\$SITE_CRT"' "CA bundle 是**拼接**（certifi + 站点证书），不是替换"
assert_has agent-entrypoint.sh 'exec "\$VENV/bin/uvicorn"' "uvicorn 用 exec 起（否则 SIGTERM 到不了它）"
# 判的是"有没有代码/配置真的指到那个目录"，不是"文里提没提这个词"——注释与 README 专门
# 解释这件事（那正是最该留着的地方）。所以只看指令行，且排除本文件与 README。
if grep -rn 'sites-enabled' --exclude=check.sh --exclude=README.md --exclude='*.md' \
        compose.yaml Dockerfile.* ./*.sh 2>/dev/null | grep -v ':[0-9]*:[[:space:]]*#' | grep -q .; then
    fail "有文件真的指向 sites-enabled（官方 nginx 镜像里没有这个目录，站点会静默 404）"
else
    pass "没有任何**指令**指向 sites-enabled（只出现在解释性注释里）"
fi

# ── ⑤.1「那条 touch 是承重的」的**可执行复刻**（有 cargo 才跑，没有就跳过）──────────
# 上面那条 grep 只证明"这行字还在"。这一条判的是**机制本身**：造一个同形状的小 crate
# （lib+bin、零依赖、离线），照 Dockerfile 的次序走一遍 —— 桩构建 → 把**带旧 mtime** 的
# 真源码放进去（模拟 BuildKit 保留 clone 那一刻的 mtime）→ touch → 重建 ⇒ 产物必须是真的。
# 「不 touch 会怎样」只当**信息**打出来、**不作断言**：判据的前提不能长在 cargo 的实现
# 细节上（哪天它改成按内容判新鲜度，那句话自理过期，但不该因此判红）。
if command -v cargo >/dev/null 2>&1; then
    D="$SCRATCH/mtime-probe"; mkdir -p "$D/src" "$D/real"
    cat >"$D/Cargo.toml" <<'TOML'
[package]
name = "probe"
version = "0.1.0"
edition = "2021"

[lib]
name = "probe"
path = "src/lib.rs"

[[bin]]
name = "probe_bin"
path = "src/main.rs"
TOML
    probe_run() {   # probe_run <touch|notouch>：照 Dockerfile 的次序跑一遍；产物是真的则返回 0
        rm -rf "$D/target"
        printf '\n' >"$D/src/lib.rs"
        printf 'fn main() {}\n' >"$D/src/main.rs"
        (cd "$D" && cargo build --release --offline >/dev/null 2>&1) || return 1
        printf 'pub fn hi() -> u32 { 42 }\n' >"$D/real/lib.rs"
        printf 'fn main() { println!("Server starting"); let _ = std::env::var("DATABASE_URL"); println!("{}", probe::hi()); }\n' >"$D/real/main.rs"
        touch -d '2020-01-01 00:00:00' "$D/real/lib.rs" "$D/real/main.rs"
        cp -p "$D/real/lib.rs" "$D/real/main.rs" "$D/src/"
        [ "$1" = touch ] && find "$D/src" -type f -exec touch {} +
        (cd "$D" && cargo build --release --offline >/dev/null 2>&1) || return 1
        grep -aq 'DATABASE_URL' "$D/target/release/probe_bin"
    }
    if probe_run touch; then
        pass "复刻：真源码带旧 mtime 进来、touch 之后重建 ⇒ 产物是真二进制（不是空桩）"
    else
        fail "复刻：touch 之后产物仍不是真二进制 —— Dockerfile 里那条救不回来了"
    fi
    if probe_run notouch; then
        printf '  ℹ 对照组：这次不 touch 也编出了真二进制（touch 现在冗余但无害，仍要留着）\n'
    else
        printf '  ℹ 对照组：不 touch ⇒ 产物仍是空桩（用户那台机器上发生的正是这件事）\n'
    fi
else
    skip "没装 cargo ⇒ 跳过「那条 touch 是承重的」的可执行复刻"
fi

# ═══ ⑥ 这些键 agent 那边真的读吗 ════════════════════════════════════════════════
sec "⑥ prepare.sh 写进 agent.env 的键，agent 真的读得到"
# 判据是"这个名字在 agent 仓里确实被读"——两条通道都认：
#   ① pydantic 的 Settings 字段（.env 走的通道，settings.py 里是小写下划线名 ⇒ 大写化后比）
#   ② 代码里的 os.environ（那四个只读进程环境旋钮走这条，**写 .env 是无效的**）
# 这样既能抓"键名拼错"（AGENT_ADMIN_BASE 写成 AGENT_ADMIN_URL 之类），又不会因为
# "这个键本来就不走 .env"而假红。**不用 import**：agent 的 config/settings.py 在模块级
# 就 `settings = Settings()`，一 import 它会去读本机生产那份 `.env` —— 静态读源码更干净。
python3 - <<'PY'
import re, pathlib, subprocess, sys
agent = pathlib.Path("../../saudade-blog-agent")
if not (agent / "config" / "settings.py").exists():
    print("  ↷ agent 仓不在旁边（或没克隆全），跳过"); sys.exit(0)
src = (agent / "config" / "settings.py").read_text()
fields = {m.group(1).upper() for m in re.finditer(r'^\s+([a-z_][a-z0-9_]*)\s*[:=]', src, re.M)}
envread = set()
for p in agent.rglob("*.py"):
    if ".venv" in p.parts: continue
    t = p.read_text(errors="ignore")
    envread |= set(re.findall(r'os\.environ(?:\.get|\[)\s*\(?\s*["\']([A-Z0-9_]+)["\']', t))
    envread |= set(re.findall(r'os\.getenv\(\s*["\']([A-Z0-9_]+)["\']', t))
prep = pathlib.Path("prepare.sh").read_text()
keys = sorted(set(re.findall(r'set_env "\$GEN_DIR/agent\.env" ([A-Z0-9_]+)', prep)))
bad = [k for k in keys if k not in fields and k not in envread]
print(f"  ✅ 检查了 {len(keys)} 个键（Settings 字段 {len(fields)} 个 / os.environ 读到 {len(envread)} 个）")
for k in bad:
    print(f"  ✗ {k}：agent 仓里既不是 Settings 字段、也没人用 os.environ 读它 ⇒ 写了也不生效")
if not bad:
    print("  ✅ 每一个都能对上（要么是配置字段、要么是进程环境旋钮）")
knobs = ["AGENT_RECURSION_LIMIT", "AGENT_MAX_BODY_BYTES", "AGENT_MAX_CONCURRENT", "AGENT_MAX_REVIEW"]
miss = [k for k in knobs if k not in envread]
if miss:
    print(f"  ✗ 这四个应当是 os.environ 读的，但没读到 {miss} —— compose 里那条注释就错了")
else:
    print("  ✅ 四个只读进程环境旋钮确实是 os.environ 读的（写进 agent.env 无效，compose 注释成立）")
sys.exit(1 if bad or miss else 0)
PY
[ $? = 0 ] || FAIL=$((FAIL + 1))

# ═══ ⑦ db-init.sh 的控制流（用桩 mysql，不连真库）══════════════════════════════
sec "⑦ db-init.sh 五种场景"
cat >"$SCRATCH/mysql" <<'STUB'
#!/usr/bin/env bash
# 假 mysql：只录不连。答案由 STUB_* 决定；前 ${STUB_EMPTY_QUERIES} 次问"表数"答"还空着"。
LOG="${STUB_LOG:?}"; CNT="$LOG.cnt"
printf 'ARGV: %s\n' "$*" >>"$LOG"
has_e=0; for a in "$@"; do [ "$a" = "-e" ] && has_e=1; done
SQL=""; [ "$has_e" = 1 ] || SQL="$(cat)"
[ -n "$SQL" ] && printf 'STDIN: %s\n' "$(printf '%s' "$SQL" | tr '\n' ' ')" >>"$LOG"
case "$*$SQL" in
  *"SELECT 1"*) exit 0 ;;
  *information_schema.TABLES*)
      n=$(cat "$CNT" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" >"$CNT"
      if [ "$n" -le "${STUB_EMPTY_QUERIES:-2}" ]; then echo "${STUB_TABLES_BEFORE:-0}"; else echo "${STUB_TABLES_AFTER:-26}"; fi ;;
  *"role='admin'"*) case "$*$SQL" in *COUNT*) echo "${STUB_ADMINS:-0}" ;; *) echo admin ;; esac ;;
  *"WHERE username="*) echo "${STUB_DUPE:-}" ;;
  *migration_flags*) echo "${STUB_FLAGS:-}" ;;
esac
exit 0
STUB
chmod +x "$SCRATCH/mysql"

run_init() {   # run_init <BEFORE> <AFTER> <ADMINS> <日志名>（STUB_DUPE / STUB_FLAGS 由调用处给）
    local log="$SCRATCH/calls.$4.log"; rm -f "$log" "$log.cnt"
    env -i PATH="$SCRATCH:/usr/bin:/bin" HOME="$SCRATCH" STUB_LOG="$log" \
        STUB_TABLES_BEFORE="$1" STUB_TABLES_AFTER="$2" STUB_ADMINS="$3" \
        STUB_DUPE="${STUB_DUPE:-}" STUB_FLAGS="${STUB_FLAGS:-}" \
        DB_NAME=saudade_blog DB_USER=saudade_blog DB_PASS=stub-app-pass \
        MYSQL_ROOT_PASSWORD=stub-root-pass ADMIN_USER=admin ADMIN_NICK=站长 ADMIN_PASS=stub-admin-pass \
        MYSQL_HOST=mysql MIG_DIR="$REPO_DIR/scripts/migration" \
        bash ./db-init.sh >"$SCRATCH/$4.out" 2>&1 </dev/null
}
# 场景 A：空库 → 应当建库、建应用账号、建第一个管理员
run_init 0 26 0 A
rcA=$?; logA="$SCRATCH/calls.A.log"
[ "$rcA" = 0 ] && pass "空库：退出码 0" || fail "空库：退出码 $rcA（$(tail -2 "$SCRATCH/A.out" | tr '\n' ' ')）"
grep -qa 'CREATE DATABASE' "$logA" && pass "空库：真的建库了" || fail "空库：没建库"
grep -qa "CREATE USER IF NOT EXISTS 'saudade_blog'@'%'" "$logA" \
    && pass "空库：应用账号建在 **'%'** 上（host 网络下客户端不是 localhost，@'localhost' 会 Access denied）" \
    || fail "空库：应用账号的 host 不对（应为 '%'）"
grep -qa "INSERT INTO \`user\`" "$logA" && pass "空库：建了第一个管理员" || fail "空库：没建管理员"
# 场景 B：库里已经有表 → 不许碰数据；顺带把迁移台账摆出来（有标记那一路）
STUB_FLAGS=$'chat_conv_20260903\ntz_cn_20260827' run_init 26 26 0 B; logB="$SCRATCH/calls.B.log"
grep -qaE 'CREATE DATABASE|0000_base_schema' "$logB" \
    && fail "已有表：居然还在建库/跑迁移" || pass "已有表：整段跳过建库（绝不 DROP）"
grep -qa 'ALTER USER' "$logB" && pass "已有表：应用账号仍然对齐到 .credentials 里的口令" \
    || fail "已有表：没 ALTER 应用账号"
grep -qa '迁移标记 2 个' "$SCRATCH/B.out" \
    && pass "已有表：把 migration_flags 摆出来了（几个标记、最近一条）" \
    || fail "已有表：没说迁移台账 —— 接手者看不出这个库是谁建的"
# 场景 C：已有管理员 → 不许改他的口令
run_init 26 26 2 C; logC="$SCRATCH/calls.C.log"
grep -qa "INSERT INTO \`user\`" "$logC" && fail "已有管理员：居然又建了一个" \
    || pass "已有管理员：只报数不建人（改口令必须显式 UPDATE，见 README）"
# 场景 D：建库"成功"但库里零表 → 必须中止，不许往下走
run_init 0 0 0 D
[ $? != 0 ] && pass "建库假成功（零表）：中止了（退出码非 0）" || fail "建库假成功居然放行 —— 后面的服务会连上一个空库"
grep -qa '一张表都没有' "$SCRATCH/D.out" && pass "建库假成功：给出了能读懂的原因" || fail "建库假成功：没有说清原因"
# 场景 E：库里已有一个**同名但不是 admin** 的账号 → 必须先拦住，不许去撞 Duplicate entry
STUB_DUPE='7 alice user' run_init 26 26 0 E
[ $? != 0 ] && pass "同名非管理员账号：中止了" || fail "同名非管理员账号：放行去 INSERT 了（会是一句看不懂的 Duplicate entry）"
grep -qa "INSERT INTO \`user\`" "$SCRATCH/calls.E.log" \
    && fail "同名非管理员账号：居然还是发出了那条 INSERT" || pass "同名非管理员账号：没有发出 INSERT"
grep -qa '同名账号' "$SCRATCH/E.out" \
    && pass "同名非管理员账号：给了能读懂的原因与两条出路" || fail "同名非管理员账号：没解释原因"

# 读一个 .env 里的键（未注释那一行；重复出现取最后一行 —— 与两个解析器一致）
env_val() { grep -E "^[[:space:]]*$2=" "$1" | tail -1 | cut -d= -f2-; }

setup_env_section() {
    cp ../../.env.example "$E8/app/.env.example"
    cp "$AGENT_DIR/.env.example" "$E8/app/saudade-blog-agent/.env.example"
    local BE8="$E8/app/.env" AE8="$E8/app/saudade-blog-agent/.env"
    local PW='p@ss:w/rd?%1'      # 全是"能把连接串切开"的字符：@ 冒号 斜杠 问号 百分号
    local out rc bad jb ja durl dec

    # 跑一遍 setup_env（每次都在 E8 里跑，所以第二轮起 .env 已经存在 = keep 语义）
    # ⚠️ 路径走**环境变量**、且不给内层 bash 任何位置参数：source 进来的脚本看见的是
    #    **调用方**的 "$@"，多给一个参数就会被它顶层的参数循环当成"不认识的参数"而退出。
    run_setup_env() {   # run_setup_env <JWT_SECRET> [额外的 KEY=VAL…]
        env -i PATH=/usr/bin:/bin HOME="$E8" E8DIR="$E8" \
            APP_DIR="$E8/app" DRY_RUN=0 IOT_ONLY=0 WITH_IOT=0 \
            DB_USER=saudade_blog DB_PASS="$PW" JWT_SECRET="$1" \
            SITE_URL=https://check.example.com UPLOAD_DIR="$E8/data/uploads" \
            LLM_PROVIDER=deepseek LLM_API_KEY=sk-check "${@:2}" \
            bash -c 'source "$E8DIR/deploy/install.sh"; setup_env' 2>&1
    }

    # ── 第一轮：两份 .env 都还不存在 = fresh ─────────────────────────────────
    out="$(run_setup_env jwt-AAA)"; rc=$?
    [ "$rc" = 0 ] && pass "fresh：setup_env 退出码 0" \
        || fail "fresh：setup_env 退出码 $rc（$(printf '%s' "$out" | tail -2 | tr '\n' ' ')）"
    if [ ! -s "$BE8" ] || [ ! -s "$AE8" ]; then
        fail "fresh：两份 .env 没建出来 —— 本节后面几条判不了"
        return 0
    fi
    # ① 模板占位必须被顶掉（这条就是 20261007 之前那个 bug 的判据）
    bad="$(grep -hvE '^[[:space:]]*#' "$BE8" "$AE8" \
           | grep -E '改成你的密码|请换成一串随机字符|<你的域名>|your-api-key-here|^[A-Z_]+=https?://example\.com')"
    if [ -n "$bad" ]; then
        fail "fresh：.env 里还留着模板占位：$(printf '%s' "$bad" | head -3 | tr '\n' ' ')"
    else
        pass "fresh：两份 .env 里没有任何未被注释的模板占位值"
    fi
    # ② JWT_SECRET：两份逐字相同，且是安装器这次写的值
    jb="$(env_val "$BE8" JWT_SECRET)"; ja="$(env_val "$AE8" JWT_SECRET)"
    if [ "$jb" = jwt-AAA ] && [ "$ja" = jwt-AAA ]; then
        pass "fresh：两份 JWT_SECRET 逐字相同，且是这次生成的值"
    else
        fail "fresh：JWT_SECRET 不对（backend=[$jb] agent=[$ja]）"
    fi
    # ③ 站点相关的三处都指向本次部署，而不是模板里的中性占位
    [ "$(env_val "$BE8" SITE_URL)" = https://check.example.com ] \
        && pass "fresh：SITE_URL = 本次给的地址" \
        || fail "fresh：SITE_URL = $(env_val "$BE8" SITE_URL)（模板占位没被顶掉）"
    [ "$(env_val "$AE8" BLOG_API_BASE)" = https://check.example.com/api/public ] \
        && pass "fresh：agent 的 BLOG_API_BASE 指向本次站点（模板里是 <你的域名>）" \
        || fail "fresh：BLOG_API_BASE = $(env_val "$AE8" BLOG_API_BASE)"
    [ "$(env_val "$AE8" TRACE_DIR)" = "$E8/app/logs/agent/traces" ] \
        && pass "fresh：TRACE_DIR 落在本次部署根下（不是上游那台机器的路径）" \
        || fail "fresh：TRACE_DIR = $(env_val "$AE8" TRACE_DIR)"
    [ "$(env_val "$AE8" DEEPSEEK_API_KEY)" = sk-check ] \
        && pass "fresh：模型 key 写进**当前提供方自己的**键（DEEPSEEK_API_KEY）" \
        || fail "fresh：DEEPSEEK_API_KEY = $(env_val "$AE8" DEEPSEEK_API_KEY)"
    # ④ DATABASE_URL：口令按 RFC3986 编码后进 userinfo，且编码可逆（#7 的判据）
    durl="$(env_val "$BE8" DATABASE_URL)"
    printf '%s' "$durl" | grep -qF -- "$PW" \
        && fail "fresh：DATABASE_URL 里是**原文**口令（@ : / ? 会把连接串切到别的意思上）" \
        || pass "fresh：DATABASE_URL 里没有原文口令"
    dec="$(printf '%s' "$durl" | python3 -c 'import sys,urllib.parse as u
s=sys.stdin.read().strip(); ui=s.split("://",1)[1].split("@",1)[0]
print(u.unquote(ui.split(":",1)[1]))' 2>/dev/null)"
    [ "$dec" = "$PW" ] && pass "fresh：DATABASE_URL 的口令解回来逐字节等于原文" \
        || fail "fresh：DATABASE_URL 的口令解不回来：[$dec] ≠ [$PW]"

    # ── 第二轮：两份 .env 手写好 = keep（只补缺键，一个都不许改）────────────
    cat >"$BE8" <<'EOF'
DATABASE_URL=mysql://saudade_blog:mine-own@127.0.0.1:3306/saudade_blog
JWT_SECRET=my-own-secret
SITE_URL=https://mine.example.com
EOF
    cat >"$AE8" <<'EOF'
JWT_SECRET=my-own-secret
BLOG_API_BASE=https://mine.example.com/api/public
EOF
    out="$(run_setup_env jwt-CCC)"; rc=$?
    [ "$rc" = 0 ] && pass "keep：setup_env 退出码 0" \
        || fail "keep：setup_env 退出码 $rc（$(printf '%s' "$out" | tail -2 | tr '\n' ' ')）"
    if [ "$(env_val "$BE8" JWT_SECRET)" = my-own-secret ] \
       && [ "$(env_val "$BE8" SITE_URL)" = https://mine.example.com ] \
       && [ "$(env_val "$AE8" BLOG_API_BASE)" = https://mine.example.com/api/public ]; then
        pass "keep：已有的值一个都没被改（JWT_SECRET / SITE_URL / BLOG_API_BASE）"
    else
        fail "keep：已有值被改了（JWT=[$(env_val "$BE8" JWT_SECRET)] SITE=[$(env_val "$BE8" SITE_URL)]）"
    fi
    [ "$(env_val "$BE8" DATABASE_URL)" = 'mysql://saudade_blog:mine-own@127.0.0.1:3306/saudade_blog' ] \
        && pass "keep：DATABASE_URL 也没被重写（否则等于把一台跑着的机器锁在门外）" \
        || fail "keep：DATABASE_URL 被动过：$(env_val "$BE8" DATABASE_URL)"
    [ "$(env_val "$BE8" AGENT_URL)" = http://127.0.0.1:8010/chat ] \
        && pass "keep：缺的键照样补上（AGENT_URL）" \
        || fail "keep：缺的键没补上（AGENT_URL=[$(env_val "$BE8" AGENT_URL)]）"

    # ── 第三轮：显式给了 base-url ⇒ 顶掉，且落在**当前提供方**的键上（#5 的判据）──
    out="$(run_setup_env jwt-DDD LLM_BASE_URL=https://gw.example.net/v1)"; rc=$?
    [ "$(env_val "$AE8" DEEPSEEK_BASE_URL)" = https://gw.example.net/v1 ] \
        && pass "给了 base-url：写进 DEEPSEEK_BASE_URL（当前提供方自己的键）" \
        || fail "给了 base-url：DEEPSEEK_BASE_URL = $(env_val "$AE8" DEEPSEEK_BASE_URL)"
    [ -z "$(env_val "$AE8" QWEN_BASE_URL)" ] \
        && pass "给了 base-url：一个字节都没写进 QWEN_BASE_URL（修好的就是这条）" \
        || fail "给了 base-url：居然写进了 QWEN_BASE_URL（没人读它，症状是「改了地址还打旧端点」）"

    # ── 两份 urlenc 实现必须逐字同源（一份在裸机路上，一份在 docker 路上）──────
    run_urlenc() {   # run_urlenc <脚本文件> <口令>
        { sed -n '/^urlenc() {/,/^}/p' "$1"; printf 'urlenc "$1"\n'; } >"$SCRATCH/u.sh"
        bash "$SCRATCH/u.sh" "$2"
    }
    local nasty n=0 same=1 i p
    for nasty in 'p@ss:w/rd?%1' 'a b' '中文&口令' 'a#b$c' 'plainhex'; do
        i="$(run_urlenc ../../deploy/install.sh "$nasty")"
        p="$(run_urlenc prepare.sh "$nasty")"
        n=$((n + 1))
        if [ "$i" != "$p" ]; then
            same=0
            fail "两份 urlenc 对「$nasty」输出不同：install.sh=[$i] prepare.sh=[$p]"
        fi
    done
    [ "$same" = 1 ] \
        && pass "两份 urlenc 对同一批 $n 条口令输出逐字相同（含 @ : / ? % 空格 中文 # \$）"
}

# ═══ ⑧ install.sh 的 setup_env：全新 .env 不留占位 / 已有的一个键都不动 ═══════════
sec "⑧ install.sh 的 setup_env（裸机安装路）"
# 这一节判的是 20261007 修掉的那条 bug 本身：`.env.example` 里那些**未注释的中文占位**
# （`DATABASE_URL=…改成你的密码…` / `JWT_SECRET=请换成一串随机字符` / `SITE_URL=https://example.com`）
# 曾经被"只补缺键"的语义挡在门外 ⇒ 安装器生成的真值一个都没落盘，而后端连不上库、
# agent 指着一个不存在的域名，**安装脚本还全绿**。
# 做法：把 install.sh 复制进 scratch、摘掉末尾那句 `main "$@"`，再 source 进来直接跑
# `setup_env`（顶层的参数循环没有参数时一次都不转 ⇒ source 进来只会定义函数，不装任何东西）。
E8="$SCRATCH/e8"; rm -rf "$E8"; mkdir -p "$E8/deploy/nginx" "$E8/app/saudade-blog-agent"
cp ../../deploy/install.sh      "$E8/deploy/install.sh"
cp ../../deploy/nginx/render.sh "$E8/deploy/nginx/render.sh"
sed -i '/^main "\$@"$/d' "$E8/deploy/install.sh"
if grep -q '^main "\$@"$' "$E8/deploy/install.sh"; then
    # 摘不掉就**绝对不能**往下走：那会真的跑一遍装机（preflight 会去动系统）
    fail "⑧ 没能摘掉 install.sh 末尾的 main ⇒ 本节跳过（判据本身不可信）"
elif [ ! -f "$AGENT_DIR/.env.example" ]; then
    skip "⑧ agent 仓不在旁边（没有 .env.example）⇒ 跳过（setup_env 没有它就跑不起来）"
else
    setup_env_section
fi

# ═══ 总账 ══════════════════════════════════════════════════════════════════════
printf '\n════════════════════════════════════════════════════\n'
if [ "$FAIL" = 0 ]; then
    printf '✅ 全部通过。\n'
    printf '   下一步（在装了 docker 的机器上）：\n'
    printf '     bash prepare.sh && docker compose build && docker compose up -d\n'
    printf '   然后按 README 的《验收清单》逐条 curl —— 那 11 条这里一条都判不了。\n'
else
    printf '❌ %d 条不通过（上面每一条都写了原因）。\n' "$FAIL"
fi
exit "$FAIL"

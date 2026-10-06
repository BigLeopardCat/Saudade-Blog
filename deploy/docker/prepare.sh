#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  Docker 安装路：宿主侧的一次性准备（**不需要 docker 就能跑**，这正是它可离线自检的原因）
#
#  它做四件事，产物只落在两处 —— `deploy/docker/generated/` 与 `$SAUDADE_DATA_DIR`：
#    ① 渲染 nginx 站点配置（复用 deploy/nginx/render.sh，与裸机 install.sh **同一份实现**）
#    ② 自签一张**带 SAN** 的证书（或装入你已有的证书）
#    ③ 写三份配置：compose 用 `.env`、后端 `generated/backend.env`、agent `generated/agent.env`
#       ＋ `generated/.credentials`（0600，同时当 db-init 的 env_file 用）
#    ④ 建宿主数据目录（uploads / logs / traces / agent-data）
#
#  **它绝不碰**：仓库根 `.env`、`deploy/.credentials`、`deploy/nginx/*` —— 那三样是裸机那套的。
#  判据在 check.sh 里（跑完 `git status` 必须干净）。
#
#  用法：
#    bash prepare.sh                          # 交互向导
#    bash prepare.sh --domain blog.example.com --provider deepseek --api-key sk-xxx
#    bash prepare.sh --dry-run                # 只打印要做什么，一个字都不写
#    bash prepare.sh --print blog.conf        # 只把渲染结果打到 stdout（check.sh 做字节比对用）
#
#  幂等：再跑一次**不会**换口令/密钥，只会按新输入重渲染 conf 与两份 .env。三条口令各有各的
#  改法（README 的《改口令》一节）：应用账号跟着 .credentials 收敛、root 与管理员口令不会。
#  ⚠️ 输入校验比 install.sh 更严（多禁 `$`/反引号/反斜杠）：这些值还要穿过 compose 的 .env
#     插值与 env_file 解析，那两个解析器对 `$` 的处理与本仓的 dotenvy 不是一套。
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── 路径基准 ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
AGENT_DIR="$REPO_DIR/saudade-blog-agent"     # 名字/位置不许改（Dockerfile.agent 的 COPY 与它对齐）
GEN_DIR="$SCRIPT_DIR/generated"
COMPOSE_ENV="$SCRIPT_DIR/.env"               # compose 自己读的那份（插值用）
CRED_FILE="$GEN_DIR/.credentials"            # 0600；db-init 拿它当 env_file
RENDER_LIB="$REPO_DIR/deploy/nginx/render.sh"

# 产物里全是口令与密钥 ⇒ 默认 600/700，别指望每条路径都记得 chmod
umask 077

# ── 参数（同名的大写环境变量可预填，与 install.sh 同一套习惯）──────────────────
DOMAIN="${DOMAIN:-}"                  # 裸域名，不带协议；**必填**（要它来签 SAN 与 server_name）
SITE_URL="${SITE_URL:-}"              # 空 = 由 DOMAIN 推成 https://$DOMAIN
SITE_TITLE="${SITE_TITLE:-}"          # 空 = 前端的中性占位（"个人博客"）
SITE_DESCRIPTION="${SITE_DESCRIPTION:-}"
SITE_AUTHOR="${SITE_AUTHOR:-}"        # 空 = 页面上没有署名
SITE_KEYWORDS="${SITE_KEYWORDS:-}"
DATA_DIR="${SAUDADE_DATA_DIR:-$HOME/saudade-docker-data}"
DB_NAME="${DB_NAME:-saudade_blog}"    # 别改：迁移文件里写死了这个名字（fresh_install.sh 会据此放行）
DB_USER="${DB_USER:-saudade_blog}"
DB_PASS="${DB_PASS:-}"                # 空 = 随机生成（已有 .credentials 时优先复用它）
MYSQL_ROOT_PASS="${MYSQL_ROOT_PASS:-}"    # 空 = 随机生成，**只存在 .credentials 里**
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_NICK="${ADMIN_NICK:-站长}"
ADMIN_PASS="${ADMIN_PASS:-}"          # 空 = 随机生成；已建过管理员时以库里的为准
JWT_SECRET="${JWT_SECRET:-}"          # 空 = 随机生成；**两份 .env 必须逐字相同**，由本脚本保证
LLM_PROVIDER="${LLM_PROVIDER:-deepseek}"
LLM_API_KEY="${LLM_API_KEY:-}"
LLM_BASE_URL="${LLM_BASE_URL:-}"      # 只有 qwen 这类"默认端点绑在维护者账号上"的才必须给
CERT_NAME="${CERT_NAME:-}"            # 给了 --cert-file 才有意义；空 = 自签，甲块乙块共用一张
CERT_CRT="${CERT_CRT:-}"
CERT_KEY="${CERT_KEY:-}"
TZ_VAL="${TZ_VAL:-Asia/Shanghai}"

ASSUME_YES=0; DRY_RUN=0; PRINT_WHAT=""
HAVE_TTY=0; [ -t 0 ] && [ -t 1 ] && HAVE_TTY=1

# ── 日志与输入 ────────────────────────────────────────────────────────────────
# 与 install.sh 是同一套口吻与同一批函数名，但**刻意不共享实现**：那一边的函数住在
# install.sh 顶层，source 进去会连着它的参数循环与 `main "$@"` 一起跑（见 install.sh 里
# 那段注释）。就这几个 printf，抄一份比抽一个共享库的收益大 —— 抽出去反而要动正在跑生产
# 的那条安装路。**唯一的例外是 render_nginx**：它里面那段按结构标记切块的 awk 必须只有一份。
STEP_N=0   # set -u 下必须先落地再自增（step 的第一步就是读它）
step() { STEP_N=$((STEP_N + 1)); printf '\n── %d. %s ──\n' "$STEP_N" "$*" >&2; }
say()  { printf '   %s\n' "$*" >&2; }
ok()   { printf '   ✅ %s\n' "$*" >&2; }
warn() { printf '   ⚠️  %s\n' "$*" >&2; }
note() { printf '      · %s\n' "$*" >&2; }
die()  { printf '\n❌ %s\n' "$*" >&2; exit 1; }

rand_hex() { openssl rand -hex "${1:-32}"; }
rand_pw()  { openssl rand -hex "${1:-16}"; }

# 连接串里的 userinfo 必须转义（20261007）。生成的口令是纯 hex、碰不到，但 `DB_PASS` 可以是
# 任何人手给的东西（--db-pass / .credentials），而 `mysql://账号:口令@主机/库` 这个形状里
# 口令中的 `@ : / ? # %` 每一个都能把连接串切到别的意思上 —— 症状是后端连不上库，或者更坏：
# 静默连到一个"看起来对"的库。上面的 check_env_value 放行这几个字符（它们在 .env 的值里是
# 合法内容），所以**必须在这里转义**。按 RFC 3986 的 unreserved 集合放行，其余逐字节转义。
# 与 deploy/install.sh 里那份是同一个实现（那一路的对象是 dotenvy，这一路还多穿两层解析器）
# —— check.sh 有一条判据钉住两份实现对同一批恶心口令**输出逐字相同**。
urlenc() {
    local s=$1 out= c hex i
    local LC_ALL=C        # 逐**字节**走：多字节字符整体放进 %XX 序列里，不能被按字符掰开
    for (( i=0; i<${#s}; i++ )); do
        c=${s:i:1}
        case "$c" in
            [A-Za-z0-9.~_-]) out+=$c ;;
            *) printf -v hex '%%%02X' "'$c"; out+=$hex ;;
        esac
    done
    printf '%s' "$out"
}

# ⚠️ 比 install.sh 那条**更严**：那边只禁空格/引号/#，这里还要再禁 `$`、反引号、反斜杠、
#    换行。原因是 docker 这条路上这些值要穿过**两个**额外的解析器 —— compose 的 .env 插值
#    与 env_file 解析 —— 而那两个对 `$` 的处理与本仓的 dotenvy 不是一套。宁可在这里拒绝，
#    也不要半夜查"为什么口令明明对却连不上库"。生成器给的都是纯 hex，只有人手输入会撞上。
check_env_value() {
    case "$1" in
        *[[:space:]\'\"#\$\`\\]*)
            die "这个值里有空格 / 引号 / # / \$ / 反引号 / 反斜杠，compose 与 .env 的解析都会散架：$2" ;;
    esac
}

# 有这一行（未被注释的）就替换，没有就追加
set_env() {
    local file=$1 key=$2 val=$3 tmp
    check_env_value "$val" "$key"
    [ -f "$file" ] || die "set_env: 没有 $file"
    tmp="$(mktemp)"; chmod 600 "$tmp"
    awk -v k="$key" -v v="$val" '
        $0 ~ "^[[:space:]]*"k"=" { print k"="v; seen=1; next }
        { print }
        END { if (!seen) print k"="v }
    ' "$file" >"$tmp"
    mv "$tmp" "$file"
}

# 取 .credentials / .env 里某个键的值（值里不许有 `=` 之外的花样，见上面的校验）
read_key() {
    local file=$1 key=$2
    [ -f "$file" ] || return 0
    grep -E "^[[:space:]]*${key}=" "$file" | tail -1 | cut -d= -f2-
}

usage() {
    cat <<'EOF'
Saudade Blog —— Docker 安装路：宿主侧准备

  bash prepare.sh [选项]

  --domain NAME          裸域名（如 blog.example.com），**必填**（不带协议、不带路径）
  --site-url URL         站点地址，默认 https://<domain>
  --site-title TEXT      站名（<title> / og:title）；留空用中性占位"个人博客"
  --site-description TEXT 站点描述
  --site-author NAME     署名（<meta name="author">）；留空 = 页面上不留署名
  --site-keywords TEXT   <meta name="keywords">；留空 = 整行删掉
  --data-dir DIR         宿主数据目录，默认 ~/saudade-docker-data
                        （uploads / logs / traces / agent-data 都在它下面）

  --admin-user NAME      第一个管理员用户名（默认 admin）
  --admin-pass PASS      它的口令；留空 = 随机生成（只写进 generated/.credentials）
  --db-name NAME         库名（默认 saudade_blog —— 迁移文件里写死了它，别改）
  --db-user NAME         MySQL 应用账号（默认 saudade_blog）
  --db-pass PASS         它的口令；留空 = 随机生成
  --mysql-root-pass PASS MySQL root 口令（只进 docker 的那个 MySQL 实例）；留空 = 随机生成

  --provider NAME        对话模型提供方：deepseek / qwen / openai（默认 deepseek）
  --api-key KEY          它的 API Key
  --base-url URL         自定义端点（qwen 走阿里云百炼**必须**给，见 README）

  --cert-file PATH       已有证书的**证书链**（可选）；给了它就必须给 --cert-key
  --cert-key PATH        对应的私钥
  --cert-name NAME       证书基名（默认 site）；落到 generated/ssl/<NAME>.{crt,key}

  --tz ZONE              时区（默认 Asia/Shanghai；三处必须同源：容器 / MySQL / 渲染出来的页面）

  --yes                  不交互（缺的必填项直接报错，不挂在那里等输入）
  --dry-run              只打印要做什么，**一个字都不写**
  --print blog.conf      只渲染并打印 nginx 配置（check.sh 的字节比对用），不写任何文件
  -h, --help             这一页

  ⚠️ 口令/密钥里不要用空格、引号、#、$、反引号、反斜杠（见脚本里 check_env_value 的注释）。
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --domain)           DOMAIN="${2:?}"; shift 2 ;;
        --site-url)         SITE_URL="${2:?}"; shift 2 ;;
        --site-title)       SITE_TITLE="${2:?}"; shift 2 ;;
        --site-description) SITE_DESCRIPTION="${2:?}"; shift 2 ;;
        --site-author)      SITE_AUTHOR="${2:?}"; shift 2 ;;
        --site-keywords)    SITE_KEYWORDS="${2:?}"; shift 2 ;;
        --data-dir)         DATA_DIR="${2:?}"; shift 2 ;;
        --admin-user)       ADMIN_USER="${2:?}"; shift 2 ;;
        --admin-pass)       ADMIN_PASS="${2:?}"; shift 2 ;;
        --db-name)          DB_NAME="${2:?}"; shift 2 ;;
        --db-user)          DB_USER="${2:?}"; shift 2 ;;
        --db-pass)          DB_PASS="${2:?}"; shift 2 ;;
        --mysql-root-pass)  MYSQL_ROOT_PASS="${2:?}"; shift 2 ;;
        --provider)         LLM_PROVIDER="${2:?}"; shift 2 ;;
        --api-key)          LLM_API_KEY="${2:?}"; shift 2 ;;
        --base-url)         LLM_BASE_URL="${2:?}"; shift 2 ;;
        --cert-file)        CERT_CRT="${2:?}"; shift 2 ;;
        --cert-key)         CERT_KEY="${2:?}"; shift 2 ;;
        --cert-name)        CERT_NAME="${2:?}"; shift 2 ;;
        --tz)               TZ_VAL="${2:?}"; shift 2 ;;
        --yes|-y)           ASSUME_YES=1; shift ;;
        --dry-run)          DRY_RUN=1; shift ;;
        --print)            PRINT_WHAT="${2:?}"; shift 2 ;;
        -h|--help)          usage; exit 0 ;;
        *)                  usage >&2; die "不认识的参数：$1" ;;
    esac
done

# ── 写盘的两个唯一出口（dry-run 的边界就靠它们，别在别处直接 mkdir/重定向）──────
mkdir_p() { if [ "$DRY_RUN" = 1 ]; then say "[dry-run] mkdir -p $*"; else mkdir -p "$@"; fi; }
# write_file <路径> <<'EOF' … EOF   —— 内容从 stdin 进
# ⚠️ 三个写文件的 heredoc 都是**不带引号**的（正文里要展开 $DOMAIN、$DB_PASS…），于是正文
#    里的反引号会被当**命令替换**真的执行一遍（写完这一版的第一次 dry-run 就撞上了：
#    「`ALTER USER …`」被执行成 `ALTER: command not found`，好消息是它只是被吃掉）。
#    ⇒ 正文里要"引号强调"就用「」，不要用反引号；真要用就得逐个 `\`` 转义，那太容易漏。
write_file() {
    local path=$1
    if [ "$DRY_RUN" = 1 ]; then
        say "[dry-run] 会写 $path（$(wc -c | tr -d ' ') 字节）"
        cat >/dev/null
        return 0
    fi
    cat >"$path"
    chmod 600 "$path"
}

# ── 0. 前置检查 ───────────────────────────────────────────────────────────────
step "前置检查"
command -v openssl >/dev/null 2>&1 || die "没有 openssl —— 自签证书与随机口令都要用它"
[ -f "$REPO_DIR/.env.example" ] || die "找不到 $REPO_DIR/.env.example（父仓不完整？）"
[ -d "$AGENT_DIR" ] || die "找不到 $AGENT_DIR —— agent 是**另一个仓**，必须克隆在仓库根下、且就叫这个名字：
    git clone https://github.com/BigLeopardCat/saudade-blog-agent.git $AGENT_DIR"
[ -f "$AGENT_DIR/.env.example" ] || die "找不到 $AGENT_DIR/.env.example（agent 仓完整吗）"
[ -f "$RENDER_LIB" ] || die "找不到 $RENDER_LIB —— nginx 配置的唯一实现在那儿"
case "$DB_NAME" in saudade_blog) ;; *) warn "库名不是 saudade_blog：迁移文件里写死了这个名字，建库那一步会失败" ;; esac
ok "仓库根 $REPO_DIR"
ok "agent 仓 $AGENT_DIR"

# ── 1. 收集（已有秘密优先复用）────────────────────────────────────────────────
# 复用表：**先读已有文件**，再问人。理由不是省事，是"换了就等于自锁"——
# MySQL 的口令只在**第一次**初始化数据卷时生效（见 db-init.sh 头注），
# JWT_SECRET 一换所有已登录的令牌立即失效。所以默认一律沿用，要换得明说。
OLD_DB_PASS="$(read_key "$CRED_FILE" DB_PASS)"
OLD_ROOT_PASS="$(read_key "$CRED_FILE" MYSQL_ROOT_PASSWORD)"
OLD_ADMIN_PASS="$(read_key "$CRED_FILE" ADMIN_PASS)"
OLD_JWT="$(read_key "$CRED_FILE" JWT_SECRET)"
[ -n "$OLD_JWT" ] || OLD_JWT="$(read_key "$COMPOSE_ENV" JWT_SECRET)"
REUSING=0
[ -f "$CRED_FILE" ] && REUSING=1

step "收集配置（已有 generated/.credentials 时，口令与密钥一律沿用）"

ask() {   # ask <变量名> <提示> [默认值]
    local var=$1 prompt=$2 def=${3:-} val
    val="${!var}"
    if [ -z "$val" ] && [ "$ASSUME_YES" = 0 ]; then
        [ "$HAVE_TTY" = 1 ] || die "$var 没有值，而这里也没有终端可问（用 --yes 或直接给参数）"
        if [ -n "$def" ]; then read -r -p "   $prompt [$def]: " val </dev/tty || val=""
        else read -r -p "   $prompt: " val </dev/tty || val=""; fi
    fi
    [ -n "$val" ] || val="$def"
    printf -v "$var" '%s' "$val"
}

ask_secret() {   # ask_secret <变量名> <提示> [生成器]
    local var=$1 prompt=$2 gen=${3:-} val
    val="${!var}"
    if [ -z "$val" ] && [ "$ASSUME_YES" = 0 ]; then
        [ "$HAVE_TTY" = 1 ] || die "$var 没有值（用 --yes 或直接给参数）"
        printf '   %s（不回显；留空 = 随机生成）: ' "$prompt" >&2
        read -r -s val </dev/tty || val=""
        printf '\n' >&2
    fi
    if [ -z "$val" ] && [ -n "$gen" ]; then val="$($gen)"; fi
    printf -v "$var" '%s' "$val"
}

if [ -n "$PRINT_WHAT" ]; then
    # --print 模式：不问、不写、只渲染，**在这里就出去**。放在这个位置不是风格问题：
    # 下面那些 ask 在无终端时会 die，而 check.sh 正是在无终端的沙箱里跑它的。
    [ "$PRINT_WHAT" = "blog.conf" ] || die "--print 只认 blog.conf（给的是 $PRINT_WHAT）"
    [ -n "$DOMAIN" ] || die "--print 也要 --domain（server_name 与 SAN 都取自它）"
    CERT_NAME="${CERT_NAME:-selfsigned}"
    # 与落地那次**逐字同一组输入**（APP_DIR=/srv 是容器里的路径约定，见 Dockerfile.frontend）
    DEPLOY_DIR="$REPO_DIR/deploy"; APP_DIR=/srv; WITH_IOT=0
    # shellcheck source=deploy/nginx/render.sh
    source "$RENDER_LIB"
    render_nginx
    exit 0
elif [ "$REUSING" = 1 ]; then
    say "沿用已有的 generated/.credentials 与 compose .env（不重生成任何口令/密钥）"
    DB_PASS="${DB_PASS:-$OLD_DB_PASS}"; MYSQL_ROOT_PASS="${MYSQL_ROOT_PASS:-$OLD_ROOT_PASS}"
    ADMIN_PASS="${ADMIN_PASS:-$OLD_ADMIN_PASS}"; JWT_SECRET="${JWT_SECRET:-$OLD_JWT}"
    DOMAIN="${DOMAIN:-$(read_key "$COMPOSE_ENV" SITE_DOMAIN)}"
    SITE_URL="${SITE_URL:-$(read_key "$COMPOSE_ENV" SITE_URL)}"
    DATA_DIR="${SAUDADE_DATA_DIR:-$(read_key "$COMPOSE_ENV" SAUDADE_DATA_DIR)}"
    DATA_DIR="${DATA_DIR:-$HOME/saudade-docker-data}"
    if [ -z "$DOMAIN" ] && [ -n "$SITE_URL" ]; then DOMAIN="${SITE_URL#*://}"; DOMAIN="${DOMAIN%%/*}"; fi
    [ "$ASSUME_YES" = 0 ] && [ -z "$DOMAIN" ] && say "（没记到域名，下面问一次）"
fi

ask DOMAIN "裸域名（如 blog.example.com，不要带 https:// 与路径）"
case "$DOMAIN" in
    *://*|*/*|*:*|"") die "域名要写成裸域名（blog.example.com），实际给了：$DOMAIN" ;;
esac
case "$DOMAIN" in *[!A-Za-z0-9.-]*) die "域名里有不认识的字符：$DOMAIN" ;; esac
[ -n "$SITE_URL" ] || SITE_URL="https://$DOMAIN"

ask SITE_TITLE "站名（<title>，留空 = 中性占位「个人博客」）" ""
ask SITE_DESCRIPTION "站点描述（留空 = 中性占位）" ""
ask SITE_AUTHOR "署名（<meta name=\"author\">，留空 = 不留）" ""
ask SITE_KEYWORDS "keywords（留空 = 整行删掉）" ""
check_env_value "$SITE_TITLE" SITE_TITLE
check_env_value "$SITE_DESCRIPTION" SITE_DESCRIPTION
check_env_value "$SITE_AUTHOR" SITE_AUTHOR
check_env_value "$SITE_KEYWORDS" SITE_KEYWORDS

ask ADMIN_USER "第一个管理员的用户名" admin
ask ADMIN_NICK "它的昵称" "站长"
if [ -n "$ADMIN_PASS" ]; then :; elif [ "$REUSING" = 1 ]; then say "管理员口令沿用 .credentials 里那份（改它要动数据库，见 README）"
else ask_secret ADMIN_PASS "管理员口令" rand_pw; fi
check_env_value "$ADMIN_USER" ADMIN_USER
check_env_value "$ADMIN_NICK" ADMIN_NICK
check_env_value "$ADMIN_PASS" ADMIN_PASS

if [ "$REUSING" = 1 ]; then
    say "MySQL 口令沿用 .credentials（改应用账号那条会跟着收敛；root 那条只在建卷时生效，见 README）"
else
    ask_secret DB_PASS "MySQL 应用账号 $DB_USER 的口令" rand_pw
    ask_secret MYSQL_ROOT_PASS "MySQL root 口令（只在容器里用）" rand_pw
fi
check_env_value "$DB_USER" DB_USER
check_env_value "$DB_PASS" DB_PASS
check_env_value "$MYSQL_ROOT_PASS" MYSQL_ROOT_PASSWORD

if [ -n "$JWT_SECRET" ]; then :; elif [ "$REUSING" = 1 ] && [ -n "$OLD_JWT" ]; then JWT_SECRET="$OLD_JWT"
else ask_secret JWT_SECRET "JWT 签名密钥（两份 .env 共用，换了所有人要重新登录）" "rand_hex 32"; fi
check_env_value "$JWT_SECRET" JWT_SECRET

ask LLM_PROVIDER "对话模型提供方（deepseek / qwen / openai）" deepseek
if [ -n "$LLM_API_KEY" ]; then :; elif [ "$REUSING" = 1 ] && [ -n "$(read_key "$GEN_DIR/agent.env" "$(printf '%s' "$LLM_PROVIDER" | tr '[:lower:]' '[:upper:]')_API_KEY")" ]; then
    say "API Key 沿用 generated/agent.env 里那份"
else ask_secret LLM_API_KEY "${LLM_PROVIDER} 的 API Key" ""; fi
ask LLM_BASE_URL "自定义端点（qwen 必填；其它留空）" ""
check_env_value "$LLM_PROVIDER" LLM_PROVIDER
check_env_value "$LLM_API_KEY" "${LLM_PROVIDER}_API_KEY"
check_env_value "$LLM_BASE_URL" "${LLM_PROVIDER}_BASE_URL"
check_env_value "$DATA_DIR" SAUDADE_DATA_DIR
check_env_value "$TZ_VAL" TZ

case "$LLM_PROVIDER" in
    qwen)
        [ -n "$LLM_BASE_URL" ] || warn "qwen 不给 --base-url 会落到**代码里那个维护者的业务空间端点**（agent 仓
      .env.example 的注释写了这条）—— 你的 key 对不上它，表现是每次对话 401。
      正确值形如 https://dashscope.aliyuncs.com/compatible-mode/v1" ;;
    openai|deepseek|"") ;;
    *) warn "没见过的提供方「$LLM_PROVIDER」：会照原样写进 agent 的 .env，代码侧认不认由它决定" ;;
esac

# 证书：给了证书链就必须同时给私钥；证书名与甲块那个 selfsigned 分开，别把自签那张覆盖掉
if [ -n "$CERT_CRT" ] || [ -n "$CERT_KEY" ]; then
    [ -n "$CERT_CRT" ] && [ -n "$CERT_KEY" ] || die "--cert-file 与 --cert-key 必须成对给"
    [ -f "$CERT_CRT" ] || die "证书不在：$CERT_CRT"
    [ -f "$CERT_KEY" ] || die "私钥不在：$CERT_KEY"
    CERT_NAME="${CERT_NAME:-site}"
    say "乙块用你的正式证书：generated/ssl/$CERT_NAME.{crt,key}"
else
    CERT_NAME="selfsigned"
    say "没有给证书 ⇒ 自签一张（含 SAN：$DOMAIN / localhost / 127.0.0.1）"
    note "浏览器会警告"不受信任"，点继续即可；agent 那一侧靠 agent-entrypoint.sh 把它装进信任链。"
    note "日后换正式证书：--cert-file 链.crt --cert-key 私钥.key 重跑本脚本。"
fi

# HOST_IP 只用来给自签证书多签一个 IP SAN（按 IP 访问时的方便），拿不到就算了
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')" || HOST_IP=""

# ── 2. 落地 ───────────────────────────────────────────────────────────────────
step "落地：generated/ 与 $DATA_DIR"
mkdir_p "$GEN_DIR" "$GEN_DIR/ssl"
mkdir_p "$DATA_DIR" "$DATA_DIR/uploads" "$DATA_DIR/logs/frontend" "$DATA_DIR/traces" \
        "$DATA_DIR/agent-data" "$DATA_DIR/agent-data/word_graph/web"

# ① compose 插值用的 .env。**只有 compose 自己要用的键**：站点身份要传进前端构建参数，
#    数据目录/属主要拼挂载路径，MySQL 那个 root 口令是官方镜像唯一的入口。
#    ⚠️ 应用配置（DATABASE_URL / JWT_SECRET / 工具端点…）**不在这里**，在下面两份 .env 里 ——
#    一个键只有一个写者，免得改了一处忘了另一处。
write_file "$COMPOSE_ENV" <<EOF
# ═══════════════════════════════════════════════════════════════════════════════
#  docker compose 读的那份（compose 自动读同目录下的 .env）—— **由 prepare.sh 生成**
#
#  这里只放给 compose 自己用的键（插值、构建参数、数据目录、属主）。应用配置在
#  generated/backend.env 与 generated/agent.env，两份都由同一个 prepare.sh 写。
#
#  ⚠️ 别把本文件贴给别人/贴进 issue：里面有 MySQL root 口令。
#     「docker compose config」会把它们**原样打出来**（README 里写了这一点）。
# ═══════════════════════════════════════════════════════════════════════════════
TZ=$TZ_VAL

# ── MySQL（只有这个 compose 服务需要 root 口令；应用账号的口令在 .credentials）──
MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASS
DB_NAME=$DB_NAME
DB_USER=$DB_USER

# ── 宿主数据目录与属主 ─────────────────────────────────────────────────────────
# 三个 host 网络的服务以**宿主用户**的身份跑（compose 的 user:）：不然 uploads/traces
# 这些宿主目录会落一堆 root 属主的文件，你自己的账号反而删不掉。
SAUDADE_DATA_DIR=$DATA_DIR
SAUDADE_UID=$(id -u)
SAUDADE_GID=$(id -g)
# 裸域名单独留一份：再跑 prepare.sh 时不用重问，也便于排查"域名是从哪来的"
SITE_DOMAIN=$DOMAIN

# ── 站点身份：**前端构建期**变量（vite 把这几项烤进 HTML）────────────────────────
SITE_URL=$SITE_URL
SITE_TITLE=$SITE_TITLE
SITE_DESCRIPTION=$SITE_DESCRIPTION
SITE_AUTHOR=$SITE_AUTHOR
SITE_KEYWORDS=$SITE_KEYWORDS
EOF
[ "$DRY_RUN" = 1 ] || ok "generated/.env（compose 用）"

# ② 后端那份：底稿是**仓库自己的 .env.example**（键集合的唯一事实源），只覆盖那几项
#    真正由部署决定的。已有的那份不重写（保留你手动加过的键），只补齐/覆盖下面这几项。
if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] 会写 generated/backend.env（从 .env.example 起，覆盖 DATABASE_URL / JWT_SECRET / SITE_URL / CORS_ALLOWED_ORIGINS / AGENT_URL）"
else
    [ -f "$GEN_DIR/backend.env" ] || cp "$REPO_DIR/.env.example" "$GEN_DIR/backend.env"
    chmod 600 "$GEN_DIR/backend.env"
    set_env "$GEN_DIR/backend.env" DATABASE_URL "mysql://$(urlenc "$DB_USER"):$(urlenc "$DB_PASS")@127.0.0.1:3306/$DB_NAME"
    set_env "$GEN_DIR/backend.env" JWT_SECRET   "$JWT_SECRET"
    set_env "$GEN_DIR/backend.env" SITE_URL     "$SITE_URL"
    set_env "$GEN_DIR/backend.env" AGENT_URL    "http://127.0.0.1:8010/chat"
    set_env "$GEN_DIR/backend.env" CORS_ALLOWED_ORIGINS "$SITE_URL"
    ok "generated/backend.env（后端用）"
fi

# ③ agent 那份：底稿同理。**IOT_ENABLED 必须缺席**（不是空串）——
#    pydantic-settings 没有 env_ignore_empty，空串给 bool 字段就是 ValidationError，
#    而 config/settings.py 是模块级 `settings = Settings()` ⇒ **导入期就崩、服务起不来**
#    （systemd 那边是重启循环，容器这边是 restart 循环）。.env.example 里那一行是
#    `IOT_ENABLED=`，所以这里显式把它整行去掉（双保险：agent 仓那份也一起修了）。
PROV_UPPER="$(printf '%s' "$LLM_PROVIDER" | tr '[:lower:]' '[:upper:]')"
if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] 会写 generated/agent.env（从 agent/.env.example 起，去掉 IOT_ENABLED，覆盖 JWT_SECRET / BLOG_API_BASE / GRAPH_API_BASE / TRACE_DIR / LLM_PROVIDER / ${PROV_UPPER}_API_KEY / AGENT_REQUIRE_ASSERTION=1）"
else
    if [ ! -f "$GEN_DIR/agent.env" ]; then
        grep -vE '^[[:space:]]*IOT_ENABLED=' "$AGENT_DIR/.env.example" > "$GEN_DIR/agent.env"
    else
        # 已有那份也要扫一遍：早期版本或手改过的文件里可能留着空串那一行
        sed -i -E '/^[[:space:]]*IOT_ENABLED=[[:space:]]*$/d' "$GEN_DIR/agent.env"
    fi
    chmod 600 "$GEN_DIR/agent.env"
    set_env "$GEN_DIR/agent.env" JWT_SECRET "$JWT_SECRET"
    # BLOG_API_BASE 决定**它去哪儿读你的站**：末尾必须带 /api/public，否则工具全 404
    set_env "$GEN_DIR/agent.env" BLOG_API_BASE "https://$DOMAIN/api/public"
    # 建图那条路走回环，不过 TLS —— 它只需要一个能返回语料的公开接口
    set_env "$GEN_DIR/agent.env" GRAPH_API_BASE "http://127.0.0.1:3000/api/public"
    set_env "$GEN_DIR/agent.env" TRACE_DIR "/data/traces"
    set_env "$GEN_DIR/agent.env" AGENT_ADMIN_BASE "http://127.0.0.1:3000"
    set_env "$GEN_DIR/agent.env" LLM_PROVIDER "$LLM_PROVIDER"
    [ -n "$LLM_API_KEY" ] || warn "没给 API Key —— 站点一切正常，只有看板娘不会答话"
    [ -z "$LLM_API_KEY" ] || set_env "$GEN_DIR/agent.env" "${PROV_UPPER}_API_KEY" "$LLM_API_KEY"
    [ -z "$LLM_BASE_URL" ] || set_env "$GEN_DIR/agent.env" "${PROV_UPPER}_BASE_URL" "$LLM_BASE_URL"
    # 缺身份断言的请求直接 401：全新部署没有滚动上线的问题，安全默认值就是 1
    set_env "$GEN_DIR/agent.env" AGENT_REQUIRE_ASSERTION 1
    ok "generated/agent.env（agent 用）"
fi

# ④ .credentials：给人看的一页，同时**当 db-init 的 env_file 用**（一个文件两个用途，
#    免得同样的口令在两处各存一份、哪天改一处忘一处）。格式是 KEY=value（无引号无空格）。
write_file "$CRED_FILE" <<EOF
# ═══════════════════════════════════════════════════════════════════════════════
#  这套部署的秘密（0600）。prepare.sh 生成，再跑一次会**沿用**这里的值。
#
#  这个文件有两个用途：
#    ① 你自己看（登录后台的口令在这儿）
#    ② compose 里 db-init 服务的 env_file —— 它据此建库、建应用账号、建第一个管理员
#
#  ⚠️ 三条口令的改法各不相同（README 的《改口令》一节）：
#     · DB_PASS     改这里 → 重跑 prepare.sh（同步进 backend.env 的 DATABASE_URL）→ up -d
#                   （db-init 每次都 ALTER USER，所以这条是真能收敛的）
#     · MYSQL_ROOT_PASSWORD  只在数据卷**第一次**初始化时生效 ⇒ 改文件没用，得进容器
#                   「ALTER USER 'root'@'%' IDENTIFIED BY '…'」，再回来改这里
#     · ADMIN_PASS  库里已有管理员时 db-init 不 INSERT ⇒ 改文件没用，见 README 那句 UPDATE
# ═══════════════════════════════════════════════════════════════════════════════
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASS=$DB_PASS
MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASS
JWT_SECRET=$JWT_SECRET
ADMIN_USER=$ADMIN_USER
ADMIN_NICK=$ADMIN_NICK
ADMIN_PASS=$ADMIN_PASS
EOF
[ "$DRY_RUN" = 1 ] || ok "generated/.credentials（0600，db-init 也读它）"

# ⑤ 证书
if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] 会生成 generated/ssl/selfsigned.{crt,key}（带 SAN）与 generated/ssl/trusted.crt"
else
    if [ ! -f "$GEN_DIR/ssl/selfsigned.crt" ]; then
        SAN="DNS:$DOMAIN,DNS:localhost,IP:127.0.0.1"
        [ -z "$HOST_IP" ] || SAN="$SAN,IP:$HOST_IP"
        openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
            -keyout "$GEN_DIR/ssl/selfsigned.key" -out "$GEN_DIR/ssl/selfsigned.crt" \
            -subj "/CN=$DOMAIN" -addext "subjectAltName=$SAN" >/dev/null 2>&1 \
            || die "自签证书失败（openssl 是 1.1.1 之前的版本？-addext 需要 1.1.1+）"
        chmod 600 "$GEN_DIR/ssl/selfsigned.key"
    fi
    ok "generated/ssl/selfsigned.{crt,key}（甲块恒用它；SAN 里带了域名，agent 才验得过）"
    if [ -n "$CERT_CRT" ]; then
        cp "$CERT_CRT" "$GEN_DIR/ssl/$CERT_NAME.crt"
        cp "$CERT_KEY" "$GEN_DIR/ssl/$CERT_NAME.key"
        chmod 600 "$GEN_DIR/ssl/$CERT_NAME.key"
        ok "generated/ssl/$CERT_NAME.{crt,key}（你的正式证书）"
    fi
    # trusted.crt = **乙块（域名块）真正端出去的那一张**，agent 的入口脚本把它拼进 CA bundle。
    # 甲块那张（自签）不需要：agent 从不按 IP 访问站点。
    cp "$GEN_DIR/ssl/$CERT_NAME.crt" "$GEN_DIR/ssl/trusted.crt"
    ok "generated/ssl/trusted.crt（给 agent 装信任用）"
fi

# ⑥ nginx 站点配置：与裸机**同一份 render_nginx**（deploy/nginx/render.sh）
if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] 会渲染 generated/blog.conf（APP_DIR=/srv，DOMAIN=$DOMAIN，CERT_NAME=$CERT_NAME，WITH_IOT=0）"
else
    DEPLOY_DIR="$REPO_DIR/deploy"; APP_DIR=/srv; WITH_IOT=0
    # shellcheck source=deploy/nginx/render.sh
    source "$RENDER_LIB"
    render_nginx > "$GEN_DIR/blog.conf"
    chmod 644 "$GEN_DIR/blog.conf"
    grep -q '<你的域名>' "$GEN_DIR/blog.conf" && die "渲染出来的 blog.conf 里还留着 <你的域名> 占位符"
    grep -q '__APP_DIR__'  "$GEN_DIR/blog.conf" && die "渲染出来的 blog.conf 里还留着 __APP_DIR__ 占位符"
    ok "generated/blog.conf（容器里落到 /etc/nginx/conf.d/blog.conf）"
fi

# ── 4. 收尾 ───────────────────────────────────────────────────────────────────
step "下一步"
if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] 到此为止，一个字都没写。去掉 --dry-run 真跑一次，然后："
fi
say "cd $SCRIPT_DIR && docker compose build && docker compose up -d"
note "第一次 build 要联网取依赖（crates.io / npmjs / PyPI / GitHub / Live2D 官方 CDN），10 分钟量级"
note "起来了之后按 README 的《验收清单》逐条 curl 一遍（那里每条都给了命令）"
note "改配置：生成物在 generated/，改完 up -d（**restart 不生效**，见 README）"
say ""
say "管理员 $ADMIN_USER 的口令在 $CRED_FILE（只在这里，准备好看一眼）"

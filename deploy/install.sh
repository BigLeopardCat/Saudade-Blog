#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# 从零部署 Saudade Blog —— 一台空机器 → 一个跑着的站点
#
#   bash deploy/install.sh                       # 交互向导，一路问下来
#   bash deploy/install.sh --domain blog.me -y   # 也可以全部用参数预填（--help）
#
# 它做的每一步都对应 deploy/README.md 的 §3–§10（IoT 那一段对应 iot/README.md）：
#   前置检查 → 目录与权限 → 建库/应用账号/第一个管理员 → 两份 .env → agent 的 .venv
#   → 构建（cargo + vite）→ TLS 证书 → nginx → systemd ×2 → logrotate + 心跳 cron
#   → 起服务 → 验收；选了装 IoT 就再往下走 iot/ 那一套。
#
# 先读这三条；改脚本前也先认这三条：
#
#   1. **幂等**。重跑安全：已有 `.env` 只补缺键、绝不覆盖；库里已经有表就整段跳过；
#      配置一律"渲染 → 语法自检 → 替换"。跑第二遍的唯一后果是又打印了一遍状态。
#   2. **口令不进 stdout / argv**。MySQL root 口令走 0600 临时 defaults 文件（`ps` 上看不见）；
#      管理员口令从 stdin 喂 SQL；随机生成的口令与 `JWT_SECRET` 落在 `deploy/.credentials`
#      （0600，已 gitignore）——**脚本只打印那个路径，不打印值**。
#   3. **不猜**。缺依赖就停下并给出安装命令（不替你装系统包）；没法确定的事（比如 EMQX 的
#      下载地址在非 Ubuntu 上长什么样）就明说"这一步要你自己来"，而不是硬跑一遍装错。
#
# ⚠️ 这份脚本**不改任何模板**，它只把 deploy/ 下那几份模板渲染出来。模板与线上配置的
#    一致性判据在 deploy/README.md §7–§9；改渲染逻辑时别绕过模板直接写配置文件。
#
# ⚠️ 想先看看它会做什么：`bash deploy/install.sh --dry-run` —— 渲染产物落到一个临时目录，
#    系统一个字节都不改。比对：
#      diff -u /etc/nginx/sites-enabled/blog <那个目录>/etc/nginx/sites-available/blog
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── 路径基准 ──────────────────────────────────────────────────────────────────
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$DEPLOY_DIR/.." && pwd)}"
AGENT_DIR="$APP_DIR/saudade-blog-agent"   # 名字不要改：dotenv / 相对路径都按它推
CRED_FILE="$DEPLOY_DIR/.credentials"      # 0600，已 gitignore

# ── 参数（同名的大写环境变量可预填）──────────────────────────────────────────
DOMAIN="${DOMAIN:-}"                  # 裸域名，不带协议；空 = 只有 IP 的形态
SITE_URL="${SITE_URL:-}"              # 空 = 由 DOMAIN 推
DB_NAME="${DB_NAME:-saudade_blog}"    # 别改：迁移文件里写死了这个名字
DB_USER="${DB_USER:-saudade_blog}"
DB_PASS="${DB_PASS:-}"                # 空 = 随机生成
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_NICK="${ADMIN_NICK:-站长}"
ADMIN_PASS="${ADMIN_PASS:-}"          # 空 = 随机生成
JWT_SECRET="${JWT_SECRET:-}"          # 空 = 随机生成
UPLOAD_DIR="${UPLOAD_DIR:-}"          # 空 = $HOME/saudade-uploads
MYSQL_ROOT_USER="${MYSQL_ROOT_USER:-root}"
MYSQL_ROOT_PASS="${MYSQL_ROOT_PASS:-}"    # 空 = 交互索要；互动里再回车 = 无口令登录
LLM_PROVIDER="${LLM_PROVIDER:-deepseek}"
LLM_API_KEY="${LLM_API_KEY:-}"
LLM_BASE_URL="${LLM_BASE_URL:-}"
CERT_NAME="${CERT_NAME:-selfsigned}"  # /etc/nginx/ssl/<这个名字>.crt|.key
CERT_CRT="${CERT_CRT:-}"              # 已有的正式证书（可选）：证书链 + 私钥
CERT_KEY="${CERT_KEY:-}"
SITE_TITLE="${SITE_TITLE:-}"
SITE_DESCRIPTION="${SITE_DESCRIPTION:-}"
NODE_MAX_MB="${VITE_HEAP:-}"          # vite 的 --max-old-space-size；空 = 按机器内存推
EMQX_VERSION="${EMQX_VERSION:-5.8.9}"
EMQX_ADMIN_PASS="${EMQX_ADMIN_PASS:-}"    # 只在"从没配过 EMQX"时用得上

APP_USER="${APP_USER:-$(id -un)}"
SUDO="${SUDO:-sudo}"

# IoT 三个旗标。**WITH_IOT_SET 才是"装不装已经定过了吗"**：
# 它决定向导要不要开口问（见 collect）。设了它就别再问——问了反而把
# `-y` 脚本化调用变成挂起，也会把 `--with-iot` 明确说的意思又覆盖一遍。
WITH_IOT="${WITH_IOT:-0}"
IOT_ONLY="${IOT_ONLY:-0}"
case "$WITH_IOT" in 1|true|yes|on) WITH_IOT=1 ;; *) WITH_IOT=0 ;; esac
case "$IOT_ONLY" in 1|true|yes|on) IOT_ONLY=1 ;; *) IOT_ONLY=0 ;; esac
WITH_IOT_SET=0
if [ "$WITH_IOT" = 1 ] || [ "$IOT_ONLY" = 1 ]; then WITH_IOT_SET=1; fi
ASSUME_YES=0
DRY_RUN=0
DO_BUILD=1
STAGE=""

# ── 输出 ──────────────────────────────────────────────────────────────────────
# ⚠️ **给人看的字一律走 stderr，stdout 只留给渲染出来的文件内容。**
#   这不是洁癖：`render_nginx | put_root …` 这种管道会把被调函数的 stdout
#   整个当成文件内容写下去。第一版就是这么错的——`note` 那行字被写进了
#   /etc/nginx/sites-available/blog 的第一行，写成 `· 没给域名 ⇒ …`，
#   而它长在开头、`nginx -t` 报的是后面某个行号，很容易读成别的问题。
#     （修法是让 note 走 stderr；以后在这类被管道的函数里加任何打印，
#      都必须用下面这几个 helper，别裸 printf。）
if [ -t 2 ]; then C_R=$'\033[31m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else C_R=; C_G=; C_Y=; C_B=; C_0=; fi
STEP_N=0
step() { STEP_N=$((STEP_N + 1)); printf '\n%s── %d. %s ──%s\n' "$C_B" "$STEP_N" "$*" "$C_0" >&2; }
say()  { printf '   %s\n' "$*" >&2; }
ok()   { printf '   %s✅%s %s\n' "$C_G" "$C_0" "$*" >&2; }
warn() { printf '   %s⚠️%s  %s\n' "$C_Y" "$C_0" "$*" >&2; }
note() { printf '      · %s\n' "$*" >&2; }
die()  { printf '\n%s❌ %s%s\n' "$C_R" "$*" "$C_0" >&2; exit 1; }

# ── 执行 / 写入：两个唯一出口 ─────────────────────────────────────────────────
# 会改机器的命令全从这里走，dry-run 才有一条可审计的边界。
run() {   # run <命令…>
    if [ "$DRY_RUN" = 1 ]; then printf '      [dry-run] %s\n' "$*" >&2; else "$@"; fi
}
run_sudo() {
    if [ "$DRY_RUN" = 1 ]; then printf '      [dry-run] %s %s\n' "$SUDO" "$*" >&2; else $SUDO "$@"; fi
}
run_in() {   # run_in <目录> <命令…>
    local d=$1; shift
    if [ "$DRY_RUN" = 1 ]; then printf '      [dry-run] (cd %s && %s)\n' "$d" "$*" >&2
    else ( cd "$d" && "$@" ); fi
}
put_root() {   # 需要 root 的文件写入，内容从 stdin 来 → put_root <目标> [模式]
    local dest=$1 mode=${2:-644}
    if [ "$DRY_RUN" = 1 ]; then
        local staged="$STAGE/${dest#/}"
        mkdir -p "$(dirname "$staged")"
        cat >"$staged"
        note "[dry-run] $dest → $staged"
    else
        $SUDO mkdir -p "$(dirname "$dest")"
        $SUDO tee "$dest" >/dev/null
        $SUDO chmod "$mode" "$dest"
    fi
}

# ── 提问 ──────────────────────────────────────────────────────────────────────
HAVE_TTY=0
# 探测有没有终端可问。用一个子 shell 把重定向**整个**包起来再丢弃 stderr ——
# 写成 `: >/dev/tty 2>/dev/null` 的话，'open /dev/tty 失败' 是重定向本身报的，
# 消息在 2>/dev/null 生效**之前**就出去了，于是每次无终端运行都先冒一行
# "line NN: /dev/tty: No such device or address"，看着像脚本坏了。
if { true >/dev/tty; } 2>/dev/null; then HAVE_TTY=1; fi

ask() {   # ask <变量名> <提示> [默认值] —— 已经有值（flag/env）就不问
    local var=$1 prompt=$2 def=${3:-} val
    val="${!var}"
    if [ -z "$val" ] && [ "$ASSUME_YES" = 0 ]; then
        [ "$HAVE_TTY" = 1 ] || die "$var 没有值，而这里也没有终端可问（用 --yes 或直接给参数）"
        if [ -n "$def" ]; then read -r -p "   $prompt [$def]: " val </dev/tty || val=""
        else read -r -p "   $prompt: " val </dev/tty || val=""; fi
    fi
    if [ -z "$val" ]; then val="$def"; fi
    printf -v "$var" '%s' "$val"
}

ask_secret() {   # ask_secret <变量名> <提示> [默认值] [生成器命令] —— 不回显
    local var=$1 prompt=$2 def=${3:-} gen=${4:-} val
    val="${!var}"
    if [ -z "$val" ] && [ "$ASSUME_YES" = 0 ]; then
        [ "$HAVE_TTY" = 1 ] || die "$var 没有值（用 --yes 或直接给参数）"
        printf '   %s（不回显；留空 = 随机生成）: ' "$prompt" >&2
        read -r -s val </dev/tty || val=""
        printf '\n' >&2
    fi
    if [ -z "$val" ]; then
        if [ -n "$gen" ]; then val="$($gen)"; else val="$def"; fi
    fi
    printf -v "$var" '%s' "$val"
}

ask_yn() {   # ask_yn <问句> [y|n 默认值] —— 选装件专用
    # 与 confirm 的差别全在**默认值**那一格：confirm 确认的是"要不要动手"（--yes 语义 =
    # 都同意），这里问的是"要不要多加一件东西"（--yes 语义 = 都按默认来 = **不装**）。
    # 混成一个函数的后果很具体：`-y` 会把可选件悄悄装上，或者反过来把必做的一步跳掉。
    local q=$1 def=${2:-n} a
    if [ "$ASSUME_YES" = 1 ] || [ "$HAVE_TTY" != 1 ]; then
        [ "$def" = y ]
        return
    fi
    printf '   %s [%s] ' "$q" "$([ "$def" = y ] && echo 'Y/n' || echo 'y/N')" >&2
    read -r a </dev/tty || a=""
    [ -z "$a" ] && a="$def"
    case "$a" in [yY]*) return 0 ;; *) return 1 ;; esac
}

confirm() {   # confirm <问句> —— --yes 下恒真；没有终端时恒假（宁可不做）
    if [ "$ASSUME_YES" = 1 ]; then return 0; fi
    if [ "$HAVE_TTY" != 1 ]; then return 1; fi
    local a
    printf '   %s [y/N] ' "$1" >&2
    read -r a </dev/tty || a=n
    case "$a" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# ── .env 读写 ─────────────────────────────────────────────────────────────────
# ⚠️ 值里不许有空格 / 引号 / #：`.env.example` 开头写了原因——`scripts/deploy/*` 会
#    `export $(grep -v '^#' .env | xargs)` 读它，那种写法遇到空格会散成一堆变量。
check_env_value() {
    case "$1" in
        *[[:space:]\'\"#]*) die "这个值里有空格 / 引号 / #，.env 的读取路径会散架：$2" ;;
    esac
}
# 有这一行（**未被注释的**）就替换，没有就追加
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
# **只在完全没有这个键时**才写 —— 用于"已有 .env 一个键都不覆盖"的场景
add_env_if_missing() {
    local file=$1 key=$2 val=$3
    if grep -qE "^[[:space:]]*${key}=" "$file"; then return 0; fi
    set_env "$file" "$key" "$val"
}

rand_hex() { openssl rand -hex "${1:-32}"; }
rand_pw()  { openssl rand -hex "${1:-16}"; }   # 纯 hex ⇒ 一定不含空格/引号/#，可安全进 .env

# ── 渲染模板 ──────────────────────────────────────────────────────────────────
esc() { printf '%s' "$1" | sed -e 's/[&\\|]/\\&/g'; }   # sed 替换串里这三个字符有含义
render() {   # render <模板> <OLD=NEW…>
    local tpl=$1; shift
    local -a args=()
    local pair
    for pair in "$@"; do
        args+=(-e "s|$(esc "${pair%%=*}")|$(esc "${pair#*=}")|g")
    done
    sed "${args[@]}" "$tpl"
}

usage() {
    cat <<'EOF'
Saudade Blog —— 从零部署（交互向导）

用法：bash deploy/install.sh [选项]

站点必填（不给就交互问；再不给就走"只有 IP"的形态）：
  --domain NAME        裸域名，不带协议。给了它才会渲染 nginx 的域名块
  --site-url URL       直接指定站点地址（默认由 --domain 推成 https://NAME）

数据库与账号：
  --db-name NAME       默认 saudade_blog（**迁移文件里写死了这个名字**，一般别改）
  --db-user / --db-pass
  --mysql-root-user / --mysql-root-pass    root 只用于建库与建号

第一个管理员（本项目**没有注册入口**，所以只能这里建）：
  --admin-user / --admin-nick / --admin-pass

其它：
  --upload-dir DIR     上传件落盘目录（默认 $HOME/saudade-uploads）
  --app-user NAME      跑服务的系统用户（默认当前用户；不要用 root）
  --jwt-secret S       两份 .env 共用的签名键（默认随机生成）
  --provider NAME      LLM 提供方，deepseek|qwen|openai（默认 deepseek）
  --llm-key / --llm-base-url
  --cert NAME          乙块（域名块）用 /etc/nginx/ssl/<NAME>.crt|.key 的基名（默认 selfsigned）
                       甲块（IP 兜底）恒用 selfsigned.*，与它无关
  --cert-file PATH     已有正式证书：证书链（配 --cert-key）
  --cert-key PATH
  --site-title / --site-description   前端构建期变量（不进 .env，见 vite.config.ts）

可选件 IoT（见 iot/README.md）：
  --with-iot           连 IoT 平台一起装（EMQX + nginx 三入口 + 两处开关）
  --iot-only           站点已经在跑，只补装 IoT
  --emqx-version V     默认 5.8.9
  --emqx-admin-pass P  EMQX 初始 dashboard 口令（刚装好的默认是 public）

行为开关：
  --no-build           跳过 cargo / vite 构建（产物你自己放到位）
  --vite-heap MB       vite 的 --max-old-space-size（V8 老生代上限）。
                       不给就按机器内存推：min(内存−1024, 3072)，下限 512
                       （设小了只是构建自己报 heap OOM 退出，不会拖垮整机）
  -y, --yes            非交互：不问了，全用参数与默认值
  --dry-run            只打印会做什么，渲染产物落在临时目录；**不碰系统**
  -h, --help           这段

除 -- 开头的参数外，同名大写环境变量也能预填（如 DOMAIN=blog.me）。
EOF
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        --domain)           DOMAIN="${2:?}"; shift 2 ;;
        --site-url)         SITE_URL="${2:?}"; shift 2 ;;
        --db-name)          DB_NAME="${2:?}"; shift 2 ;;
        --db-user)          DB_USER="${2:?}"; shift 2 ;;
        --db-pass)          DB_PASS="${2:?}"; shift 2 ;;
        --admin-user)       ADMIN_USER="${2:?}"; shift 2 ;;
        --admin-nick)       ADMIN_NICK="${2:?}"; shift 2 ;;
        --admin-pass)       ADMIN_PASS="${2:?}"; shift 2 ;;
        --upload-dir)       UPLOAD_DIR="${2:?}"; shift 2 ;;
        --app-user)         APP_USER="${2:?}"; shift 2 ;;
        --jwt-secret)       JWT_SECRET="${2:?}"; shift 2 ;;
        --mysql-root-user)  MYSQL_ROOT_USER="${2:?}"; shift 2 ;;
        --mysql-root-pass)  MYSQL_ROOT_PASS="${2:?}"; shift 2 ;;
        --provider)         LLM_PROVIDER="${2:?}"; shift 2 ;;
        --llm-key)          LLM_API_KEY="${2:?}"; shift 2 ;;
        --llm-base-url)     LLM_BASE_URL="${2:?}"; shift 2 ;;
        --cert)             CERT_NAME="${2:?}"; shift 2 ;;
        --cert-file)        CERT_CRT="${2:?}"; shift 2 ;;
        --cert-key)         CERT_KEY="${2:?}"; shift 2 ;;
        --site-title)       SITE_TITLE="${2:?}"; shift 2 ;;
        --site-description) SITE_DESCRIPTION="${2:?}"; shift 2 ;;
        --vite-heap)        NODE_MAX_MB="${2:?}"; shift 2 ;;
        --emqx-version)     EMQX_VERSION="${2:?}"; shift 2 ;;
        --emqx-admin-pass)  EMQX_ADMIN_PASS="${2:?}"; shift 2 ;;
        --with-iot)         WITH_IOT=1; WITH_IOT_SET=1; shift ;;
        --iot-only)         IOT_ONLY=1; WITH_IOT=1; WITH_IOT_SET=1; shift ;;
        --no-build)         DO_BUILD=0; shift ;;
        -y|--yes)           ASSUME_YES=1; shift ;;
        --dry-run)          DRY_RUN=1; shift ;;
        -h|--help)          usage ;;
        *) die "不认识的参数：$1（--help 看用法）" ;;
    esac
done

# --vite-heap 是**算数**用的（下面拿它跟 3072/2048 比大小），给个非数字会让
# `[ ... -gt ... ]` 当场报 "integer expression expected" 并往下走成"没设"——
# 看起来像没生效，其实是我们自己没校验。所以在这里一次问清。
if [ -n "$NODE_MAX_MB" ]; then
    case "$NODE_MAX_MB" in
        ""|*[!0-9]*) die "--vite-heap 要一个整数（MB），给的是：$NODE_MAX_MB" ;;
    esac
    [ "$NODE_MAX_MB" -ge 256 ] || die "--vite-heap 太小了（$NODE_MAX_MB MB，最小 256）"
fi

if [ "$DRY_RUN" = 1 ]; then
    STAGE="$(mktemp -d -t saudade-dryrun-XXXXXX)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 0. 前置检查
# ═══════════════════════════════════════════════════════════════════════════════
have() { command -v "$1" >/dev/null 2>&1; }
install_hint() {
    case "$1" in
        mysql)   echo "sudo apt-get install -y mysql-server" ;;
        nginx)   echo "sudo apt-get install -y nginx" ;;
        cargo)   echo 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh' ;;
        npm)     echo "Node.js ≥ 18（https://nodejs.org/ 或 nvm）" ;;
        python3) echo "sudo apt-get install -y python3" ;;
        uv)      echo 'curl -LsSf https://astral.sh/uv/install.sh | sh' ;;
        openssl) echo "sudo apt-get install -y openssl" ;;
        curl)    echo "sudo apt-get install -y curl" ;;
        *)       echo "（自行安装）" ;;
    esac
}

preflight() {
    step "前置检查"
    say "部署根目录：$APP_DIR"
    say "运行身份  ：$APP_USER（服务就用它跑；不要用 root）"

    if [ "$APP_USER" = "root" ]; then die "别用 root 跑服务，换一个普通用户再来。"; fi

    local missing=() m
    for m in bash curl openssl python3 mysql nginx; do
        have "$m" || missing+=("$m")
    done
    if [ "$DO_BUILD" = 1 ]; then
        have cargo || missing+=(cargo)
        have npm   || missing+=(npm)
    fi
    # uv 只有"要现建 agent 的 .venv"时才用得上；已经有解释器就不该拦着人
    if [ -d "$AGENT_DIR/.git" ] && [ ! -x "$AGENT_DIR/.venv/bin/uvicorn" ]; then
        have uv || missing+=(uv)
    fi

    if [ ${#missing[@]} -gt 0 ]; then
        printf '\n' >&2
        warn "缺这些命令，先去装上："
        for m in "${missing[@]}"; do note "$m   →   $(install_hint "$m")"; done
        printf '\n' >&2
        say "本脚本**不替你装系统包**：发行版与架构的差异太多，装错了比没装更难查。"
        say "装完原样再跑一次即可（脚本是幂等的）。"
        if [ "$DRY_RUN" != 1 ]; then exit 1; fi
        warn "dry-run：先继续，但真实部署到这里就停了"
    fi

    if [ "$DO_BUILD" = 1 ]; then
        # ⚠️ `--max-old-space-size` 是**拨盘，不是硬门槛**：它给的是 V8 老生代的上限。
        #    设得比机器扛得住的大，代价是"构建把整机拖垮"；设小了，代价只是构建自己
        #    报 `JavaScript heap out of memory` 干净退出——后者可接受得多。所以按机器
        #    实际内存推一个值（留 1 GB 给 OS 与常驻服务，上限 3072 是项目已知能编出来
        #    的那个值），而不是拿一个固定门槛把整台机器拦在外面。
        #    要覆盖：--vite-heap MB（环境变量 VITE_HEAP 同样管用）。
        local mem_mb avail_mb
        mem_mb="$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || true)"
        avail_mb="$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || true)"
        [ -n "$mem_mb" ] || mem_mb=2048        # 读不到就按 V8 默认量级来
        if [ -z "$NODE_MAX_MB" ]; then
            NODE_MAX_MB=$((mem_mb - 1024))
            [ "$NODE_MAX_MB" -gt 3072 ] && NODE_MAX_MB=3072
            [ "$NODE_MAX_MB" -lt 512 ]  && NODE_MAX_MB=512
            say "内存 ${mem_mb} MiB（其中可用约 ${avail_mb:-?} MiB）"
            say "vite 堆上限取 --max-old-space-size=${NODE_MAX_MB}（= min(内存−1024, 3072)）"
        else
            say "内存 ${mem_mb} MiB（其中可用约 ${avail_mb:-?} MiB）"
            say "vite 堆上限按你给的来：--max-old-space-size=${NODE_MAX_MB}（--vite-heap）"
        fi
        if [ "$NODE_MAX_MB" -lt 2048 ]; then
            warn "这个值比 V8 自己的默认（约 2 GB）还低 ⇒ 构建**可能**报 heap out of memory。"
            note "那是干净的失败：构建自己退出，不会把机器拖垮，可以重来。"
            note "三条出路：① 加 swap 再编；② --vite-heap 给一个你量过的值；"
            note "③ 换台机器编好，把 target/release/saudade_blog_bin 与 frontend/dist"
            note "   拷过来，再 --no-build 重跑（那就完全不在这台上编）。"
            if [ "$DRY_RUN" = 1 ]; then
                warn "dry-run：不在这里停下（反正什么都不会真的编）"
            elif ! confirm "内存偏紧，仍然要在这台机器上构建吗？"; then
                die "已停下。只装配置的话：bash deploy/install.sh --no-build …（见 --help）"
            fi
        fi
    fi

    if [ ! -d "$AGENT_DIR/.git" ]; then
        warn "没看到 $AGENT_DIR —— 那是 agent 仓的克隆点（**独立仓库**，不随本仓部署）"
        note "git clone https://github.com/BigLeopardCat/saudade-blog-agent.git saudade-blog-agent"
        note "少了它：博客一切正常，只有看板娘不会答话。"
    fi
    ok "前置检查通过"
}

# ═══════════════════════════════════════════════════════════════════════════════
# 1. 收集参数
# ═══════════════════════════════════════════════════════════════════════════════
collect() {
    step "收集参数（回车用默认值；口令不回显，留空 = 随机生成）"
    ask DOMAIN "站点域名（裸域名，不带 https://；没有域名就直接回车）"
    if [ -z "$SITE_URL" ]; then
        if [ -n "$DOMAIN" ]; then
            SITE_URL="https://$DOMAIN"
        else
            SITE_URL="http://$(hostname -I 2>/dev/null | awk '{print $1}')"
        fi
    fi
    if [ -z "$SITE_URL" ]; then die "站点地址推不出来，用 --site-url 显式给一个"; fi
    ask UPLOAD_DIR "上传件目录（生产建议放在工作区之外）" "$HOME/saudade-uploads"

    ask DB_USER "数据库应用账号"
    ask_secret DB_PASS "应用账号的口令" "" "rand_pw 16"
    ask_secret JWT_SECRET "JWT_SECRET（两份 .env 共用；换掉 = 所有人重新登录）" "" "rand_hex 32"
    ask ADMIN_USER "第一个管理员的用户名"
    ask ADMIN_NICK "它的昵称"
    ask_secret ADMIN_PASS "它的口令" "" "rand_pw 12"

    say ""
    say "看板娘用的模型服务商（agent 读它自己那份 .env）"
    ask LLM_PROVIDER "提供方（deepseek|qwen|openai）"
    ask LLM_API_KEY "API Key（留空 = 先不配：其余功能都正常，只有看板娘不会答话）"
    if [ "$LLM_PROVIDER" = "qwen" ]; then
        ask LLM_BASE_URL "QWEN_BASE_URL（**必须显式给**：代码里的默认值绑的是上游维护者的接入点）" \
            "https://dashscope.aliyuncs.com/compatible-mode/v1"
    fi

    # 可选件：问一句。**只在"还没人表过态"时问** —— `--with-iot` / `--iot-only` /
    # `WITH_IOT=1` 都是表态，`-y` 也是（取默认 = 不装）。问了的话 `-y` 那类非交互调用
    # 会挂在这里等一个永远不会来的回车，而这正是脚本要能进 CI/脚本的地方。
    if [ "$WITH_IOT_SET" = 0 ] && [ "$IOT_ONLY" = 0 ]; then
        say ""
        say "──────────────────────────────────────────────"
        say "可选件：ESP32 物联网接入（EMQX + 设备控制台 + 设备接入）"
        note "不装不影响其余任何功能，出厂默认就是不装。"
        note "装的话会改四处：/etc/emqx/、/etc/nginx/snippets/blog-iot/、"
        note "两份 .env 的 IOT_ENABLED、以及 EMQX 的认证链与 ACL（ACL 是全量替换）。"
        note "它只解决服务端那一半：device-service 源码不在任何公开仓，"
        note "装完会把缺口清单与接口契约打给你（iot/device-service/README.md）。"
        if ask_yn "要连 IoT 一起装吗？（以后想补：bash deploy/install.sh --iot-only）"; then
            WITH_IOT=1
            ok "那这趟连 IoT 一起装"
        else
            say "不装（以后想补：bash deploy/install.sh --iot-only）"
        fi
        say "──────────────────────────────────────────────"
    fi

    if [ "$WITH_IOT" = 1 ] && [ ! -f "$APP_DIR/iot/emqx/.api_key" ]; then
        ask EMQX_ADMIN_PASS "EMQX 初始 dashboard 口令（刚装好的默认是 public）" "public"
    fi

    say ""
    say "──────────────────────────────────────────────"
    say "站点地址   : $SITE_URL"
    say "部署根目录 : $APP_DIR"
    say "数据库     : $DB_NAME @127.0.0.1:3306，应用账号 $DB_USER"
    say "管理员     : $ADMIN_USER（$ADMIN_NICK）"
    say "上传件     : $UPLOAD_DIR"
    say "构建       : $([ "$DO_BUILD" = 1 ] && echo '本机编（cargo + vite）' || echo '跳过')"
    say "IoT 可选件 : $([ "$WITH_IOT" = 1 ] && echo '装' || echo '不装')"
    say "模式       : $([ "$DRY_RUN" = 1 ] && echo 'dry-run（不碰系统）' || echo '真跑')"
    say "──────────────────────────────────────────────"
    confirm "照这样开始吗？" || die "已取消"
    write_creds
}

write_creds() {   # 口令落盘，**只打印路径**；值不进 stdout
    if [ "$DRY_RUN" = 1 ]; then return 0; fi
    umask 077
    {
        printf '# deploy/install.sh 生成的凭据 —— 只在本机有一份，已 gitignore\n'
        printf '# 生成时间 %s\n\n' "$(date '+%F %T')"
        printf '站点地址     %s\n' "$SITE_URL"
        printf '管理员账号   %s\n' "$ADMIN_USER"
        printf '管理员口令   %s\n' "$ADMIN_PASS"
        printf '数据库账号   %s\n' "$DB_USER"
        printf '数据库口令   %s\n' "$DB_PASS"
        printf 'JWT_SECRET   %s\n' "$JWT_SECRET"
    } >"$CRED_FILE"
    chmod 600 "$CRED_FILE"
    ok "凭据落在 $CRED_FILE（0600）——看完请自行转移或删除"
}

# ═══════════════════════════════════════════════════════════════════════════════
# 2. 目录与权限
# ═══════════════════════════════════════════════════════════════════════════════
setup_dirs() {
    step "目录与权限"
    local d
    for d in logs logs/agent logs/frontend; do run mkdir -p "$APP_DIR/$d"; done
    run chmod 700 "$APP_DIR/logs" "$APP_DIR/logs/agent" "$APP_DIR/logs/frontend"
    ok "$APP_DIR/logs（0700）"
    run mkdir -p "$UPLOAD_DIR"
    ok "$UPLOAD_DIR"
    note "它是全站唯一只有盘上一份的数据：**迁移 = 数据库 dump 与这个目录一起走**。"
    note "只带走数据库的结果是「文章一篇不少、配图整片 404」，而且不报任何错。"
}

# ═══════════════════════════════════════════════════════════════════════════════
# 3. 数据库
# ═══════════════════════════════════════════════════════════════════════════════
# 一个 0600 的临时 defaults 文件 —— 口令因此不在 argv 里（`ps` 上看不见）。
# 它也当 `MYSQL_BIN` 的第一个词用：mysql 要求 --defaults-extra-file 排在参数最前。
MYSQL_CNF=""
mysql_init() {
    if [ "$DRY_RUN" = 1 ]; then return 0; fi
    MYSQL_CNF="$(mktemp)"
    chmod 600 "$MYSQL_CNF"
    {
        printf '[client]\nuser=%s\n' "$MYSQL_ROOT_USER"
        if [ -n "$MYSQL_ROOT_PASS" ]; then printf 'password=%s\n' "$MYSQL_ROOT_PASS"; fi
        printf 'host=127.0.0.1\n'
    } >"$MYSQL_CNF"
    trap 'rm -f "$MYSQL_CNF"' EXIT
}
mysql_root() { mysql --defaults-extra-file="$MYSQL_CNF" --default-character-set=utf8mb4 "$@"; }
sql_quote() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/''/g"; }

setup_database() {
    step "数据库：建库 → 应用账号 → 第一个管理员"
    if [ "$DRY_RUN" = 1 ]; then
        say "[dry-run] 会做：查 $DB_NAME 在不在；不在就用 fresh_install.sh 建；"
        say "          建 $DB_USER@localhost 并授权；INSERT 一个 role=admin 的账号。"
        return 0
    fi

    mysql_init
    local n
    n="$(printf 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=%s;\n' "'$DB_NAME'" \
         | mysql_root -N -B 2>/dev/null || echo ERR)"
    if [ "$n" = "ERR" ]; then
        die "连不上 MySQL（${MYSQL_ROOT_USER}@127.0.0.1）。看服务在不在、root 口令对不对。"
    fi

    if [ "$n" != "0" ]; then
        say "$DB_NAME 里已经有 $n 张表 —— 整段跳过（**脚本绝不 DROP 库**）"
    else
        say "从零建库（基架快照 + 快照之后的迁移）…"
        # ⚠️ 迁移文件里绝大多数写死了 `USE saudade_blog;`，所以库名必须叫这个。
        #    脚本默认拒收这个名字（防在生产机上打错字），所以要显式声明一次。
        #    MYSQL_BIN 用多词前缀把 --defaults-extra-file 顶到第一个参数位 ⇒ 口令不进 argv。
        MYSQL_BIN="mysql --defaults-extra-file=$MYSQL_CNF" ALLOW_PRODUCTION_NAME=1 \
            bash "$APP_DIR/scripts/migration/fresh_install.sh" "$DB_NAME" 2>&1 | sed 's/^/      /'
        ok "建库完成"
    fi

    say "应用账号 $DB_USER@localhost"
    printf "CREATE USER IF NOT EXISTS '%s'@'localhost' IDENTIFIED BY '%s';\n\
ALTER USER '%s'@'localhost' IDENTIFIED BY '%s';\n\
GRANT ALL PRIVILEGES ON \`%s\`.* TO '%s'@'localhost';\nFLUSH PRIVILEGES;\n" \
        "$(sql_quote "$DB_USER")" "$(sql_quote "$DB_PASS")" \
        "$(sql_quote "$DB_USER")" "$(sql_quote "$DB_PASS")" \
        "$(sql_quote "$DB_NAME")" "$(sql_quote "$DB_USER")" | mysql_root
    ok "账号就绪（口令与 .env 里的 DATABASE_URL 一致）"

    local cnt
    cnt="$(printf 'SELECT COUNT(*) FROM `user` WHERE role=%s;\n' "'admin'" | mysql_root -N -B "$DB_NAME")"
    if [ "$cnt" != "0" ]; then
        say "库里已经有 $cnt 个管理员 —— 不再建（要加人自己 INSERT，本项目没有注册入口）"
    else
        # 无盐单轮 SHA-256 是**旧格式**；verify_password 认它，并在首次登录成功后
        # 就地升级成 Argon2id。这条 INSERT 是"手上只有 mysql 客户端"时最省事的路径。
        printf "INSERT INTO \`user\` (username, nickname, password, role)\n\
VALUES ('%s', '%s', SHA2('%s', 256), 'admin');\n" \
            "$(sql_quote "$ADMIN_USER")" "$(sql_quote "$ADMIN_NICK")" "$(sql_quote "$ADMIN_PASS")" \
            | mysql_root "$DB_NAME"
        ok "第一个管理员 $ADMIN_USER 已建（**role=admin 才能进 /dashboard**）"
        note "口令在 $CRED_FILE 里；首次登录成功后库里那一行会自动升级成 Argon2id。"
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# 4. 两份 .env（不是一个文件）
# ═══════════════════════════════════════════════════════════════════════════════
setup_env() {
    step "环境变量：两份 .env，不是一个文件"
    local benv="$APP_DIR/.env" aenv="$AGENT_DIR/.env"

    if [ "$DRY_RUN" = 1 ]; then
        say "[dry-run] 父仓 .env ：$([ -f "$benv" ] && echo '存在 → 只补缺键' || echo '从 .env.example 新建')"
        say "[dry-run] agent .env：$([ -f "$aenv" ] && echo '存在 → 只补缺键' || echo '从 .env.example 新建')"
        return 0
    fi

    # ── 父仓那份（Rust 用；main.rs 的 dotenv() 读**工作目录**下的 .env）──
    if [ -f "$benv" ]; then
        say "父仓 .env 已存在 —— 只补缺键，不动你的现有配置"
    else
        cp "$APP_DIR/.env.example" "$benv"
    fi
    chmod 600 "$benv"
    add_env_if_missing "$benv" DATABASE_URL "mysql://$DB_USER:$DB_PASS@127.0.0.1:3306/$DB_NAME"
    add_env_if_missing "$benv" JWT_SECRET   "$JWT_SECRET"
    add_env_if_missing "$benv" SITE_URL     "$SITE_URL"
    add_env_if_missing "$benv" UPLOAD_DIR   "$UPLOAD_DIR"
    add_env_if_missing "$benv" AGENT_URL    "http://127.0.0.1:8010/chat"
    add_env_if_missing "$benv" CORS_ALLOWED_ORIGINS "$SITE_URL"
    ok "父仓 .env"

    # ── agent 那份（Python 用；config/settings.py 走 pydantic-settings）──
    if [ -f "$aenv" ]; then
        say "agent .env 已存在 —— 只补缺键，不动你的现有配置"
    else
        if [ ! -f "$AGENT_DIR/.env.example" ]; then
            die "找不到 $AGENT_DIR/.env.example（agent 仓克隆到位了吗）"
        fi
        cp "$AGENT_DIR/.env.example" "$aenv"
    fi
    chmod 600 "$aenv"
    add_env_if_missing "$aenv" JWT_SECRET "$JWT_SECRET"
    note "两份 .env 的 JWT_SECRET **必须逐字相同**：agent 用它验 Rust 发来的身份断言。"
    add_env_if_missing "$aenv" BLOG_API_BASE "$SITE_URL/api/public"
    note "不改 BLOG_API_BASE 的话，你的看板娘会认真回答**别人博客**里的问题，而且不报错。"
    add_env_if_missing "$aenv" TRACE_DIR "$APP_DIR/logs/agent/traces"
    note "TRACE_DIR 一定显式设：代码里的默认值绑的是上游维护者的机器。"
    add_env_if_missing "$aenv" GRAPH_API_BASE "http://127.0.0.1:3000/api/public"

    if [ "$IOT_ONLY" = 0 ]; then
        # 全新部署走这条；--iot-only 那趟不动这些（它只补 IoT 相关的键）
        set_env "$aenv" LLM_PROVIDER "$LLM_PROVIDER"
        if [ -n "$LLM_API_KEY" ]; then
            set_env "$aenv" "$(printf '%s' "$LLM_PROVIDER" | tr '[:lower:]' '[:upper:]')_API_KEY" "$LLM_API_KEY"
        else
            warn "没配模型 API Key —— 站点一切正常，只有看板娘不会答话"
        fi
        if [ -n "$LLM_BASE_URL" ]; then set_env "$aenv" QWEN_BASE_URL "$LLM_BASE_URL"; fi
        # 生产档：缺身份断言的请求直接 401。默认 0 只是为滚动上线方便，全新部署不需要。
        set_env "$aenv" AGENT_REQUIRE_ASSERTION 1
    fi

    if [ "$WITH_IOT" = 1 ]; then
        add_env_if_missing "$benv" IOT_ENABLED 1
        set_env "$aenv" IOT_ENABLED 1
        ok "两处 IOT_ENABLED 已置 1（父仓 + agent 仓）"
    fi
    ok "agent .env"

    warn "agent 的四个进程环境变量（AGENT_RECURSION_LIMIT / AGENT_MAX_BODY_BYTES /"
    warn "AGENT_MAX_CONCURRENT / AGENT_MAX_REVIEW）**写 .env 一点作用都没有**，"
    warn "要改就写 systemd 单元的 Environment=（模板里给了注释样例）。"
}

# ═══════════════════════════════════════════════════════════════════════════════
# 5. agent 的 .venv
# ═══════════════════════════════════════════════════════════════════════════════
setup_venv() {
    step "agent 的 .venv（uv sync）"
    if [ ! -d "$AGENT_DIR/.git" ]; then
        warn "没有 $AGENT_DIR —— 跳过。它必须克隆在部署根目录下、且就叫这个名字。"
        return 0
    fi
    # ⚠️ **已有 .venv 就不再 sync**。uv sync 会按 uv.lock 重装依赖，而正在跑的那个
    #    uvicorn 用的是这个目录里的解释器 —— 在已经跑着的机器上重装，轻则白等几分钟，
    #    重则把 .venv/bin/* 的 shebang 换掉，服务下一次重启就起不来（这条踩过）。
    #    依赖真的变了（git pull 拉动了 uv.lock）时，明说再动：
    #        rm -rf .venv && bash deploy/install.sh --iot-only   # 或直接 uv sync
    if [ -x "$AGENT_DIR/.venv/bin/uvicorn" ]; then
        say ".venv 已就位 —— 跳过（依赖变了的话：rm -rf .venv 之后重跑这一步）"
        return 0
    fi
    run_in "$AGENT_DIR" uv sync
    ok "$AGENT_DIR/.venv"
}

# ═══════════════════════════════════════════════════════════════════════════════
# 6. 构建
# ═══════════════════════════════════════════════════════════════════════════════
build() {
    step "构建产物"
    if [ "$DO_BUILD" = 0 ]; then
        say "--no-build：跳过。这两样要你自己放到位："
        note "target/release/saudade_blog_bin"
        note "frontend/dist/（就是 nginx 的 root）"
        if [ ! -x "$APP_DIR/target/release/saudade_blog_bin" ]; then warn "二进制不在，systemd 起不来"; fi
        if [ ! -f "$APP_DIR/frontend/dist/index.html" ]; then warn "dist 不在，nginx 会 403/404"; fi
        return 0
    fi

    say "后端：cargo build --release（第一次要几分钟起）"
    run_in "$APP_DIR" cargo build --release
    if [ "$DRY_RUN" != 1 ] && [ ! -x "$APP_DIR/target/release/saudade_blog_bin" ]; then
        die "没编出 target/release/saudade_blog_bin"
    fi

    say "前端：npm ci → fetch:widget → vendor:live2d → vite build"
    note "**三条 npm 命令的顺序不能换**：fetch:widget 整树替换 public/live2d-widgets/，"
    note "vendor:live2d 往它的 vendor/ 子目录里写 —— 反了的话刚取到的那份会被抹掉。"
    run_in "$APP_DIR/frontend" npm ci
    run_in "$APP_DIR/frontend" npm run fetch:widget
    run_in "$APP_DIR/frontend" npm run vendor:live2d

    # 站点身份是**构建期**变量：.env 里那份 SITE_URL 管不着它（vite.config.ts 读 process.env）。
    # 不设的话产物里留的是中性占位（个人博客 / 本站开发地址，尚未配置站点描述。）。
    local title="${SITE_TITLE:-个人博客}"
    local desc="${SITE_DESCRIPTION:-本站开发地址，尚未配置站点描述。}"
    if [ "$DRY_RUN" = 1 ]; then
        note "[dry-run] (cd $APP_DIR/frontend && VITE_SITE_URL=$SITE_URL VITE_SITE_TITLE=$title … npx vite build)"
        note "[dry-run] NODE_OPTIONS=--max-old-space-size=$NODE_MAX_MB"
    else
        ( cd "$APP_DIR/frontend" &&
          VITE_SITE_URL="$SITE_URL" \
          VITE_SITE_TITLE="$title" \
          VITE_SITE_DESCRIPTION="$desc" \
          NODE_OPTIONS="--max-old-space-size=$NODE_MAX_MB" npx vite build )
    fi
    if [ "$DRY_RUN" = 1 ]; then
        note "[dry-run] 产物到底产出了没有，留到真跑时判"
    elif [ ! -f "$APP_DIR/frontend/dist/index.html" ]; then
        die "vite build 没产出 frontend/dist/index.html"
    else
        ok "二进制与 dist 就位"
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# 7. TLS 证书
# ═══════════════════════════════════════════════════════════════════════════════
setup_tls() {
    step "TLS 证书（/etc/nginx/ssl/）"
    run_sudo mkdir -p /etc/nginx/ssl

    # 甲块（IP / 未知 Host 兜底）用的**永远是自签那一张**—— 模板里写死了路径。
    # 它不是"临时凑合"：按 IP 访问时没有任何证书能对上名字，所以这块拿正式证书
    # 去接也是白搭，反而让"IP 能进"这件事依赖一张会过期的证书。
    # 存在性检查**不过 dry-run 的闸**：它只是读一眼，而且 --dry-run 的全部价值就是
    # 「输出与真跑一致」，这里若一律报"要自签一张"，预览就会骗人。
    if $SUDO test -f /etc/nginx/ssl/selfsigned.crt; then
        say "甲块的自签证书已在（selfsigned.crt）—— 不覆盖"
    else
        say "甲块：自签一张（浏览器会报证书不受信，点继续即可）"
        run_sudo openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
            -keyout /etc/nginx/ssl/selfsigned.key -out /etc/nginx/ssl/selfsigned.crt \
            -subj "/CN=localhost"
        $SUDO chmod 600 /etc/nginx/ssl/selfsigned.key 2>/dev/null || true
    fi

    if [ -z "$DOMAIN" ]; then
        say "没给域名 ⇒ 不渲染乙块，乙块那张证书这次用不上（日后 --domain 重跑即可）"
        return 0
    fi

    # 乙块（正式域名）—— --cert-file/--cert-key 给了就用你的，没给就自签顶一下。
    if [ -n "$CERT_CRT" ] || [ -n "$CERT_KEY" ]; then
        if [ -z "$CERT_CRT" ] || [ -z "$CERT_KEY" ]; then
            die "--cert-file 与 --cert-key 必须成对给"
        fi
        if [ ! -f "$CERT_CRT" ] || [ ! -f "$CERT_KEY" ]; then
            die "证书文件不在：$CERT_CRT / $CERT_KEY"
        fi
        run_sudo cp "$CERT_CRT" "/etc/nginx/ssl/$CERT_NAME.crt"
        run_sudo cp "$CERT_KEY" "/etc/nginx/ssl/$CERT_NAME.key"
        run_sudo chmod 600 "/etc/nginx/ssl/$CERT_NAME.key"
        ok "乙块已装入 /etc/nginx/ssl/$CERT_NAME.{crt,key}"
        note "续期是另一件事：换了证书记得**两处一起换**（nginx 与 EMQX 的 8883），"
        note "漏一处表现为「网页正常、设备连不上」。"
        return 0
    fi

    if [ "$CERT_NAME" = "selfsigned" ]; then
        say "乙块也用 selfsigned（CN 对不上域名，浏览器会报警告，但能进）"
        note "有了正式证书之后：--cert-file 证书链.crt --cert-key 私钥.key --cert <名字> 重跑。"
        return 0
    fi
    if $SUDO test -f "/etc/nginx/ssl/$CERT_NAME.crt"; then
        say "乙块的证书 /etc/nginx/ssl/$CERT_NAME.crt 已存在 —— 不覆盖"
        return 0
    fi
    say "乙块：还没有正式证书，先自签一张顶上（DNS 指过来之后再换正式证书）"
    run_sudo openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout "/etc/nginx/ssl/$CERT_NAME.key" -out "/etc/nginx/ssl/$CERT_NAME.crt" \
        -subj "/CN=$DOMAIN"
    $SUDO chmod 600 "/etc/nginx/ssl/$CERT_NAME.key" 2>/dev/null || true
    ok "$CERT_NAME.crt / .key（自签）"
    note "换正式证书：--cert-file 证书链.crt --cert-key 私钥.key --cert 你要的证书名"
    note "或者用 certbot，但要把它写好的两行证书路径换进来，并注意 80 那个跳转块 ——"
    note "ACME 客户端必须在跳转**之前**接住 /.well-known/acme-challenge/，否则续期永远失败。"
}

# ═══════════════════════════════════════════════════════════════════════════════
# 8. nginx
# ═══════════════════════════════════════════════════════════════════════════════
render_nginx() {
    local out
    out="$(render "$DEPLOY_DIR/nginx/blog.conf.template" \
        "__APP_DIR__=$APP_DIR" "<你的域名>=$DOMAIN" "<证书名>=$CERT_NAME")"

    # ⚠️ 甲块（IP / 未知 Host 兜底）的证书路径在模板里**写死**是 selfsigned.*，
    #    那是刻意的、不要"顺手统一"成 --cert 给的那个名字：按 IP 访问时没有任何
    #    证书能对上名字（CN 只能是 localhost），拿正式证书去接只是白搭一张。
    #    所以两张证书各管各的，$CERT_NAME 只作用于乙块（见 setup_tls）。

    if [ -z "$DOMAIN" ]; then
        # 没给域名 → 乙块整块略去。留着 <你的域名> 会让 `nginx -t` 直接失败。
        # 用结构标记切分；标记找不到就**不切** —— 宁可让 nginx 报错，也不要静默拼出半个块。
        if ! printf '%s' "$out" | grep -q '^# ══ 乙：'; then
            die "模板结构变了：找不到乙块标记（deploy/nginx/blog.conf.template）"
        fi
        if ! printf '%s' "$out" | grep -q '^# ══ HTTP'; then
            die "模板结构变了：找不到 HTTP 跳转标记"
        fi
        out="$(printf '%s' "$out" | awk '
            /^# ══ 乙：/ {
                print "# ══ 乙：正式域名 —— 这次没给域名，整块略去 ═════════════════════════"
                print "#   （占位符留在 server_name 上会让 nginx -t 直接失败，所以是去掉，"
                print "#    不是留着当记号——别把这段当成\"还没填\"）"
                print "#   有域名之后重跑：bash deploy/install.sh --domain 你的域名"
                skip = 1; next
            }
            /^# ══ HTTP/ { skip = 0 }
            !skip { print }
        ')"
        note "没给域名 ⇒ nginx 少渲染乙块，站点只按 IP / 未知 Host 应答（自签证书）"
    fi

    if [ "$WITH_IOT" = 1 ]; then
        # 站点配置里那行通配 include 是 IoT 三个入口的**唯一入口**，模板里是注释着的。
        out="$(printf '%s' "$out" | sed \
            's|^\([[:space:]]*\)# include /etc/nginx/snippets/blog-iot/\*\.conf;|\1include /etc/nginx/snippets/blog-iot/*.conf;|')"
        if ! printf '%s' "$out" | grep -q '^[[:space:]]*include /etc/nginx/snippets/blog-iot/\*\.conf;'; then
            die "没能把那行 IoT include 解注（两个 443 块都要有）"
        fi
    fi
    printf '%s\n' "$out"
}

setup_nginx() {
    step "nginx 站点"
    render_nginx | put_root /etc/nginx/sites-available/blog 644
    run_sudo ln -sf /etc/nginx/sites-available/blog /etc/nginx/sites-enabled/blog

    if [ "$DRY_RUN" = 1 ]; then
        note "[dry-run] 不跑 nginx -t、不 reload"
        return 0
    fi
    # 先验再 reload；不过就**不动**已经在跑的那份配置
    if ! $SUDO nginx -t 2>&1 | sed 's/^/      /'; then
        die "nginx -t 没过。刚写的是 sites-available/blog；删掉 sites-enabled 那个软链即可回滚。"
    fi
    run_sudo systemctl reload nginx
    ok "站点已加载（root = $APP_DIR/frontend/dist）"
    warn "站点配置有三处极容易静默出错（模板里原文都带了注释，改前先读）："
    warn "  ① location ^~ /api/ 的 ^~ 不是装饰 —— 少了它上传图会「后端 200、过 nginx 404」"
    warn "  ② 两个 443 块内容相同、要一起改 ③ 备份文件不许放 sites-enabled/"
}

# ═══════════════════════════════════════════════════════════════════════════════
# 9. systemd
# ═══════════════════════════════════════════════════════════════════════════════
setup_systemd() {
    step "systemd 两个单元"
    render "$DEPLOY_DIR/systemd/saudade-rust.service.template" \
        "__APP_DIR__=$APP_DIR" "<你的用户名>=$APP_USER" | put_root /etc/systemd/system/saudade-rust.service 644
    render "$DEPLOY_DIR/systemd/saudade-agent.service.template" \
        "__APP_DIR__=$APP_DIR" "<你的用户名>=$APP_USER" | put_root /etc/systemd/system/saudade-agent.service 644

    if [ "$DRY_RUN" = 1 ]; then
        note "[dry-run] 不跑 daemon-reload / enable / start"
        return 0
    fi
    run_sudo systemctl daemon-reload
    if have systemd-analyze; then
        # 只验语法：User / WorkingDirectory / ExecStart 三者必须自洽
        systemd-analyze verify /etc/systemd/system/saudade-rust.service 2>&1 | sed 's/^/      /' || true
    fi
    ok "单元已就位（日志追加到 $APP_DIR/logs/…）"
    note "rust 靠 dotenv() 读**工作目录**下的 .env，agent 靠 pydantic 读自己的 .env ——"
    note "两个单元的取值来源不同，**不要**把它们改成同一个样子。"
    note "agent 的完整启动命令就是它的 ExecStart（--workers 4；每加一个 worker 按 +130 MiB 估上界）。"
}

# ═══════════════════════════════════════════════════════════════════════════════
# 10. logrotate + 心跳 cron
# ═══════════════════════════════════════════════════════════════════════════════
setup_logrotate() {
    step "logrotate 与心跳探针"
    render "$DEPLOY_DIR/logrotate/saudade.template" \
        "__APP_DIR__=$APP_DIR" "<你的用户名>=$APP_USER" | put_root /etc/logrotate.d/saudade 644
    if [ "$DRY_RUN" != 1 ]; then
        $SUDO logrotate -d /etc/logrotate.d/saudade 2>&1 | tail -3 | sed 's/^/      /' || true
    fi
    ok "logrotate（daily / rotate 14 / compress / copytruncate）"
    warn "日志文件的**属主必须是 $APP_USER**，否则 logrotate 的 su 一行会让它静默跳过轮转。"
    note "trace 刻意不在 logrotate 里：它是「一次会话一个文件」的一次性产物，"
    note "而 rotate N 靠同名文件后缀计数 —— 对它无效。保留期由 agent 仓的 trace_retention.py 执行。"

    local line="* * * * * PROJECT_DIR=$APP_DIR $APP_DIR/scripts/healthcheck.sh >/dev/null 2>&1"
    if [ "$DRY_RUN" = 1 ]; then
        note "[dry-run] crontab 会加：$line"
        return 0
    fi
    if crontab -l 2>/dev/null | grep -qF "$APP_DIR/scripts/healthcheck.sh"; then
        say "心跳 cron 已经在 crontab 里了"
    else
        { crontab -l 2>/dev/null || true; printf '%s\n' "$line"; } | crontab -
        ok "心跳 cron 已加（每分钟；只写 logs/health.log，**不发通知**）"
        note "PROJECT_DIR= 不能省：healthcheck.sh 的默认值绑的是别人的机器路径。"
        note "告警投递要自己接 —— 这是已知缺口。"
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# 11. 起服务 + 验收
# ═══════════════════════════════════════════════════════════════════════════════
start_services() {
    step "起服务"
    if [ "$DRY_RUN" = 1 ]; then note "[dry-run] 不做 enable / restart"; return 0; fi
    run_sudo systemctl enable saudade-rust saudade-agent >/dev/null 2>&1 || true
    run_sudo systemctl restart saudade-rust
    run_sudo systemctl restart saudade-agent
    say "等 agent 起来（worker 要 import 一堆东西）…"
    sleep 10
    ok "已拉起"
}

verify() {
    step "验收"
    if [ "$DRY_RUN" = 1 ]; then note "[dry-run] 不做探针"; return 0; fi
    local rc=0 code health

    # ① Rust：/api/login 是 POST，GET 拿到 405 就说明路由在、进程在应答
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:3000/api/login || echo 000)"
    if [ "$code" = "405" ] || [ "$code" = "200" ]; then
        ok "Rust 后端 :3000（HTTP $code）"
    else
        warn "Rust 后端没应答（HTTP $code）→ systemctl status saudade-rust / $APP_DIR/logs/rust.log"
        rc=1
    fi

    # ② agent：要的是"真正 ready"，不是"进程在"
    health="$(curl -s -m 5 http://127.0.0.1:8010/health || true)"
    case "$health" in
        *'"agent_ready":true'*|*'"agent_ready": true'*) ok "agent :8010 ready" ;;
        "") warn "agent 没应答 → systemctl status saudade-agent / $APP_DIR/logs/agent/agent.log"; rc=1 ;;
        *)  warn "agent 在应答但没 ready：$health"; rc=1 ;;
    esac

    # ③ 过 nginx 的整链路
    code="$(curl -sk -o /dev/null -w '%{http_code}' -m 5 https://127.0.0.1/ || echo 000)"
    if [ "$code" = "200" ]; then ok "过 nginx 的整链路（首页 200）"
    else warn "nginx 那一段没通（HTTP $code）"; rc=1; fi

    # ④ 前端产物
    if [ -f "$APP_DIR/frontend/dist/index.html" ]; then ok "dist 就位"
    else warn "frontend/dist/index.html 不在"; rc=1; fi

    if [ "$rc" = 0 ]; then
        printf '\n   下一步：用 %s%s%s 登录 /dashboard 发一篇文章，再去首页跟看板娘说句话——\n' \
            "$C_B" "$ADMIN_USER" "$C_0" >&2
        say "对话走 nginx → Rust(3000) → agent(8010) → 模型 API，它是整条链路的最终验收。"
        say "口令在 $CRED_FILE。对话没反应时按 docs/deployment-and-ops.md §6 的排查表走。"
    else
        warn "有几项没通过（上面标了 ⚠️）。脚本没有回滚，配置都在原地，改完重跑即可。"
        note "按症状先看 logs/rust.log、logs/agent/agent.log、systemctl status <单元>。"
        note "agent 若是「导入期崩溃循环」（/health 空、worker 反复 respawn），"
        note "日志在 logs/agent/agent.log 而**不是** journalctl；F821 之类未定义名一眼可见。"
    fi
    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# 12. 选装件：IoT
# ═══════════════════════════════════════════════════════════════════════════════
# ⚠️ device-service 的**源码不在任何公开仓**（见 iot/device-service/README.md）。
#    所以这一节做到"能自动的最后一格"就停：EMQX、证书、nginx 三入口、两处开关、核对。
#    设备真正连得上还差那一个 service —— 最后把缺口与它的接口契约打成清单。
iot_emqx_install() {
    if have emqx || dpkg -l emqx 2>/dev/null | grep -q '^ii.*emqx'; then
        # 别用 `emqx version` 取版本：非 root 跑它会打印 "You need to be root"，
        # 而那句话落在"已装"这一行旁边，读起来像出错。
        local v
        v="$(dpkg-query -W -f='${Version}' emqx 2>/dev/null || true)"
        say "EMQX 已经装着了${v:+（包版本 $v）}"
        return 0
    fi
    say "EMQX 没装。官方两条路：加 apt 源，或下 .deb。加源那条在 Ubuntu 24.04 上实测 404"
    say "（repos.emqx.io 上没有 noble 的 Release 文件），所以这里走 deb。"

    local os_id="" os_ver="" url
    if [ -r /etc/os-release ]; then . /etc/os-release; os_id="${ID:-}"; os_ver="${VERSION_ID:-}"; fi
    if [ "$os_id" != "ubuntu" ]; then
        warn "只内置了 Ubuntu 的下载地址（当前是 ${os_id:-认不出来的发行版}）。自己去 emqx.com 下："
        note "sudo dpkg -i emqx-<版本>-<发行版>-<架构>.deb && sudo systemctl enable --now emqx"
        note "装好之后原样重跑：bash deploy/install.sh --iot-only"
        return 1
    fi
    if [ -z "$os_ver" ]; then
        warn "读不出 VERSION_ID，自己下 .deb 装好，再重跑 --iot-only"
        return 1
    fi

    url="https://www.emqx.com/en/downloads/broker/$EMQX_VERSION/emqx-$EMQX_VERSION-ubuntu$os_ver-$(dpkg --print-architecture).deb"
    say "$url"
    note "（302 到 packages.emqx.io —— 这是 EMQX 官方发布地址，不是第三方镜像）"
    if [ "$DRY_RUN" = 1 ]; then note "[dry-run] 不下载、不安装"; return 0; fi
    if ! confirm "下载并安装它吗？"; then
        warn "跳过 EMQX —— 后面 IoT 那几步会跟着跳过"
        return 1
    fi

    local deb
    deb="$(mktemp --suffix=.deb)"
    if ! curl -fL --retry 3 -o "$deb" "$url"; then
        rm -f "$deb"
        warn "下载失败。自己装了之后重跑 --iot-only"
        return 1
    fi
    run_sudo apt-get install -y "$deb"
    rm -f "$deb"
    ok "EMQX $EMQX_VERSION 已安装"
}

render_emqx() {
    render "$APP_DIR/iot/emqx/emqx.conf.template" \
        "<改成随机串，openssl rand -hex 16>=$(rand_hex 16)" \
        "<你的证书链>=$CERT_NAME" \
        "<你的域名>=$CERT_NAME"
}

setup_iot() {
    step "选装件：物联网平台（iot/README.md）"
    say "它**不是一个开关控制一切**：同一个 IOT_ENABLED 在**三处各读各的**，值必须同档。"
    note "① nginx 那个 snippet 在不在  ② 父仓 .env  ③ agent 仓 .env"
    note "只改一处的后果是**不报错**：agent 高高兴兴带你跳一个 404，或者页面在、agent 却说没有。"
    note "真值集是 1/true/yes/on；**不设变量 = 没装**（别写 =0）。"

    local emqx_ok=1
    iot_emqx_install || emqx_ok=0

    if [ "$emqx_ok" = 1 ]; then
        step "EMQX：配置、证书、认证链"
        render_emqx | put_root /etc/emqx/emqx.conf 644
        run_sudo mkdir -p /etc/emqx/certs
        run_sudo cp "/etc/nginx/ssl/$CERT_NAME.crt" "/etc/emqx/certs/$CERT_NAME.crt"
        run_sudo cp "/etc/nginx/ssl/$CERT_NAME.key" "/etc/emqx/certs/$CERT_NAME.key"
        if [ "$DRY_RUN" != 1 ]; then
            $SUDO chown emqx:emqx /etc/emqx/certs/* 2>/dev/null || warn "chown emqx 失败（emqx 用户建出来了吗）"
            $SUDO chmod 640 "/etc/emqx/certs/$CERT_NAME.key" || true
        fi
        ok "emqx.conf 与证书就位（8883 与 443 **同一份证书**，续期要两处同步）"
        warn "EMQX 要自己补 systemd drop-in 的**内存上限**（MemoryHigh=384M / MemoryMax=512M）："
        warn "    sudo systemctl edit emqx      # 见 docs/deployment-and-ops.md §3"
        warn "没有上限时它会在 broker 压力下一路涨到把整机拖垮，而它只是个可选件。"

        run_sudo systemctl enable emqx >/dev/null 2>&1 || true
        run_sudo systemctl restart emqx
        say "等 broker 起来…"
        if [ "$DRY_RUN" != 1 ]; then
            sleep 8
            # configure_emqx.py 幂等、纯 REST、不打印任何密钥。
            # 口令走 env（不进 argv）；API Key 与轮换后的口令落 iot/emqx/.admin_creds（0600，已 gitignore）。
            # 已经有 .api_key 时它压根不需要管理员口令 —— 那是"从没配过"才要的。
            if ( cd "$APP_DIR" && EMQX_ADMIN_PASS="$EMQX_ADMIN_PASS" BLOG_ENV="$APP_DIR/.env" \
                 python3 iot/emqx/configure_emqx.py ); then
                ok "认证链（jwt + http→device-service）与 ACL 已配置"
                warn "ACL 规则是**全量替换**语义：那个脚本会先清空再写入全部规则，别指望"只加一条"。"
            else
                warn "configure_emqx.py 没过 —— 设备接入那一段现在是断的（网页侧不受影响）"
                warn "先确认 emqx 在跑、dashboard 口令对不对，再单跑一次那个脚本。"
            fi
        fi
    fi

    step "nginx 三个入口与两处开关"
    # 再渲染一次站点配置。--iot-only 那趟上面根本没有渲染过，这里是唯一一次；
    # 全量跑这一趟是**幂等的重复**（第 9 步渲染时就带了 --with-iot），留着图的是
    # "选了 IoT 就必定有一份带 include 的站点配置"这件事不依赖调用顺序。
    setup_nginx
    if [ "$DRY_RUN" != 1 ]; then
        run_in "$APP_DIR" ./iot/toggle.sh on
        ok "snippet 已渲染 + nginx -t + reload"
    fi

    setup_env          # 两处 IOT_ENABLED —— 「三处同源」里最容易漏的那两处
    if [ "$DRY_RUN" != 1 ]; then
        run_sudo systemctl restart saudade-rust
        run_sudo systemctl restart saudade-agent
        sleep 8
    fi

    step "核对与缺口"
    if [ "$DRY_RUN" = 1 ]; then note "[dry-run] 不跑 iot/status.sh"; return 0; fi
    run_in "$APP_DIR" ./iot/status.sh || true

    cat >&2 <<EOF

   ${C_Y}⚠️ 还差一步：device-service${C_0}
     它的**源码不在本仓、也没有单独的公开仓**，所以这条谁都得自己补。
     缺了它：/device-console/ 与 /mqtt 两条能通，第三条（/device-api/，以及设备接入时
     EMQX 的 HTTP 认证回调）没有后端 ⇒ **设备连不上 8883、控制台读不到设备列表**。

     要补的接口契约写在 iot/device-service/README.md，一句话版：
       · 读 svc.env（监听 127.0.0.1:3100、SQLite 路径、连本机 EMQX 的内部账号）
         —— 生成它：DEVICE_DIR=<它的目录> python3 iot/device-service/gen_svc_env.py
       · 还要能读到博客 .env 里的 JWT_SECRET（路径走 BLOG_ENV，别写死）
       · 对外提供 POST /api/devices/auth，{"username","device_id",…,"password"} → 200 放行
     有了源码之后：构建 → 落地 → systemctl enable --now saudade-device
     设备侧固件骨架在 iot/firmware/（真相源在另一个仓 BigLeopardCat/ESP32-S3-OBC）。

   ${C_Y}⚠️ 公网面${C_0}：多了一个 TCP **8883** 要放行（设备直连，不经 nginx）。
     其余三个端口（1883 / 8083 / 18083）一律绑回环，公网入口只走 nginx 一处。
     安全组没开 8883 的症状是「控制台一切正常、设备永远连不上」。
EOF
}

# ═══════════════════════════════════════════════════════════════════════════════
# main
# ═══════════════════════════════════════════════════════════════════════════════
main() {
    printf '%s\n' "${C_B}Saudade Blog —— 从零部署${C_0}" >&2
    printf '   部署根目录 %s\n' "$APP_DIR" >&2
    if [ "$DRY_RUN" = 1 ]; then
        printf '   %sdry-run：渲染产物落在 %s，不碰系统%s\n' "$C_Y" "$STAGE" "$C_0" >&2
    fi

    preflight

    if [ "$IOT_ONLY" = 1 ]; then
        say "--iot-only：跳过站点那一段，只补 IoT"
    else
        collect
        setup_dirs
        setup_database
        setup_env
        setup_venv
        build
        setup_tls
        setup_nginx
        setup_systemd
        setup_logrotate
        start_services
        verify
    fi

    if [ "$WITH_IOT" = 1 ]; then setup_iot; fi

    step "完成"
    if [ "$DRY_RUN" = 1 ]; then
        say "dry-run 结束，系统一个字节没改。渲染产物在：$STAGE"
        say "对照线上：diff -u /etc/nginx/sites-enabled/blog $STAGE/etc/nginx/sites-available/blog"
    else
        say "凭据：$CRED_FILE（0600）"
        say "排障：docs/deployment-and-ops.md §6；IoT 体检：./iot/status.sh"
        say "更新：父仓走 CI（push → 构建 → 部署 → 重启）；agent 仓是 git pull + systemctl restart。"
        say "只改文档/测试的 push 会**绿灯但什么都没部署** —— 判据只认 build-info.json 里的 sha。"
    fi
}

main "$@"

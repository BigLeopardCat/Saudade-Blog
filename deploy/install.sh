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
#   1. **幂等**。重跑安全，但"安全"的含义要说准（20261007 修订，此前这里写的是
#      "已有 .env 只补缺键、绝不覆盖"，那半句就是下面那条 bug 的温床）：
#        · `.env` 分两种情况：**这次刚由本脚本从 `.env.example` 创建** ⇒ 生成的值
#          一律**顶掉**模板里那些占位说明（`DATABASE_URL=…改成你的密码…` 之类）；
#          **本来就在** ⇒ 只补缺键、绝不覆盖你改过的值。
#        · 口令与 `JWT_SECRET` **从 `.credentials` 沿用**，不再每次重掷 —— 库里那份
#          口令不会被 `ALTER USER` 改走、`.env` 里的 `DATABASE_URL` 也不会与它错位
#          （重掷 = 把一台跑着的机器锁在门外，而凭据文件还写着新口令）。
#        · 库里已经有表 ⇒ 跳过建库，但**把迁移台账摆出来**（见 setup_database / db_state_report）：
#          表数、`migration_flags` 里有多少行标记、最新一条是什么。**这个脚本刻意不判"建全了没有"**
#          —— 判据（哪些文件该跑、快照日期）住在 scripts/migration/fresh_install.sh 里，在
#          这里另抄一份就等于造一台假红机器；它只保证"你**看得见**自己接手的是个什么样的库"。
#      配置一律"渲染 → 语法自检 → 替换"。
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
        # **同目录临时文件 + mv**，不是 `tee` 就地写（20261007）：
        # 就地写的窗口里目标文件是半截内容 —— 而这里的读者是**另一个进程**（nginx 收到
        # reload 就去 parse、systemd 起来就去读单元），一次读取撞进那个窗口是什么样全看
        # 运气：`nginx -t` 报一个莫名其妙的行号、或者 `logrotate` 少一条规则。
        # 同目录是必须的（跨文件系统 rename 会退化成复制，又变回非原子）；临时文件带点号
        # 前缀，所以即使这脚本半途被杀留下一个，nginx 的 `conf.d/*.conf`、systemd 的
        # `*.service`、logrotate 的目录扫描都不会认它。
        local tmp="$dest.tmp.$$"
        $SUDO mkdir -p "$(dirname "$dest")"
        if ! $SUDO tee "$tmp" >/dev/null; then
            $SUDO rm -f "$tmp"
            die "写 $tmp 失败（内容没有落到 $dest 上，原文件未动）"
        fi
        $SUDO chmod "$mode" "$tmp"
        $SUDO mv -f "$tmp" "$dest"
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
    local var=$1 prompt=$2 def=${3:-} gen=${4:-} val hint
    val="${!var}"
    # 回车的后果有三种，**必须分开说**（此前一律写"留空 = 随机生成"）：
    # 对 `LLM_API_KEY` 那样的可选密钥，回车是"先不配"，不是"给我生成一个假的"——
    # 写错的后果是有人以为随便按了回车就配好了。
    if   [ -n "$gen" ]; then hint="留空 = 随机生成"
    elif [ -n "$def" ]; then hint="留空 = 用默认值"
    else                     hint="留空 = 先不配"; fi
    if [ -z "$val" ] && [ "$ASSUME_YES" = 0 ]; then
        [ "$HAVE_TTY" = 1 ] || die "$var 没有值（用 --yes 或直接给参数）"
        printf '   %s（不回显；%s）: ' "$prompt" "$hint" >&2
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
# ⚠️ `add_env_if_missing` 的语义是"**完全没有这个键**才写"，它挡不住本仓模板里那一类
#    占位值：`.env.example` 里 `DATABASE_URL=mysql://saudade_blog:改成你的密码@…` 是
#    **未注释**的（为了让照着 example 手改的人一眼看见要改哪一行），于是键在、值是中文
#    占位说明 —— 安装器生成的真口令被它挡在门外，而 `verify()` 照样全绿（20261007 实测：
#    后端连不上库、JWT_SECRET 是公开模板里那句话、agent 的只读工具全指着 `<你的域名>`）。
#    修法是把"这份 .env 是不是**这次刚由我们从模板复制出来的**"这个事实带进写入：
#      fresh = 刚 cp 出来的 ⇒ 生成的值**顶掉**模板里的占位（set_env）
#      keep  = 本来就在     ⇒ 只补缺键（add_env_if_missing）
#    判据（deploy/docker/check.sh 的第 ⑧ 节会真跑一遍）：全新 clone 下 setup_env 的产物里
#    不许留下任何一份 `.env.example` 的占位值。
put_env() {   # put_env <fresh|keep> <文件> <键> <值>
    case "$1" in
        fresh) set_env "$2" "$3" "$4" ;;
        keep)  add_env_if_missing "$2" "$3" "$4" ;;
        *)     die "put_env: 第一个参数只能是 fresh 或 keep（收到 $1）" ;;
    esac
}

rand_hex() { openssl rand -hex "${1:-32}"; }
rand_pw()  { openssl rand -hex "${1:-16}"; }   # 纯 hex ⇒ 一定不含空格/引号/#，可安全进 .env

# ── 连接串里的 userinfo 必须转义 ───────────────────────────────────────────────
# 口令是本脚本生成的（纯 hex，安全），但 `DB_PASS=... ` 可以由用户给（`--db-pass` /
# 环境变量），而 `mysql://账号:口令@主机:端口/库` 这个形状里，口令中的 `@ : / ? # %`
# 每一个都能把连接串切到别的意思上 —— 症状是后端连不上、或连到一个"看起来对"的错库，
# 而且驱动报的错五花八门。转义后 raw 值照旧进 `.credentials` 与 SQL（那两处要原文），
# **只有拼进 URL 的那一次**走它。按 RFC 3986 的 unreserved 集合放行，其余逐字节转义。
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

# ── 从 .credentials 取回上一次生成的值 ────────────────────────────────────────
# 这是**口令的唯一记录**（库里那份是单向哈希，取不回来）。重跑时靠它沿用口令与
# JWT_SECRET：重新掷一次的话，`ALTER USER` 会把库里那份改成新值、而已经写好的
# `.env` 里的 `DATABASE_URL` 还指着旧的（只补缺键、不覆盖）⇒ 一台本来跑得好好的
# 机器被自己的安装脚本锁在门外，且凭据文件上写着的是一个当时还没生效的新口令。
# 取不到（首次部署 / 文件被删）就返回空 ⇒ 上层照旧随机生成。
read_cred() {
    [ -f "$CRED_FILE" ] || return 0
    awk -v k="$1" '{ if ($1 == k) { sub(/^[^ \t]+[ \t]+/, ""); print; exit } }' "$CRED_FILE"
}

# 从 .env 里读一个键的**当前值**（只认未注释的那一行）。没有/被注释 ⇒ 打印空。
# 只用在"要不要说'已经在用了'这种结论上"——写不写由 set_env/add_env_if_missing 决定。
read_env() {
    [ -f "$1" ] || return 0
    awk -v k="$2" '$0 ~ "^[[:space:]]*"k"=" { sub(/^[^=]*=/, ""); print; exit }' "$1"
}

# ── 渲染模板 ──────────────────────────────────────────────────────────────────
# `esc` / `render` / `render_nginx` 都住在 deploy/nginx/render.sh —— 那是**唯一实现**，
# Docker 那条安装路的宿主侧脚本（deploy/docker/prepare.sh）source 的也是同一份，只是把
# APP_DIR 传成容器里的 /srv。别把函数体抄回来：抄回来的那一刻，「按结构标记切掉乙块」的
# awk 就有两个版本了（症状是 nginx -t 失败，或者静默留着 <你的域名> 占位符）。
# 这里只负责 source，输入全靠上面的变量。
# 判据：`bash deploy/docker/prepare.sh --print blog.conf --domain X` 与
#       `APP_DIR=/srv bash deploy/install.sh --dry-run -y --domain X` 的产物**逐字节相同**
#       —— 那条断言在 deploy/docker/check.sh 里，本机无 docker 也跑得动。
source "$DEPLOY_DIR/nginx/render.sh"

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

# ── 参数解析**之前**的那几个值（20261007 加）────────────────────────────────────
# 用来区分"用户这次显式给的值"与"代码里的默认值"：`LLM_PROVIDER` / `ADMIN_USER` 这类
# 键**两者都非空**，光看当前值是分不出来的，而重跑时这个区分决定"要不要沿用上一趟的
# `.credentials`"。默认值变了（或用户给了 flag/env）就说明是显式的。
ORIG_LLM_PROVIDER="$LLM_PROVIDER"
ORIG_ADMIN_USER="$ADMIN_USER"

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

    # **跑这个脚本的人**与**跑服务的用户**必须是同一个（20261007 加）。
    # 这一条看起来像洁癖，其实是下面四处权限的同一个根：`.env` 落成 0600、`logs/` 落成
    # 0700、上传件目录、logrotate 模板里的 `su $APP_USER` —— 它们都只写"谁属主"，不 chown。
    # 于是"以 A 跑安装、以 B 跑服务"这件事的后果是**四处的静默失败**，而且一处都不报错：
    #   · Rust 的 dotenv() 读不到 0600 的 .env ⇒ 起来了但连不上库，登录一路 500；
    #   · `logs/rust.log` / `logs/agent/agent.log` 写不进去（systemd 的 append 会失败）；
    #   · logrotate 的 `su` 一行不匹配 ⇒ 日志**静默地不轮转**（配置看着没问题）；
    #   · 上传接口能 200 但文件是别人写的，下一次安装建目录时撞权限。
    # 修法只有"换个人跑"，或者把 --app-user 给成当前用户 —— 两条路都写在这儿。
    if [ "$DRY_RUN" != 1 ] && [ "$APP_USER" != "$(id -un)" ]; then
        die "跑这个脚本的是 $(id -un)，而服务要用的用户是 $APP_USER。二者不一致时
    .env(0600)/logs(0700)/上传件目录的属主都是 $(id -un)，服务那边读不到、写不进，
    而且**四种失败都不报错**（读不到 .env 就是连不上库、日志静默不轮转）。
    两条出路：① 换成那个用户重跑（sudo -u $APP_USER -H bash $DEPLOY_DIR/install.sh …）；
    ② 就让服务用当前用户跑：--app-user $(id -un)。"
    fi
    if [ "$DRY_RUN" = 1 ] && [ "$APP_USER" != "$(id -un)" ]; then
        warn "dry-run：服务用户($APP_USER)与当前用户($(id -un))不一致 —— 真跑会在这里停下"
    fi

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

    # ══ 先把上一趟的值取回来，再问 ══════════════════════════════════════════════
    # 判据一律是"**这次显式给了就听你的，没给就沿用 `.credentials`**"（20261007）。
    # 在此之前这里是从头掷一遍：`ALTER USER` 把库里那份口令改成新的，而 `.env` 里
    # （只补缺键、不覆盖）的 `DATABASE_URL` 还指着旧的 ⇒ 一台跑得好好的机器被自己的
    # 安装脚本锁在门外；`write_creds` 又把凭据文件**截断重写**，于是连"旧口令是多少"
    # 这个唯一的记录也没了。首次部署没有 `.credentials` ⇒ 取到的全是空 ⇒ 行为与从前
    # 逐字相同。
    local cred_url cred_domain cred_prov cred_v
    cred_url="$(read_cred 站点地址)"
    case "$cred_url" in
        # 只认 https://…：`http://<ip>` 是"只有 IP、没有域名"那种形态，把 IP 当域名
        # 填回来会让重跑悄悄把站点从 http 升成 https（自签证书配上 https 的 IP）。
        https://*) cred_domain="${cred_url#https://}"; cred_domain="${cred_domain%%/*}" ;;
        *)         cred_domain="" ;;
    esac

    ask DOMAIN "站点域名（裸域名，不带 https://；没有域名就直接回车）" "$cred_domain"
    if [ -z "$SITE_URL" ]; then
        if [ -n "$DOMAIN" ]; then
            SITE_URL="https://$DOMAIN"
        else
            SITE_URL="http://$(hostname -I 2>/dev/null | awk '{print $1}')"
        fi
    fi
    if [ -z "$SITE_URL" ]; then die "站点地址推不出来，用 --site-url 显式给一个"; fi
    ask UPLOAD_DIR "上传件目录（生产建议放在工作区之外）" "$HOME/saudade-uploads"

    # 口令与 JWT_SECRET：**只在这次没给的时候**沿用上一趟 .credentials 里那份。
    # `--db-pass` / 环境变量给了就用给的（那正是"我要换口令"的表达方式）。
    ask DB_USER "数据库应用账号"
    cred_v="$(read_cred 数据库口令)";   [ -n "$DB_PASS" ]    || DB_PASS="$cred_v"
    cred_v="$(read_cred JWT_SECRET)";   [ -n "$JWT_SECRET" ] || JWT_SECRET="$cred_v"
    cred_v="$(read_cred 管理员口令)";   [ -n "$ADMIN_PASS" ] || ADMIN_PASS="$cred_v"
    cred_v="$(read_cred 管理员账号)";   [ -n "$cred_v" ] && [ "$ADMIN_USER" = "$ORIG_ADMIN_USER" ] \
                                        && ADMIN_USER="$cred_v"
    ask_secret DB_PASS "应用账号的口令" "" "rand_pw 16"
    ask_secret JWT_SECRET "JWT_SECRET（两份 .env 共用；换掉 = 所有人重新登录）" "" "rand_hex 32"
    ask ADMIN_USER "第一个管理员的用户名"
    ask ADMIN_NICK "它的昵称"
    ask_secret ADMIN_PASS "它的口令" "" "rand_pw 12"

    say ""
    say "看板娘用的模型服务商（agent 读它自己那份 .env）"
    # 沿用同样只在"这次没显式给"时发生 —— 不沿用的话，重跑会把上一趟选的 qwen
    # 悄悄改回代码默认的 deepseek（下面 setup_env 对提供方那一行是 set_env，写死）。
    cred_prov="$(read_cred 模型提供方)"
    if [ -n "$cred_prov" ] && [ "$LLM_PROVIDER" = "$ORIG_LLM_PROVIDER" ]; then
        LLM_PROVIDER="$cred_prov"
        say "提供方沿用上一趟的：$LLM_PROVIDER（要换：--provider X 加 --llm-key Y）"
    fi
    ask LLM_PROVIDER "提供方（deepseek|qwen|openai）"
    # **不回显**：API Key 与口令是同一类东西，此前它是用 `ask` 问的（明文打在屏幕上，
    # 而且有人会把屏幕截图贴进 issue）。
    ask_secret LLM_API_KEY "API Key（留空 = 先不配：其余功能都正常，只有看板娘不会答话）"
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
        printf '# 生成时间 %s（重跑会沿用上一趟的口令与 JWT_SECRET，本文件随之更新）\n\n' "$(date '+%F %T')"
        printf '站点地址     %s\n' "$SITE_URL"
        printf '管理员账号   %s\n' "$ADMIN_USER"
        printf '管理员口令   %s\n' "$ADMIN_PASS"
        printf '模型提供方   %s\n' "$LLM_PROVIDER"
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
        say "          建 $DB_USER@'localhost' 与 @'127.0.0.1' 并授权；INSERT 一个 role=admin 的账号。"
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
        db_state_report
    else
        say "从零建库（基架快照 + 快照之后的迁移）…"
        # ⚠️ 迁移文件里绝大多数写死了 `USE saudade_blog;`，所以库名必须叫这个。
        #    脚本默认拒收这个名字（防在生产机上打错字），所以要显式声明一次。
        #    MYSQL_BIN 用多词前缀把 --defaults-extra-file 顶到第一个参数位 ⇒ 口令不进 argv。
        MYSQL_BIN="mysql --defaults-extra-file=$MYSQL_CNF" ALLOW_PRODUCTION_NAME=1 \
            bash "$APP_DIR/scripts/migration/fresh_install.sh" "$DB_NAME" 2>&1 | sed 's/^/      /'
        ok "建库完成"
    fi

    # 应用账号建在**两个 host** 上（20261007）。连接串写的是 `127.0.0.1`，而 MySQL 认不认
    # 得上 `@'localhost'`，取决于它有没有做反向名字解析：`skip_name_resolve` 关着（默认）
    # 时 127.0.0.1 会被解析成 localhost，打开时就不会 —— 而打开它是很多"MySQL 加固清单"
    # 的第一条，关我什么事都不问就把一个跑得好好的站点打死（症状：
    # `Access denied for user 'saudade_blog'@'127.0.0.1'`，而账号在库里明明有）。
    # 两条都建、都授权，就不依赖那个开关了：多一行记录，换掉一整类"改了配置就登不上"。
    local host
    for host in localhost 127.0.0.1; do
        printf "CREATE USER IF NOT EXISTS '%s'@'%s' IDENTIFIED BY '%s';\n\
ALTER USER '%s'@'%s' IDENTIFIED BY '%s';\n\
GRANT ALL PRIVILEGES ON \`%s\`.* TO '%s'@'%s';\nFLUSH PRIVILEGES;\n" \
            "$(sql_quote "$DB_USER")" "$host" "$(sql_quote "$DB_PASS")" \
            "$(sql_quote "$DB_USER")" "$host" "$(sql_quote "$DB_PASS")" \
            "$(sql_quote "$DB_NAME")" "$(sql_quote "$DB_USER")" "$host" | mysql_root \
            || die "建/改 $DB_USER@'$host' 失败（上面的 SQL 报错就是原因）"
        say "应用账号 $DB_USER@'$host'"
    done
    ok "账号就绪（口令与 .env 里的 DATABASE_URL 一致）"

    admin_account
}

# 库里"已经有表"**不等于**"建全了"：这一步把能看见的都摆出来（20261007）。
# ⚠️ 它**不下结论**，这是刻意的 —— 一个"完整性判据"需要知道"从零建库会跑哪些迁移"，
#    而那套筛选规则（快照日 + 夹具名单 + 强制补跑名单）住在 `scripts/migration/
#    fresh_install.sh` 里。在这里抄一份过来就会各漂各的，抄不准的版本则会把快照日之前
#    的几十份迁移全判成"缺失"（它们的标记本来就不在库里）—— 那是一条**假红机器**。
#    所以这里只报事实：库里有几个标记、最长的那个叫什么、有没有那张表。
db_state_report() {
    local flags
    flags="$(printf 'SELECT flag_name FROM migration_flags ORDER BY applied_at;\n' \
             | mysql_root -N -B "$DB_NAME" 2>/dev/null || true)"
    if [ -z "$flags" ]; then
        warn "库里没有 migration_flags 表（或一行标记都没有）—— 这个库不是这几份迁移建出来的"
        note "完整性核不了。把它当「新库的基线」之前，先确认它到底是谁建的。"
    else
        say "迁移标记 $(printf '%s\n' "$flags" | wc -l | tr -d ' ') 个，最近的是 $(printf '%s\n' "$flags" | tail -1)"
        note "对照 scripts/migration/：文件名带 _YYYYMMDD 的那些里，日期**晚于**快照日"
        note "（fresh_install.sh 头注的 SNAPSHOT）的都该有对应标记。少一个就是那次迁移没跑成。"
        note "本脚本不做迁移 —— 缺的那几份要手工补（剥掉文件开头的 USE 行再执行）。"
    fi
}

# 第一个管理员。两件事都属于"错了就静默"，所以都在这儿说清楚：
#   · 用户名撞 `user.username` 的唯一键 ⇒ MySQL 甩一句 `Duplicate entry` 然后脚本中止，
#     报错指向 SQL，读起来像是脚本坏了；
#   · 库里**早就有**这个管理员 ⇒ 这次不会改它的口令，而 `.credentials` 是截断重写的
#     ⇒ 文件里那一行变成"这次想用的口令"而不是"能登进去的口令"。这种错必须当场说。
admin_account() {
    local cnt dupe
    cnt="$(printf 'SELECT COUNT(*) FROM `user` WHERE role=%s;\n' "'admin'" | mysql_root -N -B "$DB_NAME")"
    if [ "$cnt" != "0" ]; then
        say "库里已经有 $cnt 个管理员 —— 不再建（要加人自己 INSERT，本项目没有注册入口）"
        cred_honesty_check || true
        return 0
    fi

    dupe="$(printf 'SELECT id, username, role FROM `user` WHERE username=%s LIMIT 1;\n' \
            "'$(sql_quote "$ADMIN_USER")'" | mysql_root -N -B "$DB_NAME")"
    if [ -n "$dupe" ]; then
        die "库里已经有同名账号（id 账号 角色 = $dupe），而它不是 role=admin。
    本项目没有注册入口，加人只能 INSERT —— 所以这里先拦一道，不让它变成一句
    'Duplicate entry' 的 SQL 报错。两条出路：
      ① 换个用户名重跑：--admin-user 别的名字；
      ② 就是它的话，把角色改过来：
         UPDATE \`user\` SET role='admin' WHERE username='$(sql_quote "$ADMIN_USER")';"
    fi

    # 无盐单轮 SHA-256 是**旧格式**；verify_password 认它，并在首次登录成功后
    # 就地升级成 Argon2id。这条 INSERT 是"手上只有 mysql 客户端"时最省事的路径。
    printf "INSERT INTO \`user\` (username, nickname, password, role)\n\
VALUES ('%s', '%s', SHA2('%s', 256), 'admin');\n" \
        "$(sql_quote "$ADMIN_USER")" "$(sql_quote "$ADMIN_NICK")" "$(sql_quote "$ADMIN_PASS")" \
        | mysql_root "$DB_NAME" || die "第一个管理员没建进去（上面的 SQL 报错就是原因）"
    ok "第一个管理员 $ADMIN_USER 已建（**role=admin 才能进 /dashboard**）"
    note "口令在 $CRED_FILE 里；首次登录成功后库里那一行会自动升级成 Argon2id。"
}

# 凭据文件里那份管理员口令**真的能登进去吗**。
# 库里存的是单向哈希，所以只对两种情形能给出确定答案：
#   · 旧格式（无盐单轮 SHA-256）⇒ 当场算一遍对得上就是对的；
#   · Argon2id（20260917 起的格式，随机盐）⇒ **判不了**，如实说判不了。
# 判不了就说判不了 —— 这一条的失败样式是"用户照着文件登录、失败，然后去怀疑脚本"。
cred_honesty_check() {
    local pw want
    pw="$(printf 'SELECT password FROM `user` WHERE username=%s LIMIT 1;\n' \
          "'$(sql_quote "$ADMIN_USER")'" | mysql_root -N -B "$DB_NAME" 2>/dev/null || true)"
    if [ -z "$pw" ]; then
        warn "库里没有叫 $ADMIN_USER 的管理员 —— $CRED_FILE 里那两行（账号/口令）不对应任何账号"
        return 0
    fi
    case "$pw" in
        '$argon2'*)
            note "库里那份是 Argon2id（20260917 起；随机盐，没法在 SQL 里对）⇒"
            note "$CRED_FILE 里这一行是「这次想用的口令」，**不是**从库里读出来的；"
            note "它是不是能登进去的口令，只有登录那一下才知道。"
            ;;
        *)
            want="$(printf "SELECT SHA2('%s',256);\n" "$(sql_quote "$ADMIN_PASS")" | mysql_root -N -B)"
            if [ -n "$want" ] && [ "$pw" = "$want" ]; then
                ok "$CRED_FILE 里这份口令与库里 $ADMIN_USER 那一行对得上"
            else
                warn "$CRED_FILE 里这份口令**不等于**库里 $ADMIN_USER 那一行的口令"
                note "库里那行是先前的部署建的，这一步不改它（改口令是显式动作，见 deploy/README.md）。"
                note "要它跟着文件走：UPDATE \`user\` SET password=SHA2('<新口令>',256) WHERE username='$ADMIN_USER';"
            fi
            ;;
    esac
}

# ═══════════════════════════════════════════════════════════════════════════════
# 4. 两份 .env（不是一个文件）
# ═══════════════════════════════════════════════════════════════════════════════
setup_env() {
    step "环境变量：两份 .env，不是一个文件"
    local benv="$APP_DIR/.env" aenv="$AGENT_DIR/.env"

    if [ "$DRY_RUN" = 1 ]; then
        say "[dry-run] 父仓 .env ：$([ -f "$benv" ] && echo '存在 → 只补缺键（不动你改过的值）' \
                                                     || echo '从 .env.example 新建 → 生成的值顶掉模板里的占位说明')"
        say "[dry-run] agent .env：$([ -f "$aenv" ] && echo '存在 → 只补缺键（不动你改过的值）' \
                                                     || echo '从 .env.example 新建 → 生成的值顶掉模板里的占位说明')"
        return 0
    fi

    # ── 父仓那份（Rust 用；main.rs 的 dotenv() 读**工作目录**下的 .env）──
    local bmode amode
    if [ -f "$benv" ]; then
        bmode=keep; say "父仓 .env 已存在 —— 只补缺键，不动你的现有配置"
    else
        cp "$APP_DIR/.env.example" "$benv"; bmode=fresh
    fi
    chmod 600 "$benv"
    # 口令进 URL 之前**必须编码**：`@ : / ? # %` 在 userinfo 这一段里每一个都能把连接串
    # 切到别的意思上（生成的纯 hex 口令碰不到，但 `--db-pass` 可以是任何东西）。
    put_env "$bmode" "$benv" DATABASE_URL \
        "mysql://$(urlenc "$DB_USER"):$(urlenc "$DB_PASS")@127.0.0.1:3306/$DB_NAME"
    put_env "$bmode" "$benv" JWT_SECRET   "$JWT_SECRET"
    put_env "$bmode" "$benv" SITE_URL     "$SITE_URL"
    put_env "$bmode" "$benv" UPLOAD_DIR   "$UPLOAD_DIR"
    put_env "$bmode" "$benv" AGENT_URL    "http://127.0.0.1:8010/chat"
    put_env "$bmode" "$benv" CORS_ALLOWED_ORIGINS "$SITE_URL"
    ok "父仓 .env（$([ "$bmode" = fresh ] && echo '新建：生成的值已顶掉模板占位' || echo '沿用：只补缺键')）"

    # ── agent 那份（Python 用；config/settings.py 走 pydantic-settings）──
    if [ -f "$aenv" ]; then
        amode=keep; say "agent .env 已存在 —— 只补缺键，不动你的现有配置"
    else
        if [ ! -f "$AGENT_DIR/.env.example" ]; then
            die "找不到 $AGENT_DIR/.env.example（agent 仓克隆到位了吗）"
        fi
        cp "$AGENT_DIR/.env.example" "$aenv"; amode=fresh
    fi
    chmod 600 "$aenv"
    put_env "$amode" "$aenv" JWT_SECRET "$JWT_SECRET"
    note "两份 .env 的 JWT_SECRET **必须逐字相同**：agent 用它验 Rust 发来的身份断言。"
    put_env "$amode" "$aenv" BLOG_API_BASE "$SITE_URL/api/public"
    note "不改 BLOG_API_BASE 的话，你的看板娘会认真回答**别人博客**里的问题，而且不报错。"
    put_env "$amode" "$aenv" TRACE_DIR "$APP_DIR/logs/agent/traces"
    note "TRACE_DIR 一定显式设：代码里的默认值绑的是上游维护者的机器。"
    put_env "$amode" "$aenv" GRAPH_API_BASE "http://127.0.0.1:3000/api/public"
    ok "agent .env（$([ "$amode" = fresh ] && echo '新建：生成的值已顶掉模板占位' || echo '沿用：只补缺键')）"

    if [ "$IOT_ONLY" = 0 ]; then
        # 全新部署走这条；--iot-only 那趟不动这些（它只补 IoT 相关的键）
        local prov_key cur_key
        prov_key="$(printf '%s' "$LLM_PROVIDER" | tr '[:lower:]' '[:upper:]')_API_KEY"
        put_env "$amode" "$aenv" LLM_PROVIDER "$LLM_PROVIDER"
        cur_key="$(read_env "$aenv" "$prov_key")"
        if [ -n "$LLM_API_KEY" ]; then
            put_env "$amode" "$aenv" "$prov_key" "$LLM_API_KEY"
        elif [ -n "$cur_key" ] && [ "$cur_key" != "your-api-key-here" ]; then
            # 重跑时 LLM_API_KEY 是空的（.credentials 里刻意不记它）—— 已有的那份**没被动过**，
            # 所以这里不能报"没配"：那会把一个配好的站点说成没配。
            # ⚠️ 必须排掉模板占位串 `your-api-key-here`（`.env.example` 里那一行是**未注释**的）：
            #    不排的话，"这次刚 cp 出来的 .env 里抄着一句模板说明"会被说成"已在沿用"——
            #    那是把"没配"报成"配好了"，症状是看板娘不答话而安装器说一切就绪。
            note "沿用 .env 里已有的 $prov_key（这次没给 --llm-key，它就没被改过）"
        else
            warn "没配模型 API Key —— 站点一切正常，只有看板娘不会答话"
            note "补法：改 $aenv 里的 $prov_key，或重跑并给 --llm-key"
        fi
        # Base URL 写在**当前提供方自己的键**上（20261007 修）：此前无论选了谁都写
        # `QWEN_BASE_URL`，于是在 deepseek 上给的那个自定义地址落进一个没人读的键里，
        # 而 agent 继续用它自己那份默认端点 —— 症状是"我明明改了地址，怎么还打那个端点"。
        if [ -n "$LLM_BASE_URL" ]; then
            # 这里**故意用 set_env 而不是 put_env**（同 IOT_ENABLED 的理由）：`--llm-base-url`
            # 是显式表态，而 keep 分支"有键就不写"会让重跑时的这个参数变成一个静默空操作
            # —— 症状正是"我明明给了地址，它还是打旧端点"。已有值要保住的话，别传这个参数。
            set_env "$aenv" "$(printf '%s' "$LLM_PROVIDER" | tr '[:lower:]' '[:upper:]')_BASE_URL" "$LLM_BASE_URL"
        elif [ "$LLM_PROVIDER" != "qwen" ]; then
            note "没给 --llm-base-url ⇒ $LLM_PROVIDER 用它自己的默认端点；要换端点就补一个"
            note "（$LLM_PROVIDER 的键名是 $(printf '%s' "$LLM_PROVIDER" | tr '[:lower:]' '[:upper:]')_BASE_URL）"
        fi
        # 生产档：缺身份断言的请求直接 401。默认 0 只是为滚动上线方便，全新部署不需要。
        put_env "$amode" "$aenv" AGENT_REQUIRE_ASSERTION 1
    fi

    if [ "$WITH_IOT" = 1 ]; then
        # 这一处**不走 put_env**：`--with-iot` 是显式表态，已有的 `IOT_ENABLED=0` 也必须翻成 1
        # （keep 分支"有键就不写"在这里正好是反的 —— 会让用户明明说了装、它却还关着）。
        add_env_if_missing "$benv" IOT_ENABLED 1
        set_env "$aenv" IOT_ENABLED 1
        ok "两处 IOT_ENABLED 已置 1（父仓 + agent 仓）"
    fi

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
        local miss=0
        say "--no-build：跳过。这两样要你自己放到位："
        note "target/release/saudade_blog_bin（可执行）"
        note "frontend/dist/（就是 nginx 的 root，里面要有 index.html）"
        if [ ! -x "$APP_DIR/target/release/saudade_blog_bin" ]; then
            warn "二进制不在或不可执行：$APP_DIR/target/release/saudade_blog_bin"
            miss=1
        fi
        if [ ! -f "$APP_DIR/frontend/dist/index.html" ]; then
            warn "dist 不在或没有 index.html：$APP_DIR/frontend/dist/"
            miss=1
        fi
        if [ "$miss" = 1 ]; then
            # 从前这两条只是两行 ⚠️，而最后一步验收不看它们、脚本退出码恒 0 ⇒ 「缺产物」
            # 这件事在 CI/脚本里拦不住（--no-build 就成了一个能静默产出一个起不来的站点的开关）。
            note "这两条在**最后一步验收**里也会判红（20261007 起退出码会传出来，不再恒 0）。"
            note "--no-build 的正经用法是「在别的机器上编好再拷过来」，不是「跳过不管」。"
        else
            ok "两份产物都在 —— --no-build 的前提成立"
        fi
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
# render_nginx() 的**唯一实现**在 deploy/nginx/render.sh（本文件上面 source 的就是它）。
# 渲染走 stdout、人话走 stderr；落地那一步在 setup_nginx 里。

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
    # `enable` 不许被 `|| true` 吞掉（20261007）：它失败的样子是**开机不自启** —— 平时
    # 一点看不出来，只有机器重启后才暴露（服务全不在了），而那正是最不想排查的时刻。
    # 它会失败的情形是真实的：单元文件里引用了不存在的用户、`systemctl` 在容器里、
    # D-Bus 不可达……每一种都该当场说一句。
    if ! run_sudo systemctl enable saudade-rust saudade-agent; then
        warn "systemctl enable 失败 —— **这台机器重启后两个服务不会自己起来**"
        note "现在站点是好的（下面 restart 会拉起来），但重启之后要手工 start。"
        note "看一眼原因：systemctl status saudade-rust；enable 的报错就在那上面一行。"
    fi
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

    # ⑤ 两个单元**开机自启**了吗。上面 start_services 里 enable 失败只会打一行 ⚠️
    #    （它失败的样子平时完全看不出来 —— 机器重启之后服务全不在），所以这里再判一次：
    #    这是唯一能在重启之前就发现它的地方。
    local u enabled_ok=1
    for u in saudade-rust saudade-agent; do
        if $SUDO systemctl is-enabled --quiet "$u" 2>/dev/null; then :; else
            warn "$u 不是 enabled —— 这台机器重启后它不会自己起来"
            rc=1; enabled_ok=0
        fi
    done
    [ "$enabled_ok" = 1 ] && ok "两个单元都开机自启"

    if [ "$rc" = 0 ]; then
        printf '\n   下一步：用 %s%s%s 登录 /dashboard 发一篇文章，再去首页跟看板娘说句话——\n' \
            "$C_B" "$ADMIN_USER" "$C_0" >&2
        say "对话走 nginx → Rust(3000) → agent(8010) → 模型 API，它是整条链路的最终验收。"
        say "口令在 $CRED_FILE。对话没反应时按 docs/deployment-and-ops.md §6 的排查表走。"
    else
        warn "有几项没通过（上面标了 ⚠️）。脚本没有回滚，配置都在原地，改完重跑即可。"
        note "**本次以非 0 退出**（20261007 起；在此之前这里恒返回 0，脚本化调用看不出失败）。"
        note "按症状先看 logs/rust.log、logs/agent/agent.log、systemctl status <单元>。"
        note "agent 若是「导入期崩溃循环」（/health 空、worker 反复 respawn），"
        note "日志在 logs/agent/agent.log 而**不是** journalctl；F821 之类未定义名一眼可见。"
    fi
    return "$rc"
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
# 这台机器上的代码钉在哪个提交上（20261007 加）。排障时这是**第一个要问的问题**，
# 而它此前只存在于跑脚本那个人的 shell 历史里（多跑几次、换个人来，就没人说得清了）。
# 脏工作区也照记 —— 记的是"当时盘上是什么"，那正是"线上跑的是哪一版"的答案。
record_versions() {
    local pr ar pd ad
    pr="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || true)"
    ar="$(git -C "$AGENT_DIR" rev-parse --short HEAD 2>/dev/null || true)"
    pd="$(git -C "$APP_DIR" status --porcelain 2>/dev/null || true)"
    ad="$(git -C "$AGENT_DIR" status --porcelain 2>/dev/null || true)"
    {
        printf '装机时间 %s\n' "$(date '+%F %T %z')"
        printf '父仓     %s%s\n' "${pr:-（不是 git 工作区）}" "$([ -n "$pd" ] && echo '  ← 有未提交改动（跑的就是这些改动）')"
        printf 'agent 仓 %s%s\n' "${ar:-（不是 git 工作区）}" "$([ -n "$ad" ] && echo '  ← 有未提交改动（跑的就是这些改动）')"
        printf '站点     domain=%s site_url=%s admin=%s provider=%s\n' \
            "${DOMAIN:-（无，只有 IP）}" "$SITE_URL" "$ADMIN_USER" "$LLM_PROVIDER"
    } >>"$APP_DIR/logs/install-info.txt" 2>/dev/null || true
    say "本次钉在：父仓 ${pr:-?} / agent 仓 ${ar:-?}（记进 logs/install-info.txt）"
    [ -z "$pd$ad" ] || warn "工作区里有未提交改动 —— 上面记的就是**盘上现在这份**，不是某个干净的提交"
}

main() {
    printf '%s\n' "${C_B}Saudade Blog —— 从零部署${C_0}" >&2
    printf '   部署根目录 %s\n' "$APP_DIR" >&2
    if [ "$DRY_RUN" = 1 ]; then
        printf '   %sdry-run：渲染产物落在 %s，不碰系统%s\n' "$C_Y" "$STAGE" "$C_0" >&2
    fi

    local rc=0

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
        # 验收的退出码**必须传出来**（20261007）：它从前是 `return 0` 恒真，于是
        # 「后端没起来」「dist 不在」「两个单元没 enable」这些结论一个都传不到调用方 ——
        # 在 CI / 脚本 / 别人写的 runbook 里，这个脚本永远是"成功"。`|| rc=$?` 这一写法
        # 同时把 errexit 挡在门外：验收失败是**结论**，不是脚本本身的错误。
        verify || rc=$?
    fi

    if [ "$WITH_IOT" = 1 ]; then setup_iot; fi

    step "完成"
    if [ "$DRY_RUN" = 1 ]; then
        say "dry-run 结束，系统一个字节没改。渲染产物在：$STAGE"
        say "对照线上：diff -u /etc/nginx/sites-enabled/blog $STAGE/etc/nginx/sites-available/blog"
    else
        say "凭据：$CRED_FILE（0600）"
        record_versions
        say "排障：docs/deployment-and-ops.md §6；IoT 体检：./iot/status.sh"
        say "更新：父仓走 CI（push → 构建 → 部署 → 重启）；agent 仓是 git pull + systemctl restart。"
        say "只改文档/测试的 push 会**绿灯但什么都没部署** —— 判据只认 build-info.json 里的 sha。"
    fi

    if [ "$rc" != 0 ]; then
        printf '\n%s❌ 验收有项目没通过（见上面标 ⚠️ 的几行）—— 本次以 %d 退出。%s\n' "$C_R" "$rc" "$C_0" >&2
    fi
    return "$rc"
}

main "$@"

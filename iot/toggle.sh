#!/usr/bin/env bash
# 物联网平台（可选件）的总开关——**只负责 nginx 那一面**。
#
#   ./iot/toggle.sh on      装上：渲染 iot/nginx/iot.conf.template 到 snippet 目录并 reload
#   ./iot/toggle.sh off     卸掉：删掉渲染产物并 reload（三个入口一起消失）
#   ./iot/toggle.sh status  看看现在是什么状态（转 iot/status.sh）
#
# ⚠️ **开关不是一处**。这一个脚本只动 nginx；另外两处（Rust 读的 .env、agent 读的 .env）
# 得你自己改，脚本会在结尾把该改什么打出来，`status.sh` 会逐条核对。三处不一致的
# 典型后果是「agent 带你跳一个 404」或「页面能开但 agent 说本站没有」——都不报错。
#
# 前置（只在本机/生产服务器上跑得动）：
#   · 站点配置里已经有那行通配 include（见 iot/nginx/include-line.txt），否则本脚本
#     改了也白改——它渲染出来的文件根本没人 include。status.sh 会核对这一条。
#   · 有 sudo（写 /etc/nginx 与 reload 需要）。
set -euo pipefail

IOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$IOT_DIR/.." && pwd)"
CONSOLE_DIR="$IOT_DIR/device-console"
SNIPPET_DIR="/etc/nginx/snippets/blog-iot"
SNIPPET="$SNIPPET_DIR/iot.conf"
SITE_CONF="/etc/nginx/sites-enabled/blog"
SUDO="${SUDO:-sudo}"

log()  { printf '%s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*" >&2; }
die()  { printf '❌ %s\n' "$*" >&2; exit 1; }

command -v nginx >/dev/null || die "本机没有 nginx —— 这个脚本是给部署服务器用的"

# 渲染模板：把 __IOT_ROOT__ 换成控制台目录的绝对路径。
# 用 `|` 当分隔符并转义路径里的 `&`/`\`（sed 的替换串里这两个字符有特殊含义；
# 路径里有空格倒是无所谓，这里不经过 shell 分词）。
render() {
    local root_esc
    root_esc="$(printf '%s' "$CONSOLE_DIR" | sed -e 's/[&\\]/\\&/g')"
    sed -e "s|__IOT_ROOT__|$root_esc|g" "$IOT_DIR/nginx/iot.conf.template"
}

# 站点配置里有没有那行 include —— 没有的话，装上去也是死配置。
include_present() {
    [ -f "$SITE_CONF" ] && grep -q 'snippets/blog-iot/\*\.conf' "$SITE_CONF"
}

check_include() {
    include_present && return 0
    warn "站点配置 $SITE_CONF 里没有那行通配 include："
    warn "    include /etc/nginx/snippets/blog-iot/*.conf;"
    warn "（两个 443 server 块都要加，见 iot/nginx/include-line.txt）"
    warn "没有它的话，下面无论装还是卸，线上行为都不会变。"
    printf '%s' "继续吗？[y/N] "
    read -r ans </dev/tty || ans=n
    case "$ans" in [yY]*) ;; *) die "已取消" ;; esac
}

case "${1:-}" in
on)
    [ -d "$CONSOLE_DIR" ] || die "找不到控制台目录 $CONSOLE_DIR"
    check_include

    $SUDO mkdir -p "$SNIPPET_DIR"
    # 先写一份**新的**到磁盘，验过再算数；验不过就回到原状（别把站点留在坏配置上）
    had_old=no
    [ -f "$SNIPPET" ] && { had_old=yes; $SUDO cp "$SNIPPET" "$SNIPPET.old.$$"; }
    render | $SUDO tee "$SNIPPET" >/dev/null

    if ! $SUDO nginx -t 2>&1; then
        if [ "$had_old" = yes ]; then
            $SUDO mv "$SNIPPET.old.$$" "$SNIPPET"
            warn "已回滚到上一份配置（nginx 配置没动）"
        else
            $SUDO rm -f "$SNIPPET"
            warn "已删掉刚写的配置（nginx 配置没动）"
        fi
        die "nginx -t 没过 —— 上面是 nginx 的原话，先照它改"
    fi
    $SUDO rm -f "$SNIPPET.old.$$"
    $SUDO systemctl reload nginx
    log "✅ nginx 已 reload：/device-console/、/device-api/、/mqtt 三个入口已生效"
    ;;

off)
    if [ -f "$SNIPPET" ]; then
        $SUDO rm -f "$SNIPPET"
        if ! $SUDO nginx -t 2>&1; then
            die "nginx -t 没过（删掉 snippet 之后反而坏了 —— 站点配置里多半是**具体文件名**的 include，不是通配）"
        fi
        $SUDO systemctl reload nginx
        log "✅ nginx 已 reload：三个入口已消失"
        log "   注意 /device-console/ 现在会落进 SPA fallback 返回**首页**（200，不是 404）。"
        log "   这是接受的：前端本来就不认这个路径（它只在 SPA_NAV_DENY 里出现）。"
    else
        log "（snippet 本来就不在，没做什么）"
    fi
    ;;

status) exec "$IOT_DIR/status.sh" ;;

*)
    cat >&2 <<'USAGE'
用法：./iot/toggle.sh {on|off|status}

  on      装上物联网平台的三个 nginx 入口（渲染 iot.conf.template 并 reload）
  off     卸掉（三个入口一起消失）
  status  看当前状态，并逐条核对三处开关是否一致

⚠️ 本脚本只管 nginx 那一面；Rust 与 agent 读的 .env 要你自己改（脚本结尾会说明）。
USAGE
    exit 1
    ;;
esac

cat <<EOF

── 另外两处（本脚本管不到，得你自己改）────────────────────────────────
开关总共三处，只改一处 = 三处不一致，而**不一致不报错**：

  1. nginx（刚做完的这一步）
  2. Rust 读的：$REPO_DIR/.env   → IOT_ENABLED=1 或删掉这行
     作用：sitemap.xml 列不列 /device-console/。改完要重启 saudade-rust。
  3. agent 读的：$REPO_DIR/saudade-blog-agent/.env → IOT_ENABLED=1 或删掉这行
     作用：被问到物联网平台时，说真话还是说"本站未部署"。改完要
     sudo systemctl restart saudade-agent && sleep 8

核对：./iot/status.sh
EOF

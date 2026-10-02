#!/usr/bin/env bash
# 物联网平台（可选件）的状态自查：**这个脚本判的是"三处开关一不一致"**。
#
# 为什么需要它：装/卸 IoT 要动三个地方（nginx、Rust 读的 .env、agent 读的 .env），
# 而**只改一处不会有任何报错**——
#   · 只开 nginx：页面能开，但 agent 仍说「本站未部署」（它读的是自己那份），
#     或者反过来，sitemap 里少一条；
#   · 只开两个 .env、没开 nginx：agent 高高兴兴带你跳一个 404，而 sitemap 也在推荐它。
# 所以这里逐条比，不一致就**报出来并退出码 1**（可以直接接进 healthcheck 之类的地方）。
#
#   ./iot/status.sh          # 读：文件在不在、.env 怎么写的、线上三个路径的实际响应
#
# 退出码：0 = 三处一致；1 = 有不一致（详情打印在上面）。
set -uo pipefail

IOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$IOT_DIR/.." && pwd)"
CONSOLE_DIR="$IOT_DIR/device-console"
SNIPPET="/etc/nginx/snippets/blog-iot/iot.conf"
SITE_CONF="/etc/nginx/sites-enabled/blog"
BLOG_ENV="$REPO_DIR/.env"
AGENT_ENV="$REPO_DIR/saudade-blog-agent/.env"

BAD=0
ok()   { printf '  ✅ %s\n' "$*"; }
no()   { printf '  ❌ %s\n' "$*"; BAD=1; }
info() { printf '  ·  %s\n' "$*"; }
head_() { printf '\n%s\n' "$*"; }

# 读某个 .env 里 IOT_ENABLED 的取值（缺键 = 空串 = 关；与代码里的默认值一致）。
# 只认 `KEY=值` 这一种写法（dotenvy / pydantic-settings 都认它）。
env_flag() {
    [ -f "$1" ] || { printf 'MISSING_FILE'; return; }
    local v
    v="$(grep -E '^[[:space:]]*IOT_ENABLED[[:space:]]*=' "$1" 2>/dev/null | tail -1 \
         | sed -e 's/^[^=]*=//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
    printf '%s' "${v:-UNSET}"
}

# 取值 → 开/关（与 src/utils.rs::iot_enabled 的真值集**必须一致**：1/true/yes/on）
is_on() {
    case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|on) return 0 ;;
        *) return 1 ;;
    esac
}

head_ "① nginx（页面那一面）"

if [ -f "$SNIPPET" ]; then
    ok "snippet 在：$SNIPPET"
    if grep -q '__IOT_ROOT__' "$SNIPPET"; then
        no "snippet 里还留着占位符 __IOT_ROOT__ —— 它不是渲染出来的，多半是手工拷的模板"
    elif ! grep -q "$CONSOLE_DIR" "$SNIPPET"; then
        info "snippet 里的控制台路径不是 $CONSOLE_DIR（改过仓库目录？重跑 toggle.sh on 重渲染）"
    fi
else
    info "snippet 不在（= 三个入口都不存在）"
fi

if [ -f "$SITE_CONF" ]; then
    n="$(grep -c 'snippets/blog-iot/\*\.conf' "$SITE_CONF" 2>/dev/null || true)"
    if [ "${n:-0}" = 2 ]; then
        ok "站点配置里两处 include 都在（$SITE_CONF）"
    elif [ "${n:-0}" = 0 ]; then
        no "站点配置里**没有**那行通配 include ⇒ 装/卸都不会改变线上行为（见 iot/nginx/include-line.txt）"
    else
        no "站点配置里只有 $n 处 include（本站有两个 443 server 块 ⇒ 要 2 处）"
    fi
    # 旧写法残留：具体文件名 include 会在"没装 IoT"的机器上直接 nginx -t 失败
    if grep -qE 'snippets/(mqtt|device)\.conf' "$SITE_CONF"; then
        info "站点配置里还有旧的具体文件 include（snippets/mqtt.conf / device.conf）——"
        info "  别人克隆部署时那两个文件不存在，nginx -t 会直接失败。该换成通配那行。"
    fi
else
    info "站点配置 $SITE_CONF 不在（不在生产服务器上跑？）"
fi

head_ "② Rust 读的 .env（sitemap 那一面）"
RUST_FLAG="$(env_flag "$BLOG_ENV")"
case "$RUST_FLAG" in
    MISSING_FILE) info "$BLOG_ENV 不存在（开发机上可能就这样）" ;;
    UNSET)        ok "没设 IOT_ENABLED ⇒ 关（sitemap 不列 /device-console/，这是出厂默认）" ;;
    *) if is_on "$RUST_FLAG"; then ok "IOT_ENABLED=$RUST_FLAG ⇒ 开"
       else no "IOT_ENABLED=$RUST_FLAG 既不是真值也不算缺省 —— 会被当成**关**（真值只有 1/true/yes/on）"; fi ;;
esac

head_ "③ agent 读的 .env（对话那一面）"
AGENT_FLAG="$(env_flag "$AGENT_ENV")"
case "$AGENT_FLAG" in
    MISSING_FILE) no "$AGENT_ENV 不存在 ⇒ agent 起不来或按默认档跑，先确认 agent 服务状态" ;;
    UNSET)        ok "没设 IOT_ENABLED ⇒ 关（被问起时答「本站未部署」）" ;;
    *) if is_on "$AGENT_FLAG"; then ok "IOT_ENABLED=$AGENT_FLAG ⇒ 开"
       else no "IOT_ENABLED=$AGENT_FLAG 会被当成**关**（真值只有 1/true/yes/on）"; fi ;;
esac

head_ "④ 一致性（三处必须同档，不一致**不会报错**，只会说假话）"
# nginx 这一面的"实际生效档"要按**线上真在跑的东西**算，不能只看新 snippet：
# 迁移还没做的机器上，入口是旧的"具体文件名 include"顶着（那正是本次要换掉的写法）。
# 只看 snippet 会得出"三处同档 off"的假结论——而站点上那三个入口明明通着。
NGINX_STATE=off
[ -f "$SNIPPET" ] && NGINX_STATE=on
LEGACY=off
[ -f "$SITE_CONF" ] && grep -qE 'snippets/(mqtt|device)\.conf' "$SITE_CONF" 2>/dev/null && LEGACY=on
if [ "$LEGACY" = on ] && [ "$NGINX_STATE" = off ]; then
    NGINX_STATE=on
    info "nginx 这一面**实际是开的**，但靠旧写法（具体文件名 include）顶着；"
    info "  换成通配那行、并把 snippet 渲染出来之后，才算真正可拔插（见 iot/nginx/）"
fi
is_on "$RUST_FLAG" 2>/dev/null && RUST_STATE=on || RUST_STATE=off
is_on "$AGENT_FLAG" 2>/dev/null && AGENT_STATE=on || AGENT_STATE=off

printf '  nginx=%s  rust(.env)=%s  agent(.env)=%s\n' "$NGINX_STATE" "$RUST_STATE" "$AGENT_STATE"
if [ "$NGINX_STATE" = "$RUST_STATE" ] && [ "$RUST_STATE" = "$AGENT_STATE" ]; then
    ok "三处同档（$NGINX_STATE）"
else
    no "三处**不同档**：下面是各自的表现，照它对齐"
    [ "$NGINX_STATE" = on ] && [ "$RUST_STATE" = off ] && \
        info "页面存在但 sitemap 不列它（少一条入口，不报错）"
    [ "$NGINX_STATE" = off ] && { [ "$RUST_STATE" = on ] || [ "$AGENT_STATE" = on ]; } && \
        info "页面**不存在**，但 sitemap/agent 仍当它存在 ⇒ 爬虫与访客都拿到一个 404"
    [ "$NGINX_STATE" = on ] && [ "$AGENT_STATE" = off ] && \
        info "页面存在，但 agent 会说「本站未部署」（访客被劝回去）"
    info "改完 .env 记得重启消费方：sudo systemctl restart saudade-rust / saudade-agent"
fi

head_ "⑤ 线上实际响应（只读探针，用本机回环，不经过公网）"
BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT
probe() { curl -sk -o "$BODY" -w '%{http_code}' --max-time 6 "$1" 2>/dev/null; }

c="$(probe https://127.0.0.1/device-console/)"
if grep -q '设备控制台\|IoT Console' "$BODY" 2>/dev/null; then
    ok "/device-console/ → $c，内容是控制台页（入口通）"
elif [ "$c" = 200 ]; then
    info "/device-console/ → 200，但内容是**别的东西**（多半是 SPA fallback 返回的首页 index.html）"
    info "  ⇒ 入口没通。这正是「没装」时的预期表现（页面路径不存在，不报 404）。"
else
    info "/device-console/ → $c"
fi

c="$(probe https://127.0.0.1/device-api/)"
if head -c 200 "$BODY" 2>/dev/null | grep -qi '<!DOCTYPE\|<html'; then
    info "/device-api/ → $c 且返回 HTML ⇒ 没被代理（落进了 SPA fallback）"
else
    info "/device-api/ → $c（非 HTML ⇒ 有东西在应答。device-service 要 JWT，401/403 是正常的）"
fi

c="$(probe https://127.0.0.1/mqtt)"
info "/mqtt → $c（普通 GET 不是合法的 MQTT 握手：400 = 上游活着，502 = 上游没起来）"

head_ "⑥ 上游进程"
if command -v pgrep >/dev/null; then
    if pgrep -x emqx >/dev/null 2>&1 || pgrep -f 'emqx' >/dev/null 2>&1; then
        ok "EMQX 进程在"
    else
        info "没看到 EMQX 进程（没装，或跑在别处）"
    fi
fi
if command -v systemctl >/dev/null; then
    s="$(systemctl is-active saudade-device 2>/dev/null || true)"
    case "$s" in
        active) ok "saudade-device 服务 active" ;;
        inactive|failed|"") info "saudade-device 服务：${s:-未安装}（device-service 不在本仓，见 iot/device-service/README.md）" ;;
        *) info "saudade-device 服务：$s" ;;
    esac
fi

printf '\n'
if [ "$BAD" = 0 ]; then
    printf '✅ 三处同档，没有发现不一致\n'
else
    printf '❌ 上面标 ❌ 的几处要处理（退出码 1）\n'
fi
exit "$BAD"

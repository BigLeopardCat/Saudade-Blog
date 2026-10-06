#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  nginx 站点配置的渲染 —— **唯一实现**，两个调用方共用：
#    · 裸机：deploy/install.sh（source 它，由 setup_nginx 落到 sites-available/blog）
#    · 容器：deploy/docker/render-nginx.sh（渲染成 deploy/docker/generated/blog.conf，
#            再由 compose 只读挂进 nginx 容器的 /etc/nginx/conf.d/blog.conf）
#  为什么必须共用：函数体里那段「按结构标记切掉乙块」的 awk 一旦分家，改模板结构时就只有
#  一边会跟着改 —— 另一边的症状是 nginx -t 失败，或者静默留着 <你的域名> 占位符。
#
#  调用方提供的输入（全部是普通变量/函数，不 export）：
#      DEPLOY_DIR  模板在哪（= 本文件所在的 deploy/）
#      APP_DIR     站点根（裸机=仓目录；容器=/srv）
#      DOMAIN      裸域名，空 = 只有 IP 的形态（会整块切掉乙块）
#      CERT_NAME   乙块用的证书基名（甲块恒用 selfsigned，见函数内注释）
#      WITH_IOT    1 = 解注那行 IoT include
#      note() / die()   调用方的日志函数；docker 侧没有就由本文件补一对最小实现
#
#  输出：渲染结果走 **stdout**，调用方自己去落地。人话一律走 stderr —— install.sh 立的
#  这条纪律就是为这一处：历史上 `note` 曾被写进站点配置的第一行。
# ═══════════════════════════════════════════════════════════════════════════════

# 有调用方的就用调用方的（sourcing 进来的同名函数不该被这里悄悄换掉），没有才补一对最小的。
if ! command -v note >/dev/null 2>&1; then
    note() { printf '  · %s\n' "$*" >&2; }
fi
if ! command -v die >/dev/null 2>&1; then
    die() { printf '  ✗ %s\n' "$*" >&2; exit 1; }
fi

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

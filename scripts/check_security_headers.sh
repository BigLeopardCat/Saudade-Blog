#!/usr/bin/env bash
# 全站安全响应头的机器判据（20261015 审计落地）。
#
# 为什么需要它：这五条头**只活在 /etc/nginx** 里（Rust 侧只在下载路由补 nosniff，
# 见 src/middleware.rs），而那份配置**不在仓库里、不经 CI、不受任何测试覆盖**。
# 也就是说：改坏它不会有任何东西变红——正是本仓反复吃过的那类"配置漂移无人喊"。
# 落点因此有两处，都用这一个脚本（判据只有一份）：
#   · `scripts/healthcheck.sh` 第 8 项：每分钟探针，缺了就写 logs/health.log 的 WARN；
#   · `scripts/deploy/deploy_from_r2.sh` 末尾：每次部署顺带复核一次（非致命，
#     与同处的 prune_r2 一个待遇）——nginx 与部署包一起变，这个组合是"改了配置
#     忘了 include"最可能发生的时刻。
#
# ★ 判据是**逐路径**要齐五条，不是"首页有就行"：
#   nginx 的 `add_header` 不继承——某个 location 里有任何一条 add_header，server 块里
#   的整片失效。所以"首页 5/5"完全可能与"静态资源 0/5"并存（本站每个 location 都有
#   Cache-Control）。下面三条路径分别落在 `location /`（SPA 入口）、`location ~* \.(js|css)$`
#   （静态资源）与 `location ^~ /api/`（反代）三块上，覆盖三种 include 位置。
#
# 用法： bash scripts/check_security_headers.sh [Host 头]
# 退出码：0 = 三条路径都齐；1 = 有缺失（逐条打到 stderr）。
# 本机跑（127.0.0.1 + Host 头），不走公网、不依赖 DNS——探针要能在"公网不通"时也说话。
# `-k` 是必须的：https://127.0.0.1 命中的是自签证书那个 default_server 块。
set -u

HOST="${1:-${SITE_HOST:-saudade.site}}"
PATHS=("/" "/live2d-widgets/boot.js" "/api/login")
# 装了 IoT 才有 /device-console/ 这个 location（它有自己的 Cache-Control ⇒ 必须自己
# include 一份头，是"add_header 不继承"最容易漏的一处）。存在判据用**开关本身**
# （那个 snippet 文件在不在，与 iot/toggle.sh 的判据同源），不用 HTTP 状态码——
# 没装 IoT 时 `/device-console/` 会落到 SPA fallback 返回 200 的 index.html（同族坑：
# "200 可能是 index.html"），拿状态码判"装没装"会把它当成装了。
[ -f /etc/nginx/snippets/blog-iot/iot.conf ] && PATHS+=("/device-console/")
REQUIRED=(
  "x-content-type-options: nosniff"
  "referrer-policy: strict-origin-when-cross-origin"
  "x-frame-options: SAMEORIGIN"
  "permissions-policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()"
)
# HSTS 只在 443 上有意义；站点只有单域名、也没提交 preload，值就是这一条。
REQUIRED+=("strict-transport-security: max-age=31536000")

missing=0
for p in "${PATHS[@]}"; do
  hdr=$(curl -sI -k --max-time 5 -H "Host: $HOST" "https://127.0.0.1$p" | tr -d '\r')
  if [ -z "$hdr" ]; then
    echo "拿不到响应头：$p（nginx 没在跑？）" >&2
    missing=$((missing + 1))
    continue
  fi
  for want in "${REQUIRED[@]}"; do
    # 大小写不敏感（nginx 回的是小写、某些中间件回大写），值做**原样子串**比对：
    # 判的是"这条头在、值就是我们配的那个"，不是"有这个名字就行"
    if ! printf '%s\n' "$hdr" | grep -qiF -- "$want"; then
      echo "$p 缺: $want" >&2
      missing=$((missing + 1))
    fi
  done
done

if [ "$missing" -gt 0 ]; then
  echo "安全响应头缺失 $missing 处 —— 查 /etc/nginx/snippets/blog-headers/security.conf 是否被该 location include" >&2
  exit 1
fi
echo "安全响应头齐备（${#PATHS[@]} 条路径 × ${#REQUIRED[@]} 条头）"
exit 0

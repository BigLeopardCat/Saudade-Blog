#!/usr/bin/env bash
# Verify public security headers for the configured routes.

set -u

HOST="${1:-${SITE_HOST:-saudade.site}}"
PATHS=("/" "/live2d-widgets/boot.js" "/api/login")
# 仅在 IoT snippet 存在时检查设备路由；SPA fallback 的 200 响应不能证明功能已启用。
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
  hdr=$(curl --noproxy '*' -sI -k --max-time 5 -H "Host: $HOST" "https://127.0.0.1$p" | tr -d '\r')
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

# EMQX（MQTT broker）

设备接入与网页实时通道都靠它。EMQX 本身**不在本仓**，装发行版即可（5.x；本项目在
5.8.9 上校准过）。

## 装

```bash
# 1. 装 5.x 发行版（见 EMQX 官方安装文档），然后：
sudo cp iot/emqx/emqx.conf.template /etc/emqx/emqx.conf
sudo vi /etc/emqx/emqx.conf        # 改掉 <...> 占位：cookie、证书路径

# 2. 证书放 /etc/emqx/certs/（EMQX 以 emqx 用户跑，注意属主与读权限）
#    用与 nginx 同一份站点证书 —— 设备端只认一个域名，不用再发一套 CA
sudo mkdir -p /etc/emqx/certs
sudo cp /etc/nginx/ssl/<证书链>.crt /etc/emqx/certs/
sudo cp /etc/nginx/ssl/<私钥>.key   /etc/emqx/certs/
sudo chown emqx:emqx /etc/emqx/certs/*

sudo systemctl restart emqx

# 3. 认证链 / 授权 / API Key（幂等，可重复跑）
EMQX_ADMIN_PASS='<dashboard 管理员口令>' python3 iot/emqx/configure_emqx.py
```

## `configure_emqx.py` 干了什么

纯 REST API，**不打印任何密钥**，可重复执行：

1. 登录 Dashboard → 轮换管理员口令 → 创建 API Key；
   两者分别落盘到本目录 `.api_key` 与 `.admin_creds`（0600，已在 `.gitignore` 里）。
   已经有 `.api_key` 就直接复用，不再登录。
2. **认证链 1：`jwt`** —— 复用博客 `.env` 的 `JWT_SECRET`（`hmac-based`）。
   网页控制台与设备共用同一套令牌，`exp` 由 broker 自动校验。
3. **认证链 2：`password_based` + `http` backend** —— 设备用 `device_id` + `device_key`
   连上来时，broker 回调 device-service 的 `/api/devices/auth` 问"这设备合法吗"。
   ⇒ **device-service 没装的话，设备连不上**（这是两条链里唯一依赖本机服务的那条）。
4. **授权：`no_match = deny`**（白名单式）+ built-in database 规则，按命名空间给：
   `users/${username}/#`、`devices/${username}/#`、`console/${username}/#`、`broadcast/#`。
   `${username}` 是 EMQX 的占位符，展开成连接时用的用户名 ⇒ 每个用户只能碰自己的主题。
5. 打印一遍 broker 状态与认证链摘要，供人核对（只打机制名与开关，不打密钥）。

### 规则是**全量替换**的

EMQX 5.8 的 `/authorization/sources/built_in_database/rules/all` 那个 POST 是**替换**不是
追加（实测：只发"新增的那条"会把没包含的旧规则全清掉，然后设备发布被静默拒绝）。
所以脚本的做法是：先读现有规则的 topic 集合，**不一致才**清空重写全量。改规则时改
`needed` 那一个列表就行，别在别处手加。

## 端口与公网暴露

| 端口 | 绑到 | 谁用 |
|---|---|---|
| 1883 | `127.0.0.1` | device-service 连本机 broker |
| 8083 | `127.0.0.1` | 网页控制台的 WSS —— **经 nginx 转**（`/mqtt`，见 `../nginx/`） |
| 18083 | `127.0.0.1` | Dashboard（**别挂公网**） |
| **8883** | `0.0.0.0` | **设备直连**（mqtts，唯一对外端口） |

对外只开 8883：其余三个一律回环，公网入口交给 nginx 一处说了算。

## 排障

| 现象 | 先看这里 |
|---|---|
| 网页控制台连不上 WSS | nginx 那段 include 加了没（`../status.sh` 会报）；`/mqtt` 是否 502（= broker 没起） |
| 设备连不上 8883 | `/etc/emqx/certs/` 的证书与 nginx 那份是不是同一套、属主是不是 emqx |
| 设备认证被拒 | 认证链 2 的 url 是否指到 device-service（`DEVICE_AUTH_URL`），以及那个服务是否在跑 |
| 订阅被拒但能连上 | ACL：回去看上面「规则是全量替换的」那节 |

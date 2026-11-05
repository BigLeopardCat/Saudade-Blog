# IoT 设备平台（可选件）

一套 ESP32 设备接入能力：设备用 MQTT over TLS 连上来，在网页上注册、下发参数、看遥测。
它由三块组成——

| 块 | 是什么 | 在本仓里？ |
|---|---|---|
| **EMQX 5** | MQTT broker（设备接入 + 网页实时通道） | 否，装发行版 |
| **device-service** | 设备注册/认证/配置下发/遥测缓存（Rust, :3100） | **否，见 [device-service/README.md](device-service/README.md)** |
| **设备控制台** | 静态页 `/device-console/`，复用博客登录态 | 是，[device-console/](device-console/) |

**它是可选件，默认不装。** 不装时站点与对话 agent 一切照常——只是没有这三个入口，
被问起时 agent 会回答"本站未部署"。

> 要避免的是"装了一半"这个中间态：agent 以为页面在、带你跳过去，那边却是 404，而两边
> 都不报错。本目录的作用就是让"装了"与"没装"始终一致。

---

## 开关

没有"一个开关控制一切"这种东西。`IOT_ENABLED` 是**一个名字在三个地方各读各的**，
三处必须同档：

| # | 谁读 | 读哪份配置 | 管什么 |
|---|---|---|---|
| 1 | nginx | `/etc/nginx/snippets/blog-iot/*.conf` 在不在 | `/device-console/`、`/device-api/`、`/mqtt` 三个入口存不存在 |
| 2 | Rust 后端 | 博客 `.env` 的 `IOT_ENABLED` | `sitemap.xml` 列不列 `/device-console/` |
| 3 | 对话 agent | agent 仓 `.env` 的 `IOT_ENABLED` | 被问到物联网平台时回答"已部署"还是"本站未部署" |

**缺省是关**：第 2、3 处不写 `IOT_ENABLED` 就是关；第 1 处目录空着就是关。
真值只有 `1` / `true` / `yes` / `on`（两边代码的取值口径一致，改一处要改两处）。

改完 2、3 要重启消费方才生效：

```bash
sudo systemctl restart saudade-rust
sudo systemctl restart saudade-agent && sleep 8
```

### 三处不一致会怎样

**不会报错**，只是三处说法对不上：

| 状态 | 表现 |
|---|---|
| 只开了 1（页面） | 页面能开，但 agent 仍劝访客"本站没有这个页面" |
| 只开了 2、3 | sitemap 推荐它、agent 主动带你去 —— 而那里是 404 |
| 只开了 1、3 | 站点上一切正常，只有爬虫少收录一条 |

所以装完（或卸完）**跑一次 `./iot/status.sh`**：它逐条比三处，不一致就标 ❌ 并退出码 1。

---

## 装

按顺序来，前两步是可选的（不装 IoT 就不用做）。

### 1. EMQX

```bash
# 装 EMQX 5.x（发行版方式，见官方文档）
sudo cp iot/emqx/emqx.conf.template /etc/emqx/emqx.conf   # 先把 <...> 占位改掉
sudo systemctl restart emqx
# 单独核对设备 HTTP 认证回调和 ACL，勿直接沿用旧 JWT 安装流程。
```

`configure_emqx.py` 仍配置旧的博客 JWT 认证链，不是新隔离鉴权的安装入口。
维护旧模式时需理解其密钥共享和撤销边界，见 [emqx/README.md](emqx/README.md)。
设备 HTTP 网关的独立密钥与账号部署见[独立服务账号](../deploy/service-isolation.md)。

### 2. device-service

见 [device-service/README.md](device-service/README.md)。**这条目前要自己动手**——
服务本体不在本仓（也不在别的公开仓），本目录只给单元文件模板与凭据生成脚本。
没有它，第 3 步装上的三个入口里有两个（`/device-api/`、`/mqtt` 的认证回调）没有后端。

### 3. nginx 三个入口

```bash
# 站点配置里加上那行通配 include（两个 443 server 块都要加）
#     include /etc/nginx/snippets/blog-iot/*.conf;
# 照 iot/nginx/include-line.txt 抄
sudo nginx -t && sudo systemctl reload nginx

./iot/toggle.sh on        # 渲染 snippet 并 reload（会先 nginx -t，不过就回滚）
```

### 4. 三处开关对齐

```bash
# 博客 .env 与 agent 仓 .env 各加一行
echo 'IOT_ENABLED=1' >> /path/to/Saudade-Blog/.env
echo 'IOT_ENABLED=1' >> /path/to/Saudade-Blog/saudade-blog-agent/.env
sudo systemctl restart saudade-rust
sudo systemctl restart saudade-agent && sleep 8

./iot/status.sh           # 应该全 ✅
```

### 5. 设备

设备侧固件由独立的 [ESP32-S3-OBC](https://github.com/BigLeopardCat/ESP32-S3-OBC) 仓库维护。

---

## 运行要求

EMQX 和设备服务独立运行，按当前版本及负载测量内存、磁盘和连接数，不套用旧样本。
设备 MQTTS 需要开放 8883；broker 管理和服务 HTTP 端口只在内部使用。
HTTPS 与 MQTTS 证书续期须分别验证，服务限额以实际 systemd 配置为准。
设备服务源码不在本仓，其构建与发布需要独立验证；共享生产主机不执行 release 编译。

## 卸

```bash
./iot/toggle.sh off                       # 三个入口消失
# 再把两份 .env 里的 IOT_ENABLED 删掉，重启两个服务
./iot/status.sh
```

要连 EMQX 与 device-service 一起卸：`sudo systemctl disable --now emqx saudade-device`。
设备控制台是纯静态页，删掉 `iot/` 目录也无妨（它只被 nginx 的 `alias` 指着）。

**卸载后 `/device-console/` 会返回首页（200），不是 404。**这是接受的：SPA 的
`try_files ... /index.html` 兜住了一切未知路径，而前端本来就不认这个路径。所以判断
"到底装没装"不要看状态码，看内容（`status.sh` 就是这么判的）。

---

## 目录

| 路径 | 说明 |
|---|---|
| `toggle.sh` | nginx 那一面的开关（`on` / `off` / `status`） |
| `status.sh` | 三处开关的一致性自查 + 线上实际响应探针 |
| `nginx/` | 三个 location 的模板 + 要塞进站点配置的那一行 |
| `device-console/` | 控制台静态页（`index.html` + `mqtt.min.js`） |
| `emqx/` | broker 配置模板 + 幂等的认证链/ACL 配置脚本 |
| `device-service/` | 服务单元模板 + `svc.env` 生成脚本 + 说明（**服务本体不在本仓**） |

## 安全边界

- HTTP 管理请求在 Rust 网关查询当前账号及令牌代次，再交换设备短期令牌；设备服务不持有博客登录密钥。
- MQTT 认证是独立链路。若沿用旧 EMQX JWT 模式，broker 仍共享登录密钥且只校验签名/过期，
  不查询冻结或撤销状态；HTTP 网关的迁移不代表该模式已经迁移。见 [EMQX 说明](emqx/README.md)。
- `configure_emqx.py` 的 API Key、`svc.env` 的设备服务口令、`/etc/emqx/certs/` 下的证书
  都是凭据：本目录的 `.gitignore` 挡住了本地生成的落盘文件，**别手工提交**。

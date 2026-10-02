# IoT 设备接入物联网平台指南

> 平台 = 本站的 IoT 能力：设备注册/参数配置/指令下发/遥测/在线状态/OTA。
> **这是可选件，出厂默认不装**——装/卸的三处开关、目录与脚本见 [iot/](../iot/)。
> 架构：nginx（`/device-api` 反代 + `/device-console` 静态）→ **device-service**（Rust, :3100，
> 业务 API + MQTT 桥）→ **EMQX**（MQTT broker）→ **ESP32 等设备**。
> 控制台：https://saudade.site/device-console/（复用博客登录态，无二次登录）。
> 设备参考实现：[BigLeopardCat/ESP32-S3-OBC](https://github.com/BigLeopardCat/ESP32-S3-OBC)
> （**另一个仓**，实际在跑的固件在那儿）；本仓 [iot/firmware/](../iot/firmware/) 是抽出来的
> 最小骨架与接口说明。
>
> ⚠️ 文中 `saudade.site` 是**示例站点**，换成你自己的域名（与站点证书一致）。

---

## 1. 平台架构

```
网页控制台 (device-console/)                ESP32 设备
    │  localStorage.tokenKey (博客 JWT)        │  TLS 证书链校验
    ▼                                          ▼
GET/PUT /device-api/api/*               mqtts://saudade.site:8883 (EMQX)
    │  Bearer JWT                             │  认证链：JWT 链(网页用户) → HTTP 链(设备)
    ▼                                          ▼
device-service (:3100) ◄─────────── MQTT 1883 (本机内部) ────────────┘
    │  SQLite：devices / config_history / telemetry / cmd_history
    └─► 设备事件经 console/<owner>/devices/<id>/<kind> 转发回控制台实时流
```

**两种接入身份**，凭据体系互不相通：

| 身份 | 凭据 | 用途 |
|---|---|---|
| **网页用户** | 博客 JWT（Bearer/密码） | REST API（设备管理/下发/OTA 管理）+ 控制台实时流（MQTT WSS） |
| **设备** | `device_id` + `device_key` | MQTT 接入（用户名/密码）+ OTA 拉取（HTTP Basic） |

**三条通道**：

| 通道 | 地址 | 设备用 | 网页用 |
|---|---|---|---|
| MQTT | `mqtts://saudade.site:8883`（TLS） | ✅ 指令/配置/遥测/状态 | 控制台实时流（WSS /mqtt） |
| REST | `https://saudade.site/device-api/api/...` | OTA 轮询（Basic 认证） | ✅ 全部管理 API（JWT） |
| 控制台 | `https://saudade.site/device-console/` | — | ✅ 人机交互 |

---

## 2. 快速接入流程（5 步）

1. **注册设备**：控制台"注册设备"按钮（或 `POST /api/devices`）→ 获得一次性凭据：
   ```json
   {"device_id": "dev-<uuid32>", "device_key": "dk-<uuid32>", "note": "device_key 仅显示一次，请写入固件并妥善保存"}
   ```
   ⚠️ `device_key` 只返回这一次，丢失只能删除重建设备。
2. **填入固件**：把 `device_id`/`device_key` 写入固件配置（参考实现：`main.c` 顶部宏）。
3. **连上 MQTT**：`mqtts://saudade.site:8883`，用户名=`device_id`，密码=`device_key`，
   校验服务器证书链（正式证书）。
4. **订阅/上报**：订阅 `devices/<id>/config`、`devices/<id>/cmd`；发布遥测、状态、回执。
5. **验证**：控制台看到设备上线 → 下发一条显示指令 → 设备执行 + 回执 ✓。

---

## 3. MQTT 协议定义

### 3.1 Broker 与认证链（EMQX 5.8.9）

| 监听 | 地址 | 用途 |
|---|---|---|
| MQTTS **8883** | 公网 | **设备接入**（TLS，正式证书，与 HTTPS 同源） |
| TCP 1883 | 仅本机 | device-service 内部连接 |
| WSS 8083 | 仅本机（nginx /mqtt） | 控制台实时流 |

认证链（顺序匹配）：
1. **JWT 认证链**（网页用户）：password = 博客 JWT，HMAC 校验（secret = 博客 `JWT_SECRET`）
2. **HTTP 认证链**（设备）：回调 `POST http://127.0.0.1:3100/api/devices/auth`，
   body `{"username": ..., "password": ...}`——设备凭证正确 → `allow`；未知 → `ignore`
   （继续认证链，**绝不能 deny**，否则把 MQTT 死锁在自定义逻辑上）
3. 内部账号 `svc`（设备服务自身，superuser）

**ACL**（`no_match=deny` 默认全拒，内置规则）：

```
broadcast/#               # 所有
users/<username>/#        # 网页用户（username=sub）
devices/<username>/#      # 设备（username=device_id）——设备只能碰自己的空间
console/<username>/#      # 网页用户实时流
```

设备（username=`device_id`）**只能访问 `devices/<自己>/#`**——ACL 层面隔离，跨设备不可达。

### 3.2 Topic 全表

设备前缀均为 `devices/<device_id>/`：

| Topic | 方向 | QoS | retain | Payload |
|---|---|---|---|---|
| `devices/<id>/config` | 服务→设备 | 1 | ✅ | `{"cfg_version": N, "config": {...任意 JSON}}` |
| `devices/<id>/config/ack` | 设备→服务 | 1 | 否 | `{"ack": true, "cfg_version": N}` |
| `devices/<id>/cmd` | 服务→设备 | 1 | ❌ | 任意 JSON（可带 `req_id`） |
| `devices/<id>/cmd/ack` | 设备→服务 | 1 | 否 | 执行结果 JSON，**必须原样带回 `req_id`** |
| `devices/<id>/telemetry` | 设备→服务 | 1 | ❌（必须非 retain） | 任意 JSON，**即心跳** |
| `devices/<id>/status` | 设备→服务 | 1 | online 可 retain | 字符串 `"online"` / `"offline"` |
| `console/<owner>/devices/<id>/<kind>` | 服务→浏览器 | 1 | 否 | 事件转发（telemetry/ack/status 分发） |

**retain 语义（两个坑，历史踩过）**：
- `config` **必须 retain**：设备上线即收到最新配置（配置自愈）。
- `cmd` **严禁 retain**：一次性动作，retain 会重放旧指令（曾导致 OLED"换内容无效"——重放旧指令覆盖新内容，见问题记录 2.5）。
- 遥测必须非 retain：retain 遥测会被当成心跳重放，破坏在线判定。

### 3.3 指令与回执（req_id 端到端闭环）

```
控制台/agent  PUT /api/devices/<id>/cmd     （可选头 X-Request-Id → 注入 req_id）
     │  服务端写 cmd_history (req_id)
     ▼
devices/<id>/cmd  {"type":"display","text":"...","req_id":"a1b2c3"}
     ▼ 设备执行
devices/<id>/cmd/ack  {"ack":true,"type":"display","req_id":"a1b2c3"}   ← req_id 原样带回
     ▼ 服务端按 req_id 精确匹配未回执记录
GET /api/devices/<id>/cmd/<req_id>  →  {"acked": true, "ack": "<设备回执原始 JSON>", "ack_ts": "..."}
```

- 设备回执**缺失 req_id** 时，服务端退化为匹配最近一条未回执记录（兼容旧固件）。
- 回执也刷新在线心跳；`X-Request-Id` 头是 agent trace_id 透传链的一环（四端对账）。

### 3.4 在线状态判定（防"假在线"）

- **心跳** = 非 retain 的真实遥测/回执（30s TTL 内刷新即在线）；`status=offline` 立即离线。
- retain 的 `status online` 订阅时被重放，**不计入心跳**——这是 2026-08-28"断电假在线"事故的
  修复核心（问题记录 2.1）：设备断电后 30s 内判定离线，下发返回 409 而非假成功。
- 正常掉线由**遗嘱消息**（last will，retain `"offline"`）自动补发；主动重启前可先发 offline。

### 3.5 遥测（即心跳）

示例（每 5-15s，字段自由扩展，控制台自动发现新列）：

```json
{"temperature": 26.5, "humidity": 60.2, "rssi": -72, "uptime": 12345,
 "firmware": "1.1.0", "cfg_version": 5, "free_heap": 184320}
```

- `firmware` 字段被平台自动记录到设备表（OTA 成功判定）。
- 遥测不进保留队列（环形缓存 200 条/设备），查询 `GET /api/devices/<id>/telemetry?limit=N`。

---

## 4. REST API 定义（均要求博客 JWT，`Authorization: Bearer <token>`）

### 设备管理

| 端点 | 说明 |
|---|---|
| `GET /api/devices` | 设备列表。字段：`id`/`name`/`config`/`cfg_version`/`cfg_acked_version`/`firmware_version`/`sync`（`synced`已回执/`pending`待确认/`none`未配置）/`created_at`/`online`（30s TTL 现算）。返回 `owner=自己 OR is_default=1` |
| `POST /api/devices` | 注册，body `{"name":"客厅 ESP32"}` → 返回 `device_id`/`device_key`（一次性） |
| `DELETE /api/devices/:id` | 删除（204；默认演示设备不可删） |

### 参数配置（版本化）

| 端点 | 说明 |
|---|---|
| `PUT /api/devices/:id/config` | body `{"config": {...任意 JSON}}` → `cfg_version` +1 → 写 `config_history`（保留 10 版）→ 发布 MQTT → 响应 `{"ok":true,"published":true,"cfg_version":N}` |
| `PUT /api/devices/:id/config/rollback` | 回滚上一版重新下发（版本继续 +1，不倒退） |

设备回执后 `cfg_acked_version` 更新，`sync` 变 `synced`——控制台据此显示"已同步 vN"。

### 指令

| 端点 | 说明 |
|---|---|
| `PUT /api/devices/:id/cmd` | body 任意 JSON 透传（**不允许空对象**，400）。**离线（30s TTL）返回 409**"设备当前不在线，指令未下发"，不发布。可选头 `X-Request-Id` → 注入 `req_id`。响应 `{"ok":true,"published":true,"req_id":...}`，写 cmd_history（环形 100 条） |
| `GET /api/devices/:id/cmd/:req_id` | 回执查询：`{"acked":true/false,"ack":"<原始 JSON>","ack_ts":...}`；无记录 404 |

### 遥测

| 端点 | 说明 |
|---|---|
| `GET /api/devices/:id/telemetry?limit=N` | limit 默认 50（clamp 1-200），时间倒序 `{"online":bool,"items":[{"ts","data"}]}` |

### OTA（固件管理）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/ota/info` | **设备 Basic**（device_id:device_key） | `{"version":"1.3.0","md5":...,"size":N}`；无版本 `{"version":null}` |
| `GET /api/ota/fw/:file` | 设备 Basic | 固件下载（目录穿越防护） |
| `GET /api/ota/versions` | JWT | `{"current":"1.3.0","versions":[...]}` |
| `PUT /api/ota/firmware?version=1.2.0` | JWT + **role=admin** | 上传固件（body=原始 bin）→ 落盘 + 重建 `current.bin` 指针 |
| `PUT /api/ota/rollback` | JWT + admin | 固件回滚（current 指针切回上一版） |

设备轮询流：`GET /api/ota/info` → 版本不一致 → `GET /api/ota/fw/current.bin` → esp_https_ota 写入
A/B 分区 → 重启 → 遥测上报新 `firmware` 确认。

### EMQX 认证回调（无 JWT）

`POST /api/devices/auth`：`{"username","password"}` → 设备凭证正确 `{"result":"allow"}`；
`svc` 账号 `{"result":"allow","is_superuser":true}`；未知 `{"result":"ignore"}`。

---

## 5. ESP32-S3 接入示例（参考实现）

完整固件：[BigLeopardCat/ESP32-S3-OBC](https://github.com/BigLeopardCat/ESP32-S3-OBC)，
接入细节见该仓库的 `docs/device-integration.md`。

最小接入骨架（ESP-IDF）：

```c
// 1. 连接参数（控制台注册后填入）
#define DEVICE_ID  "dev-<uuid32>"
#define DEVICE_KEY "dk-<uuid32>"

// 2. MQTT 配置：TLS 证书链 + 用户名/密码 + 遗嘱
esp_mqtt_client_config_t cfg = {
    .broker.address.uri = "mqtts://saudade.site:8883",
    .broker.verification.certificate = (const char *)saudade_site_ca_pem,  // 嵌入证书
    .credentials.username = DEVICE_ID,
    .credentials.password = DEVICE_KEY,
    .session.keepalive = 60,
    .session.last_will.topic = "devices/" DEVICE_ID "/status",
    .session.last_will.msg = "offline",
    .session.last_will.retain = true,
};

// 3. 连接成功：发 online(retain) + 订阅 config/cmd
// 4. 每 5s：发布遥测（即心跳，非 retain）
// 5. 收 config：应用 + NVS 持久化 + 回 config/ack（带 cfg_version）
// 6. 收 cmd：执行 + 回 cmd/ack（req_id 原样带回）
// 7. 每 6h：GET /api/ota/info（Basic 认证）→ 版本变化 → 拉 current.bin 升级
```

要点：遥测即心跳；回执必须带 `req_id`；config 保留策略与 cmd 禁 retain 的差异是平台语义核心。

---

## 6. 运维注意

- **安全组**：公网需放行 8883（MQTTS）。REST 全走 443 无需额外放行。
- **证书**：MQTTS 证书与 HTTPS 同源（saudade.site），到期需续期并同步
  EMQX 的证书目录（20260831 已续期至 **2026-11-07**；nginx 侧另有一份同源副本，**续期要两处同步**）。
- **设备服务部署**：device-service 不在本仓库、不经 CI（独立目录），改动需手动
  `cargo build --release` + 重启 device 服务（3.7GB 机器注意内存）。
- **数据**：SQLite WAL（devices/config_history/telemetry/cmd_history），量小无需外部依赖。
- **日志**：`logs/device.log`（DEVICE_LOG_FILE 配置）；MQTT 三段式日志（已入队→发出→broker 确认）
  是排查"下发假成功"的第一入口（问题记录 2.2）。

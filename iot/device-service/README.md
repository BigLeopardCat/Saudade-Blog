# device-service（设备服务，Rust, :3100）

设备注册表、`device_key` 校验、参数配置下发、遥测缓存。它连本机 EMQX（内部账号），
对外只经 nginx 的 `/device-api/`。，与博客共用同一套 JWT（`JWT_SECRET`）。

## ⚠️ 服务本体**不在本仓**

本目录只有三样东西：单元文件模板、`svc.env` 生成脚本、这份说明。
**device-service 的 Rust 源码目前既不在本仓、也没有单独的公开仓。**

这意味着：

- **不装 IoT 时完全不影响你**——出厂档就是关的，跟着 [../README.md](../README.md) 走就行。
- **想装 IoT 时**，`/device-console/` 与 `/mqtt` 两条能通，但第三条
  （`/device-api/`，以及设备接入时的 HTTP 认证回调）**没有后端**。
  设备连不上 8883，控制台也读不到设备列表。
- 要补上它，得自己按接口契约写一个等价服务，或者找站主要源码。

本目录仍然有用：单元文件与配置的**形态**是确定的（下面那节写了它要读哪些环境变量、
要听哪个端口、要提供哪个认证回调），照着实现即可。

## 它要满足的接口契约

`gen_svc_env.py` 生成的那份 `svc.env` 就是它的全部配置输入：

| 变量 | 用途 |
|---|---|
| `DEVICE_SVC_USER` / `DEVICE_SVC_KEY` | 连本机 EMQX 的内部账号（EMQX 侧特判 `svc` 为 superuser） |
| `DEVICE_LISTEN` | 监听地址，默认 `127.0.0.1:3100` |
| `DEVICE_DB_PATH` | SQLite 落盘路径（设备表、配置历史、遥测） |
| `DEVICE_LOG_FILE` | 额外追加写的日志文件（systemd 下 journald 另有一份） |

另外它**必须能读到博客的 `.env`**（取 `JWT_SECRET` 验来访的博客令牌）。别把这个路径写死：
博客仓库换个目录名或换台机器，写死的那条引用**不会报错，只会静默失效**（拿不到 secret ⇒
所有设备令牌都验不过）。读环境变量（`BLOG_ENV`）并给一个相对推导的默认值。

对外要提供的一个关键端点：

```
POST /api/devices/auth      # EMQX 的 HTTP 认证链回调（见 ../emqx/README.md 第 3 步）
  body: {"username": "<device_id>", "password": "<device_key>"}
  → 200 表示放行
```

## 装（有了源码之后）

```bash
DEVICE_DIR=/path/to/device-service python3 iot/device-service/gen_svc_env.py   # 生成 svc.env (0600)

cargo build --release        # ⚠️ 在内存充足的机器上编；本机 3.7G 内存编译会拖垮整机

sudo cp iot/device-service/saudade-device.service.template /etc/systemd/system/saudade-device.service
sudo vi /etc/systemd/system/saudade-device.service    # 改掉 <...> 四处占位
sudo systemctl daemon-reload
sudo systemctl enable --now saudade-device
systemctl status saudade-device
```

## 信任边界（重要）

它验博客令牌时**只验签与 `exp`，不查库** —— 所以后台"冻结账号"或"收回令牌"**管不到**
`/device-api/*`。一个被冻结的账号，在它那枚令牌过期前仍然能操作自己名下的设备。
EMQX 侧同理。这是已知缺口，如实记在 [../../docs/security-boundary.md](../../docs/security-boundary.md)，
别当成"冻结 = 全站立刻下线"。

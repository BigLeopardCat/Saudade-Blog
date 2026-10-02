# 设备控制台（静态页）

`/device-console/` 那一页：列出设备、注册设备、改参数并下发、看遥测。用博客登录态
（`localStorage.tokenKey`）直接当身份，没有二次登录。

两个文件，都是**直接服**的静态资源（不经 Vite 打包）：

| 文件 | 说明 |
|---|---|
| `index.html` | 页面本体（单文件：结构 + 样式 + 脚本都在里面） |
| `mqtt.min.js` | mqtt.js 5.10.3（MIT），网页 WSS 通信用；见仓库根 `THIRD-PARTY.md` |

由 nginx 的 `alias` 指过来（`../nginx/iot.conf.template` 里的 `__IOT_ROOT__` 由
`../toggle.sh` 渲染时填）。**别在别处再放一份**：`frontend/README.md` 的版本号表里
第 4 个同步点指的就是这个文件。

## 它不自带域名

页面里 HTTP/WSS 一律走当前站（相对路径 + `location.hostname`），唯一的部署参数是
**MQTTS 端口**，写在 `index.html` 内联脚本开头的 `MQTTS_PORT`（默认 8883）——
它只用在页面上那行给人看的"设备接入 mqtts://<域名>:<端口>"提示里。
改了 EMQX 的 8883 监听端口就跟着改这里（`../emqx/README.md`）。

## 它要什么才算能跑

| 依赖 | 少了会怎样 |
|---|---|
| nginx 那个 location（`../toggle.sh on`） | 页面打不开 |
| device-service（`../device-service/`） | 页面能开，但设备列表是空的、报错 —— 所有数据都走 `/device-api/*` |
| EMQX + `/mqtt` 那个 location | 页面能开、设备能列，但遥测不实时刷新、参数下发的确认状态不动 |

## 与看板娘的关系

页面末尾引了 `/live2d-widgets/boot.js?v=<VER>`（与博客同款，nginx 直服 dist 下的那份）。
**改看板娘版本号时这里要跟着 bump**——它是 `frontend/README.md` 那张"五个同步点"表里的第 4 条。

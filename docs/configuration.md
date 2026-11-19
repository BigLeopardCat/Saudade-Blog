# 配置导航

开发样例以[环境模板](../.env.example)为准；容器必需值和启用开关以
[Compose 指南](../deploy/docker/README.md)为准。本文区分配置归属，不复制默认值和完整密钥表。

## 来源与生效边界

开发从自己的 `.env` 加载，进程环境优先。原生生产使用 `/etc/saudade/blog-runtime.env`，
运行工作目录独立于源码；容器由部署编排注入。配置文件不提交 Git，也不交给浏览器。
前端 `VITE_*` 在构建时生效；仅修改后端环境不会改变已发布的前端静态文件。

| 用途 | 关键字段或位置 | 条件与详细入口 |
| --- | --- | --- |
| 核心后端 | `DATABASE_URL`、`JWT_SECRET`、`SITE_URL` | 必需的业务库、随机登录密钥及本站来源；[运维](deployment-and-ops.md#配置) |
| 前端来源 | `VITE_SITE_URL` | 与实际公开来源一致，构建时注入 |
| 本地图库 | `UPLOAD_DIR` | 持久目录，与数据库一起备份，不放可替换的发布目录 |
| R2 图库 | 后台存储设置、`R2_IMAGE_*` | 可选，桶/前缀/地址与服务端凭据一致；[图库](deployment-and-ops.md#图库存储) |
| 发布产物 | 私有部署配置的 `R2_ENDPOINT/ACCESS_KEY/SECRET_KEY/BUCKET` | 与图库凭据独立；[发布工具](deployment-and-ops.md#发布工具配置) |
| Agent 聊天 | `AGENT_URL`、`AGENT_ASSERTION_SECRET`、`BLOG_DELEGATION_SECRET` | Agent 独立服务和状态库；[安全边界](security-boundary.md) |
| AI 审核 | `AI_REVIEW_URL` 等审核配置 | 可选，未启用时仍可人工审核 |
| 图片生成 | 环境模板中的生图供应商配置 | Rust 直接调用，管理员审批参数后才生成，结果入库另批 |
| 设备演示 | 独立网关与 `DEVICE_SIGNING_SECRET` | 可选，不是博客安装前置；[设备接口](iot-device-integration.md) |

完整可选字段见环境模板和对应实现。发布构建关闭文章向量图谱，`GRAPH_*` 环境变量仅供保留的实现和离线建图工具使用，无法开启前端入口或在线查询。
[架构](architecture.md#可选能力)说明核心博客与可选服务的边界。

## 三种跨仓固定版本

- `frontend/widget.lock.json`：组件提交和资源子树，影响浏览器。
- `deploy/docker/agent.lock.json`：容器组合的 Agent 源码版本。
- Agent 仓 `.github/host-contract.json`：Agent 测试所读宿主源码，不表示生产后端版本。

这些锁用途不同，不为追赶 HEAD 同步更新。核对运行实例还需前端 build-info、后端产物出处及
Agent `/version`。接入与升级步骤见[部署](../deploy/docker/README.md)，故障见[排障](troubleshooting.md)。

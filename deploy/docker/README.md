# Docker 自建部署

一条 `docker compose up -d` 起整套站：MySQL + Rust 后端 + Python agent（看板娘）+ nginx。

```bash
git clone <父仓> saudade-blog && cd saudade-blog/deploy/docker
git clone https://github.com/BigLeopardCat/saudade-blog-agent.git ../../saudade-blog-agent   # 见 §1.1
bash prepare.sh                       # 交互向导：域名 / 模型 key / 管理员口令
docker compose build && docker compose up -d
```

跑完按 §3 的《验收清单》逐条 curl 一遍 —— 那 11 条每一条都能判死。

---

## 0. 先读：这条路的边界

**它是给"自己有一台 Linux 机器、有一个域名"的人用的**，不是云厂商的一键镜像。下面几条是设计
取舍的直接后果，装到一半才发现会很难受：

| 边界 | 为什么 |
|---|---|
| **Linux-only** | 三个服务用 host 网络（见下），Docker Desktop（Mac/Windows）上 host 网络不成立 |
| **占宿主 80/443**（nginx）、**3000**（Rust）、**8010**（agent，后两个只绑回环）、**127.0.0.1:3306**（MySQL） | 同一件事：后端与 agent 的监听地址在源码里硬编码成回环，桥接网络下 nginx 容器够不到它们。唯一替代是改那两行 —— 那是"为了迁就容器去松开一条安全边界"，不值当 |
| **宿主上不能已经有别的 MySQL 占 3306** | 只有这一个端口发布到宿主 |
| **镜像只能本地 build，不许推进 registry** | 前端镜像里含 Cubism Core（Live2D 专有许可，构建期从官方 CDN 取、sha256 钉死）。随镜像分发就是再分发 |
| **没有 IoT / 设备控制台** | 那半边（device-service）不在任何公开仓。agent 侧 `IOT_ENABLED` 缺席 ⇒ 它不会指路到一个不存在的页面 |
| **≥4GB 内存、≥8–10GB 盘** | `docker compose build` 要跑 `vite build`（默认堆 3072MB，小机器用 `NODE_HEAP=4096`）。构建期要能连 crates.io / npmjs / PyPI / GitHub / cubism.live2d.com，任一处不通就硬失败 |
| **没有 logrotate / 心跳 / trace 保留 / 部署管线** | 裸机那套的这些件在容器路径里没有等价物 ⇒ 日志、trace、上传件会**无界增长**，自己挂个 cron 清（§4.5）。「服务器健康度」这类接口（`agent/hostinfo.py` 读宿主机 + 依赖 systemctl）在容器里不成立 |

**它和裸机安装路（`deploy/install.sh`）的关系**：nginx 配置由**同一份** `deploy/nginx/render.sh`
渲染 —— 同一组输入下两条路的产物**逐字节相同**（这条判据在 `bash check.sh` 里，本机无 docker
也能跑）。两份 `.env` 的底稿也都是两个仓自己的 `.env.example`，键集合的单一事实源没有第二份。

---

## 1. 跑起来

### 1.1 前置

- Docker Engine + `docker compose`（v2，命令是 `docker compose` 不是 `docker-compose`）
- 一个**解析到这台机器**的域名，80/443 对外开放
- `openssl`（生成随机口令与自签证书用）
- **agent 是另一个仓**，必须克隆在父仓根下、且目录名就叫 `saudade-blog-agent`：

  ```bash
  git clone https://github.com/BigLeopardCat/saudade-blog-agent.git saudade-blog-agent
  ```

  缺了它 `prepare.sh` 会在第一步报错并给出这条命令。

### 1.2 `prepare.sh`（宿主侧，**不需要 docker**）

交互向导（推荐第一次这么跑）：

```bash
bash prepare.sh
```

它问：域名、站名/描述/署名/keywords、管理员用户名与口令、MySQL 口令、JWT 密钥、模型提供方
（`deepseek` / `qwen` / `openai`）与 API Key。**口令与密钥一律留空 = 随机生成**，生成的值只落在
`generated/.credentials`（0600）。

非交互（脚本化 / 重跑）：

```bash
bash prepare.sh --domain blog.example.com --provider deepseek --api-key sk-xxxx
```

其余参数见 `bash prepare.sh --help`。两条特别值得知道：

- **`--dry-run`**：只打印要做什么，**一个字都不写**。想知道它会动哪些文件，先跑这个。
- **qwen 必须给 `--base-url`**（形如 `https://dashscope.aliyuncs.com/compatible-mode/v1`）：
  不给的话会落到**代码里那个维护者的业务空间端点**，你的 key 对不上它，症状是每次对话 401。

它做四件事，产物只落在两处（`deploy/docker/generated/` 与数据目录）：渲染 nginx 配置、签一张
**带 SAN** 的自签证书（或装入你已有的证书）、写三份配置、建宿主数据目录。

> **它绝不碰**仓库根 `.env`、`deploy/.credentials`、`deploy/nginx/*` —— 那三样属于裸机那套。
> 判据在 `check.sh` 里（跑完 `git status` 必须干净）。

**再跑一次是安全的**：已有的口令/密钥**一律沿用**（换了等于自锁，见 §4.3），只按新输入重渲染。

### 1.3 构建并起来

```bash
docker compose build            # 小内存机器：NODE_HEAP=4096 docker compose build
docker compose up -d
docker compose ps               # 期望：mysql healthy，其余 running；db-init 是 Exited (0)
```

第一次 `build` 要联网取依赖，**10 分钟量级**。`up -d` 之后 `db-init` 会先跑一遍（建库、建应用
账号、建第一个管理员），它成功了 backend / agent 才会起：

```bash
docker compose logs db-init     # 应当以「✅ 完成。库 saudade_blog：NN 张表」结尾
```

之后**每次 `up -d` 都会重跑它**（幂等：已有表就跳过建库、已有管理员就不再建人），所以你不需要
记"只在第一次跑"这件事。

### 1.4 数据目录

默认 `~/saudade-docker-data`（`--data-dir` 可改，也记在 `deploy/docker/.env` 的
`SAUDADE_DATA_DIR`）。三个服务以**宿主用户**的身份跑（compose 的 `user:`），所以这些目录里的
文件属主是你自己，不会被 root 占住。

| 目录 | 谁写 | 是什么 |
|---|---|---|
| `uploads/` | backend | 上传的图片/附件（`/api/protect/upload`） |
| `logs/frontend/monitor.log` | backend | 前端错误上报（`/api/monitor/log`） |
| `traces/<YYYYMMDD>/` | agent | 每轮对话一份 JSON trace（含分段耗时，排障第一现场） |
| `agent-data/` | agent | uv 缓存 + 全站问答图谱产物（`word_graph/web`，backend 只读挂它） |
| `mysql-data`（**命名卷**，不在上面） | MySQL | 数据库。`docker compose exec mysql mysqldump …` 备份，见 §4.5 |

---

## 2. 配置住在哪（一个键只有一个写者）

| 文件 | 谁读它 | 里面是什么 |
|---|---|---|
| `deploy/docker/.env` | compose 自己（插值） | 站点身份（要传进前端**构建期**）、数据目录、属主 uid/gid、MySQL root 口令 |
| `generated/backend.env` | backend 容器（env_file） | `DATABASE_URL` / `JWT_SECRET` / `SITE_URL` / `AGENT_URL` / 站点文案… |
| `generated/agent.env` | agent 容器（env_file） | `JWT_SECRET`（与上一份**逐字相同**）/ `BLOG_API_BASE` / 模型 key / `TRACE_DIR`… |
| `generated/.credentials` | 你看 + db-init 当 env_file | 三条口令与 JWT 密钥的原始记录（0600） |
| `generated/blog.conf`、`generated/ssl/` | nginx 容器（只读挂载） | 站点配置与证书 |

`generated/` 与 `.env` 都在 `.gitignore` 里 —— **秘密不会进 git**。

后端与 agent 的 `.env` 底稿就是各自仓的 `.env.example`：想加一个键，改那份 example 再重跑
`prepare.sh`（已有的那份不会被重写，只覆盖它管的那几项）。

---

## 3. 验收清单（11 条，每条都能判死）

先备两个变量（口令从 `generated/.credentials` 取，不要打到聊天窗口里）：

```bash
DOM=$(grep '^SITE_DOMAIN=' .env | cut -d= -f2)
PW=$(grep '^ADMIN_PASS=' generated/.credentials | cut -d= -f2)
TOKEN=$(curl -s -X POST https://$DOM/api/login -H 'Content-Type: application/json' \
        -d "{\"username\":\"admin\",\"password\":\"$PW\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"])')
```

| # | 命令 | 期望 |
|---|---|---|
| 1 | `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/login` | `405`（GET 打 POST 路由 ⇒ Rust 活着） |
| 2 | `curl -s http://127.0.0.1:8010/health` | `"agent_ready": true`（**不代表模型 key 可用**，那只在第 6 条判） |
| 3 | `curl -sk https://127.0.0.1/ \| grep -o '<link rel="canonical"[^>]*>'` | 里面是 `$SITE_URL`，**不是** `localhost:5173`（构建期变量真的进去了） |
| 4 | 看板娘三件套，三条都 `200`：`for u in /live2d-widgets/chat-stream.js /live2d_model/agent_2.model3.json /cubism5/live2dcubismcore.min.js; do curl -sk -o /dev/null -w "$u %{http_code}\n" https://$DOM$u; done` | 全 `200`。非 200 = 镜像里没取到看板娘（构建期的 `fetch:widget` / `vendor:live2d` 没过） |
| 5 | `docker compose exec backend date '+%F %T %z'`；`docker compose exec mysql mysql -uroot -p"$(grep '^MYSQL_ROOT_PASSWORD=' generated/.credentials\|cut -d= -f2)" -N -B -e 'SELECT NOW(), @@global.time_zone'` | 前者 `+0800` 且与宿主一致；后者 `+08:00`。**差了 8 小时 = 镜像里没装 tzdata**（`TZ` 在 slim/alpine 里是空操作） |
| 6 | 见下面「第 6 条：真聊一轮」 | 过程行里有工具帧，回复**不是**"站内服务不可用" |
| 7 | 拿一张真图片：`curl -sk -X POST https://$DOM/api/protect/upload -H "Authorization: Bearer $TOKEN" -F 'file=@/tmp/1.png'` —— 本地存储时 `data` 是形如 `/api/protect/download/<名字>.png` 的相对路径，再 `curl -sk -o /dev/null -w '%{http_code}\n' "https://$DOM$URL"` | `200`（顺带验 `^~ /api/` 那条规则没被改坏 —— 少了它，上传接口会被 `=404` 判死） |
| 8 | 聊一轮后：`ls -t ~/saudade-docker-data/traces/$(date +%Y%m%d)/ \| head -3` | 有刚生成的文件；**今天这个目录**里没有昨天的时间戳（有 = 时区差一天） |
| 9 | `curl -s -X POST https://$DOM/api/monitor/log -H 'Content-Type: application/json' -d '{"kind":"other","message":"docker smoke test"}'` 然后 `docker compose exec backend tail -1 /srv/logs/frontend/monitor.log` | 最后一行有 `docker smoke test`（打不开父目录也返回 200 ⇒ 这是**唯一**能判它的方式） |
| 10 | `curl -s -X POST https://$DOM/api/protected/graph/rebuild -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'`，再 `curl -s https://$DOM/api/protected/graph/rebuild/status -H "Authorization: Bearer $TOKEN"`；最后 `curl -sk -o /dev/null -w '%{http_code}\n' https://$DOM/api/public/graph/manifest` | 接口通、status 里有日志；manifest `200`。**没配 embedding 的话重建会如实报错** —— 那条错误本身就是判据（说明接口通了），不是故障 |
| 11 | 改 `generated/backend.env` 里一个值 → `docker compose restart backend` **不生效**；`docker compose up -d` 才生效 | 这条判的是 §4.1 那句话本身。**环境变量在容器创建时定死**，`restart` 复用的是同一个容器 |

### 第 6 条：真聊一轮（一条同时验四件事）

它同时验：两份 `.env` 的 `JWT_SECRET` 一致（否则 401）、`BLOG_API_BASE` 可达、**自签证书被 agent
信任**、模型 key 有效。

```bash
curl -skN -X POST https://$DOM/api/chat/stream \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"message":"看看站里现在有哪些分类"}' | head -40
```

怎么读结果：

- 流里应当出现 `__PROCESS__` 里带 🛠/✅ 的**工具帧** —— 那是"模型真的调了工具"。
- 回复内容：新库没有分类，**如实说"还没有分类"是达标的**。
- **不达标的样子**：回复说"站内服务不可用 / 我连不上站内数据"。那是 agent 的 CA bundle 没生效
  （`verify=True` 时对自签证书校验失败，工具静默降级成"服务不可用"）—— 检查
  `generated/ssl/trusted.crt` 与 agent 容器里的 `/etc/ssl/extra/trusted.crt` 是不是同一份。

**发过文章之后再补一条更硬的**：问「站内搜索『部署』，列出前 3 篇的标题和链接」—— 回复里必须
出现**你自己库里的真标题**。只有泛泛而谈、没有真标题，就还是上面那个 CA 问题。

### 崩了贴什么

```
docker compose ps
docker compose logs --tail=200 <出问题的那个服务>
docker compose logs --tail=200 db-init
docker compose exec backend date
generated/blog.conf          # 如果怀疑是 nginx / 路由
```

> ⚠️ **不要贴 `docker compose config` 的输出**：它会把 `.env` 里的 MySQL root 口令**原样打出来**。
> 同理，贴之前先扫一眼有没有口令/密钥。

---

## 4. 日常

### 4.1 改配置：`restart` 还是 `up -d`？

**判据是"改的是什么"，不是"改了哪个文件"：**

| 改的东西 | 命令 | 为什么 |
|---|---|---|
| 挂进容器的**文件内容**（`generated/blog.conf`、证书、`monitor.log` 之类） | `docker compose restart <服务>` | 进程重跑会重读文件 |
| **变量**（`.env`、`generated/*.env`、compose 里的 `environment:`） | `docker compose up -d` | 环境变量在容器**创建时**定死，`restart` 复用同一个容器 ⇒ 改不动它 |
| 源码（`src/`、`frontend/`、agent 仓） | `docker compose build <服务> && docker compose up -d` | 要重新构建镜像 |

「改了没生效」十有八九是第二种情况用了 `restart`。

改了 nginx 配置之后，`restart` 之前值得先验一句（镜像里有 `nginx`）：

```bash
docker compose run --rm --entrypoint nginx nginx -t
```

### 4.2 四个只读进程环境旋钮

下面四个走 `os.environ`（`server.py`），**写进 `generated/agent.env` 是无效的** —— 只能在
`compose.yaml` 的 agent 服务 `environment:` 里解注释，然后 `docker compose up -d`：

```yaml
      AGENT_RECURSION_LIMIT: "30"           # 图的最大轮次（默认 30）
      AGENT_MAX_BODY_BYTES: "12582912"      # 请求体上限，12MiB（默认）
      AGENT_MAX_CONCURRENT: "8"             # 并发流上限（默认 8）
      AGENT_MAX_REVIEW: "4"                 # 审核侧任务并发（默认 4）
```

`AGENT_WORKERS`（默认 4）与 `NODE_HEAP`（构建期，默认 3072）是 `.env` 里的拨盘：前者每 worker
常驻 135–150MB，小内存机器写 `AGENT_WORKERS=2`；后者写 `NODE_HEAP=4096 docker compose build`。

### 4.3 改口令（三条各不相同，别想当然）

| 口令 | 改法 |
|---|---|
| **MySQL 应用账号**（`DB_PASS`） | 改 `generated/.credentials` → **重跑 `bash prepare.sh`**（它同步进 `backend.env` 的 `DATABASE_URL`）→ `docker compose up -d`。**这条是真能收敛的**：db-init 每次都 `ALTER USER` |
| **MySQL root**（`MYSQL_ROOT_PASSWORD`） | 它只在数据卷**第一次**初始化时生效 ⇒ **改文件没用**。进容器改：`docker compose exec mysql mysql -uroot -p<旧口令> -e "ALTER USER 'root'@'%' IDENTIFIED BY '<新口令>';"`，再回来改 `.credentials` 与 `.env` |
| **管理员登录口令**（`ADMIN_PASS`） | db-init 只在**一个管理员都没有**时才 INSERT ⇒ **改文件没用**。改库里那一行：`docker compose exec mysql mysql -uroot -p<root口令> saudade_blog -e "UPDATE \`user\` SET password=SHA2('<新口令>',256) WHERE username='admin';"`（首次登录成功后那行会自动升级成 Argon2id） |
| **JWT_SECRET** | 改了就**所有人重新登录**（旧令牌签名不再匹配）。两份 `.env` 必须**逐字相同** —— 由 `prepare.sh` 保证，别手动只改一份 |

### 4.4 换证书 / 换域名

- **换正式证书**：`bash prepare.sh --cert-file 链.crt --cert-key 私钥.key --domain <原域名>` →
  `docker compose restart nginx`。agent 那侧要跟着重读信任链：`docker compose up -d agent`
  （`trusted.crt` 是启动时拼进 CA bundle 的）。
- **换域名**：改 `.env` 的站点身份 + 重跑 `prepare.sh` → **必须 `docker compose build nginx`**
  （站名/URL 是**构建期**烤进 HTML 的）→ `docker compose up -d`。别忘 DNS 与
  `compose.yaml` 里 agent 的 `extra_hosts` 会用新域名。

### 4.5 备份与恢复

```bash
# 备份（库里 + 上传件都要）
docker compose exec mysql sh -c 'exec mysqldump --single-transaction -uroot -p"$MYSQL_ROOT_PASSWORD" saudade_blog' > backup-$(date +%F).sql
tar czf uploads-$(date +%F).tgz -C ~/saudade-docker-data uploads

# 恢复
docker compose exec -T mysql mysql -uroot -p<root口令> saudade_blog < backup-2026-10-07.sql
```

`mysql-data` 是个**命名卷**（`saudade-blog_mysql-data`）：`docker compose down -v` 会**连它一起删**，
等于删库 —— 别顺手加 `-v`。

**无界增长的三样**，自己挂 cron 清：`traces/`（按天目录）、`logs/`、`uploads/`。

### 4.6 更新

```bash
git pull && git -C saudade-blog-agent pull
bash prepare.sh            # 键有变化时补齐（已有的口令不会动）
docker compose build && docker compose up -d
```

与下面那套（CI → R2 → systemd）没有任何关系，是本机自洽的。

---

## 5. 这个目录里每个文件是什么

| 文件 | 作用 |
|---|---|
| `compose.yaml` | 五个服务：mysql（桥接 + healthcheck）、db-init（一次性）、backend / agent / nginx（host 网络） |
| `prepare.sh` | 宿主侧跑一次：收集 → 渲染配置/证书 → 建数据目录 |
| `db-init.sh` | 建库（复用 `scripts/migration/fresh_install.sh`）→ 应用账号 → 第一个管理员，**幂等** |
| `agent-entrypoint.sh` | 把站点证书拼进 CA bundle（`SSL_CERT_FILE`）→ `exec uvicorn` |
| `Dockerfile.backend` / `.frontend` / `.agent` | 三个镜像；构建上下文统一是**仓库根**（`context: ../..`） |
| `check.sh` | 离线判据（本机没 docker 也能跑），见下 |
| `generated/`、`.env` | 运行时产物，**不入库**（`.gitignore`） |

## 6. 离线自检

```bash
bash check.sh
```

它判的全是"错了就静默"的那几件事：脚本语法与 `--dry-run` 的边界、compose 的解析/网络/重启语义
与引用完整性、**nginx 配置与裸机侧逐字节一致**（附"换域名会变"的反面判据）、键集合不漂、
「写进 `agent.env` 的每个键 agent 那边真的有读取路径」、镜像里那几条承重指令、`db-init.sh` 五种
场景（用桩 mysql 跑：空库/已有表/已有管理员/建库假成功/同名非管理员账号），以及**把裸机那侧
`deploy/install.sh` 的 `setup_env` 真跑一遍**（复制到 scratch、摘掉末尾的 `main` 再 source）：
全新的 `.env` 里不许留下 `.env.example` 的占位值、已有的 `.env` 一个键都不许被改、
`DATABASE_URL` 里的口令编码后可逐字节还原，外加"两份 `urlenc` 实现输出逐字相同"。

**它随时可以跑**（本机无 docker、全新 clone 都行）：还没跑过 `prepare.sh` 时，依赖生成物的那两档
会标 `↷ 跳过` 而不是判红 —— 绿色的含义始终是"没坏"，不是"你还没装"。

**它判不了**（要靠 §3 那 11 条）：镜像能构建、容器能起来、证书被信任、模型能调工具。

# 使用预构建产物快速安装

带预构建附件的 Release 提供两种 Linux x86_64 安装包，避免在小服务器重新编译 Rust 与前端。两种附件来自同一完整提交和经安装、备份恢复验证的 CI 镜像。站点数据和密钥由部署者单独配置。

| 附件 | 用途与环境 |
| --- | --- |
| `saudade-blog-VERSION-images-linux-amd64.tar.gz` | 推荐。Linux amd64 + Docker Engine + Compose 2.30+，包含博客后端、前端、固定 Agent 和 PostgreSQL 镜像；无需安装 Rust、Node 或 Python 项目依赖 |
| `saudade-blog-VERSION-linux-x86_64.tar.gz` | 原生 systemd 部署；包含两个二进制、可移植前端和对应提交的源码。编译基础为 Debian 12/glibc，目标机须有兼容的动态加载器及共享库 |
| `release-manifest.json` | 完整源码、Agent/组件版本、实际镜像 ID、Rust 编译器、构建系统、每个二进制的最低 glibc、动态库及归档哈希 |
| `SHA256SUMS` | 校验所下载附件，防止损坏或混用版本；应从同一个可信 Release 获取 |

`VERSION` 替换为该 Release 的版本号，例如 `0.3.0`。不把相同发行版名称视为充分兼容条件；优先核对架构、glibc 和共享库。ARM、Alpine/musl、Windows 原生、macOS 原生未提供原生包，使用适合目标平台的源码构建；容器包仅验证 Linux amd64，不承诺模拟运行。

## 1. 下载与校验

从[项目 Releases](https://github.com/BigLeopardCat/Saudade-Blog/releases)下载所选归档、manifest 和 SHA256SUMS，放在同一个新目录。不要从他人构建日志或不明镜像下载可执行文件。

```sh
sha256sum --check --ignore-missing SHA256SUMS
python3 -m json.tool release-manifest.json
```

每个下载的归档必须显示 `OK`；`--ignore-missing` 只允许另一种未下载的安装包缺席，不能忽略校验失败。核对 manifest 的 `source_revision`、`agent_revision` 和 Release 说明一致。公开归档不需要、也不会附维护者的数据库或模型凭据。

从同一份已校验的 manifest 提取版本和宿主提交，后续命令在同一个 shell 中执行。

```sh
RELEASE_VERSION="$(python3 -c 'import json; print(json.load(open("release-manifest.json"))["version"])')"
SOURCE_REVISION="$(python3 -c 'import json; print(json.load(open("release-manifest.json"))["source_revision"])')"
```

## 2. 推荐：导入容器镜像并安装

要求 Docker Compose 2.30+，首次安装步骤及工具安装链接见 [Compose 指南](docker/README.md)。以下示例仅用于新站点、新的私有状态目录，不接管已有数据库。

```sh
docker load --input "saudade-blog-$RELEASE_VERSION-images-linux-amd64.tar.gz"
git clone --branch "v$RELEASE_VERSION" --single-branch https://github.com/BigLeopardCat/Saudade-Blog.git
cd Saudade-Blog
test "$(git rev-parse HEAD)" = "$SOURCE_REVISION" &&
  bash deploy/install.sh --site-url http://localhost:8080 --prepare-only
```

`git rev-parse HEAD` 必须等于 manifest 的 `source_revision`。`--prepare-only` 只生成配置；先按指南检查站点地址、监听范围和初始管理员信息，再启动：

```sh
bash deploy/install.sh --reuse --no-build
```

`--no-build` 直接使用完整 SHA 标记的镜像；缺失时应处理版本或导入问题，不自动回退到另一版或本机编译。先访问 `http://localhost:8080` 登录，确认 `/api/health/ready` 和 `/build-info.json`，首次登录后修改密码。

需要 Agent/后台计划时，在第一次准备配置时按 [Compose 指南](docker/README.md)选择 `--with-agent`/`--with-scheduler` 并提供自己的私有模型 key 文件。镜像包已经包含锁定 Agent 镜像，但仍需准备该提交的公开源码供安装器校验，不会编译模型或自动获得模型调用额度。不要将密钥写进命令参数、文章或截图。

升级现有容器站点前按指南备份数据库、上传目录与配置，核对适用的[编号迁移和先后顺序](../docs/deployment-and-ops.md#postgresql)。公开 RAG 语料使用 0039 的版本投影，已有数据库先完成该迁移，再切换宿主读流量。导入新包后使用指南的升级流程并增加 `--no-build`，复用现有数据卷和私有状态。回退应用与恢复持久数据分别演练。

## 3. 可选：原生部署复用二进制与前端

适合已有 PostgreSQL、nginx 和 systemd 的维护者。从附件下载目录解压到新位置，保留旧版本和状态。

```sh
tar -xzf "saudade-blog-$RELEASE_VERSION-linux-x86_64.tar.gz"
cd "saudade-blog-$RELEASE_VERSION"
uname -m
getconf GNU_LIBC_VERSION
ldd target/release/saudade_blog_bin
ldd target/release/saudade-bootstrap-admin
```

应为 `x86_64`，glibc 不低于 manifest 中两个二进制的要求，`ldd` 无 `not found`。系统需有 CA 证书及正确时区数据。不要把下载来的 libc 覆盖进系统来强行运行；不兼容时使用容器或源码构建。

归档中 `target/release/saudade_blog_bin`、`target/release/saudade-bootstrap-admin` 和 `frontend/dist/` 已构建完成，可跳过 `cargo build --release` 和 `npm run build`。其余数据库初始化、迁移、私有配置、服务账号、持久上传目录、nginx 和 systemd 设置仍按[原生部署](../docs/deployment-and-ops.md)及[账号隔离](service-isolation.md)执行。没有 `.git` 的归档目录不能直接运行要求干净 Git checkout 的 Compose 安装器。

前端采用可移植域名模式，浏览器使用当前来源，静态标题/描述是中性值，不包含维护者域名或 CDN。需要专属静态 SEO/OG 元数据时按[配置导航](../docs/configuration.md)自行构建前端；不必为此重新编译 Rust。原生 nginx 的 robots/sitemap 按自己的公开域名配置。

新安装使用 `saudade-bootstrap-admin PRIVATE_JSON_FILE` 创建第一个超级管理员；它通过进程环境读取 `DATABASE_URL`，不自动加载 `.env`。JSON 结构为 `username`、`nickname`、`password`，不要添加角色字段。仅由安装管理员通过受控环境/临时 systemd 单元注入自己的数据库配置，文件使用 0600、放私有配置目录，成功后移除临时明文凭据。已有用户表不用于重新初始化管理员。

启动后检查就绪、登录、文章读取、上传和前端资源；Agent 单独检查 `/ready` 和 `/version`。原生包通过镜像内业务烟测及 CI 动态库检查，不等于你的机器已经完成 nginx、systemd、数据库和外部服务接线验证。

## 4. 构建、校验与发布

制作新版本的步骤见[博客发行维护](releasing.md)。

## 5. 许可与限制

包保留博客 GPL、Agent 代码 MIT、美术 CC BY-NC-SA 及第三方许可。Live2D Cubism Core 遵循其独立专有条款；完整资源约束见 [THIRD-PARTY](../THIRD-PARTY.md) 和归档中的 `licenses/`。预构建不改变非商用美术限制。可选 embedding/tokenizer、GPU 运行时、站点数据和模型凭据不在包内。

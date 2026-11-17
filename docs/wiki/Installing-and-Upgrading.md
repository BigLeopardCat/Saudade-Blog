# 从零安装到第一次登录

这条路线适用于**新的 Linux 主机或独立测试环境**。已有站点直接看本页升级部分，
不重建数据库或覆盖配置。默认只安装核心博客，Agent、调度、R2 和模型均为可选。

## 1. 准备环境与地址

准备 Git、Python 3.10+、Docker Engine、Docker Compose 2.30+，用部署账号核对：

```sh
git --version
python3 --version
docker --version
docker compose version
```

缺少工具时先完成系统对应的安装；Docker 访问权限相当于主机管理权限。
构建需要联网和足够资源。低内存生产机使用构建机/CI 导出的镜像，不在生产反复完整编译。

先决定站点地址：本机体验用 `http://localhost:8080`；公开访问用自己的域名和 HTTPS。
域名解析到服务器、证书及反向代理是另外的准备工作。Docker 服务名不能作为公开网址。

## 2. 取得源码，选择安装方案

```sh
git clone --branch cn_sora_blog https://github.com/BigLeopardCat/Saudade-Blog.git
cd Saudade-Blog
git rev-parse HEAD
```

记录完整提交。生产选择自己已验证的发布/提交，不自动追随远端 HEAD；安装器要求干净源码。
以下两种方案**择一**，在首次生成配置前决定。

### 方案 A：先体验核心博客

```sh
bash deploy/install.sh --site-url http://localhost:8080 --prepare-only
```

只生成私有配置，暂不启动服务。默认本机绑定 `127.0.0.1:8080`，外部设备不能直接访问它。

### 方案 B：同时启用 Agent 和后台计划

先建立只有自己可读的密钥文件，用编辑器填入一行模型密钥，真实密钥不要写进命令历史：

```sh
install -d -m 700 ~/.config/saudade
install -m 600 /dev/null ~/.config/saudade/model-key
nano ~/.config/saudade/model-key
bash deploy/install.sh --site-url http://localhost:8080 \
  --with-agent --with-scheduler \
  --model-key-file ~/.config/saudade/model-key --prepare-only
```

默认模型适配器是 OpenCode，密钥必须匹配其端点；使用其他供应商时，在启动前按
[Agent 配置教程](https://github.com/BigLeopardCat/saudade-blog-agent/wiki/Configuration)修改生成的 agent.env。
不需要后台计划就省略 `--with-scheduler`。不要先按 A 生成配置，再期待追加首次参数会自动切换方案。

## 3. 审阅配置与首次账号

默认私有目录是 `~/.local/share/saudade/compose`。用编辑器查看：

- `backend.env`：博客服务端配置。
- `agent.env`：启用 Agent 时的模型与状态配置。
- `administrator.json`：首次站长用户名、昵称与初始密码。

不要 `cat` 后把整份内容发到工单，也不要 source 执行 env。逐项填写方式见
[站点与环境配置](https://github.com/BigLeopardCat/Saudade-Blog/wiki/Site-Configuration)。

首次账号默认为超级管理员，只有空用户表允许创建。可在首次启动前修改管理员文件的账号、昵称和密码，
保留文件 0600 权限，不增加 role 字段。首次账号密码规则见安装指南；它与后台临时账号入口不同。

## 4. 启动、登录与验收

```sh
bash deploy/install.sh --reuse
curl --fail http://127.0.0.1:8080/api/health/ready
```

浏览器打开 `http://localhost:8080`，用管理员文件中的账号登录，先在个人中心更换初始密码。
初始文件不会随登录后的密码变更自动更新；重新运行安装器不会重置旧账号。

依次完成：

1. 打开首页和后台，检查站点地址与登录。
2. 建一个分类与主/子标签。
3. 写一篇测试草稿、选封面并发布，去前台验证。
4. 启用 Agent 时，再验证只读问题、确认卡和取消，最后测试提醒。
5. 建立数据库、上传文件和私有配置的备份，并在隔离环境恢复。

就绪通过说明服务准备状态，不证明全部模型、R2 或业务操作均已验收。

## 5. 公开访问和 HTTPS

默认回环端口适合由宿主反向代理提供公网 HTTPS。也可让容器 nginx 直接终止 TLS，
按[证书与端口配置](https://github.com/BigLeopardCat/Saudade-Blog/blob/cn_sora_blog/deploy/docker/README.md#tls-与隔离)配置自己的域名、证书和监听地址。
证书续期不会自动完成；不要只把 URL 改成 https 却没有证书与 TLS 监听。

## 已有站点升级

1. 记录实际博客、Agent 和组件版本，备份数据库、上传和私有目录。
2. 审查新增 PostgreSQL 编号迁移，在隔离库验证后执行适用增量；不重跑基线。
3. 切到已验证的博客完整提交，执行安装器 `--reuse --upgrade`，它不替代数据库迁移。
4. 核对 `/api/health/ready`、`/build-info.json`，启用 Agent 时在内部核对 `/ready`、`/version`。
5. 验证真实页面与关键操作；异常时先确认 schema 向后兼容，再回到原版本。

不要用删除卷的方式“重新安装”。已有核心博客追加 Agent、离线镜像交付与完整回滚命令见
[容器指南](https://github.com/BigLeopardCat/Saudade-Blog/blob/cn_sora_blog/deploy/docker/README.md)。
原生 systemd 实例走[原生运维](https://github.com/BigLeopardCat/Saudade-Blog/blob/cn_sora_blog/docs/deployment-and-ops.md)，不混用两套状态目录。

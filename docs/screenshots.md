# 教程截图维护

教程源码为 `docs/wiki/*.md`，教程图片为 `docs/wiki/assets/`。文件名按操作命名，教程在对应步骤展示，
并提供说明。教程图片使用合成账号、示例域名和占位图，不代表真实站点配置、付费输出或生产执行证据。

## README 实际界面预览

两个语言版本的 README 使用 `docs/assets/readme/` 下的实际公开界面截图：

| 文件 | 内容 |
| --- | --- |
| `blog-home-zh-CN.jpg`、`blog-home-en.jpg` | 博客首页、文章入口与看板娘 |
| `lingyue-chat-zh-CN.jpg`、`lingyue-chat-en.jpg` | 展开的看板娘对话框与快捷提问 |

图片来自 `https://saudade.site/` 的全新匿名浏览器上下文，未登录、未发送消息，也不代表模型回答或管理操作的执行结果。中英文分别截图，文章内容保留原文；截图中的角色及美术沿用其原有资源许可。

在 GitHub Actions 的 **Wiki screenshots** 手动运行中勾选 `public_readme`，获取 `readme-screenshots` 产物。`frontend/scripts/capture-readme.mjs` 只允许 GET、HEAD、OPTIONS 请求，不提交登录、对话或其他写操作；只在独立开发环境或托管 CI 中运行。产物的 `capture.json` 记录截图时间、地址、语言和视口。检查图片完整性后按稳定文件名更新，勿提交账号状态或浏览器存储。JPEG 在截图时压缩，中英文 README 引用各自的本地图，不依赖临时 CI 地址。

## 当前图片与插入位置

| 文件 | 页面 | 要看清的内容 |
| --- | --- | --- |
| publication.jpg | Writing-and-Publishing | 标题、摘要、分类标签、封面、状态和发布 |
| cover-display.jpg | Writing-and-Publishing | 完整显示与铺满裁切 |
| editor-review.jpg | Writing-and-Publishing | 红删绿增、逐处和全部采纳 |
| category.jpg | Categories-and-Tags | 名称、访问路径、介绍及创建按钮 |
| tags.jpg | Categories-and-Tags | 父子层级与正在编辑哪一级 |
| users.jpg | Users-and-Permissions | 合成账号、角色、额度、冻结禁言与身份操作 |
| announcement.jpg | Announcements-and-Messages | 公告标题、完整正文与保存 |
| gallery.jpg、gallery-detail.jpg | Gallery-and-Image-Generation | 明确选择、文件夹、详情与元数据 |
| gallery-cover.jpg | Gallery-and-Image-Generation | 图库选择后的实际封面预览 |
| generation-request.jpg、generation-result.jpg | Gallery-and-Image-Generation | 生成批准与结果保留是两次决定 |
| r2-settings.jpg | Site-Configuration | 桶、前缀、来源、配额与使用量，密钥不在页面填写 |

首批图来自托管 CI `44097240479`，组件与锁定依赖对应截图来源提交
`f60aab2a30079007889ec0c677317620d397148b`。发布前实际检查清晰度、状态和数据，
不用失败截图、攻击样例或随意画出的界面代替正常操作。

## 再生成

使用 `.github/workflows/wiki-screenshots.yml` 的托管工作流，或在独立开发环境按相同锁定工具链运行。
`WIKI_SCREENSHOT_DIR` 显式开启保存，`frontend/tests/browser/wiki-shot.ts` 在真实组件场景中采集。
默认行为回归不额外写截图；未声明的网络请求仍由 sandbox 拒绝。不读取生产配置、不付费调用。
维护机不安装浏览器或构建完整前端。

工作流产物只暂存，检查后把选中图片提交到 assets，不把过期 Actions 链接当作永久图床。
JPEG 质量和 CSS 像素由采集器控制，保留可读文字，避免把多兆原始屏幕图直接塞进教程。

## 手工补拍与发布

需要自己的域名、安装界面或其他版本时，按同名步骤截图，保留页面标题、目标和操作按钮。
使用合成内容，不展示真实用户名、私信、访问密钥、初始密码、恢复码或完整连接串。
相同文件名可直接替换；新增步骤同时改教程和此表。环境文件优先可复制示例，不用图片替代命令。

先提交源稿与图片，再同步 GitHub Wiki 的页面与 assets。相对图片链接在 Wiki 转换成对应的
raw.githubusercontent.com/wiki 地址，规范文档链接固定到来源提交。PR 与 Wiki 提交分别记录，
教程发布不等于应用部署。

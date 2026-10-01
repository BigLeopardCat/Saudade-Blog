# 第三方组件与许可

本仓库自身以 GPL-2.0 分发（全文见 [LICENSE](LICENSE)）。它依赖、内联或分发下列第三方
作品，各自仍归原版权人所有、按各自许可使用。这份清单列出**值得单独说明的那些**；完整清单
以 `Cargo.lock`、`frontend/package-lock.json` 与实际安装的 `node_modules` 为准——那里面有
每个传递依赖的准确版本，而它们的许可文件随包分发。

## 1. 构建前自取、不进版本库的运行时

这几份**刻意不入 git**（体积，或与专有许可有关），由 `npm run vendor:live2d` 与
`npm run fetch:widget` 在构建前就位。部署包里会有它们，所以在这里列出。

| 组件 | 版本 | 许可 | 取得方式 |
|---|---|---|---|
| Live2D Cubism Core（`cubism5/live2dcubismcore.min.js`） | 官方当前版 | **专有**（Live2D Proprietary Software License） | 从 Live2D 官方 CDN 取，按 sha256 校验 |
| pixi.js（`live2d-widgets/vendor/pixi.min.js`） | 7.x | MIT | 从 `node_modules` 拷 |
| pixi-live2d-display（`live2d-widgets/vendor/cubism4.min.js`） | 0.4.x | MIT | 从 `node_modules` 拷 |
| mqtt.js（`iot/device-console/mqtt.min.js`，仅启用 IoT 时） | 5.10.3 | MIT | 随设备控制台一起提供 |

**Live2D Cubism Core 不属于本仓库 GPL-2.0 的覆盖范围**，它由 Live2D 公司单独授权，只以
未修改的二进制形式随产物分发；使用 Live2D 产品还需遵守其商标与发布条款（见
<https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_cn.html>）。
若你要把本项目用于商业用途，请自行向 Live2D 公司确认授权范围。

## 2. 看板娘前端（源码在 agent 仓，本仓只按 pin 取用）

`live2d-widgets/` 与 `live2d_model/` 的源码住在
[saudade-blog-agent](https://github.com/BigLeopardCat/saudade-blog-agent)，本仓按
`frontend/widget.lock.json` 钉死的提交号取回并打进产物。它的许可分两半：

- **代码**：MIT（与 GPL-2.0 兼容）
- **美术资源**（模型、贴图、形象设计）：CC BY-NC-SA 4.0，**不可商用**

详见该仓的 `frontend/ASSETS-LICENSE.md`。

## 3. 前端依赖（`frontend/package.json`）

直接依赖里较有存在感的几项：

| 组件 | 用途 | 许可 |
|---|---|---|
| antd、@ant-design/icons、@ant-design/charts | UI 组件与图表 | MIT |
| bytemd、@bytemd/react 及 `plugin-*` | Markdown 编辑器与渲染管线 | MIT |
| KaTeX（`katex`、@bytemd/plugin-math） | 数学公式排版 | MIT |
| highlight.js（@bytemd/plugin-highlight、react-syntax-highlighter 系） | 代码高亮 | **BSD-3-Clause** |
| Mermaid（@bytemd/plugin-mermaid） | 图表渲染 | MIT |
| pixi.js、pixi-live2d-display | 看板娘渲染 | MIT |
| react、react-dom、react-router-dom | 应用框架与路由 | MIT |
| @mui/material、@emotion/react、@emotion/styled | 部分组件 | MIT |
| @reduxjs/toolkit、react-redux | 状态管理 | MIT |
| react-markdown、remark-*、rehype-*、unified、hast-util-sanitize | Markdown 处理 | MIT |
| react-helmet-async | 页面 head 管理 | **Apache-2.0** |
| axios、dayjs、lodash、framer-motion、typed.js、react-countup、react-tagcloud、markdown-navbar、github-markdown-css、botui、@botui/react | 各类工具与组件 | MIT |
| **gsap** | 页面动画 | **GreenSock 标准「免费使用」许可**（不是 OSI 开源许可） |

三条需要留意的：

- **GSAP** 自 3.13 起按 GreenSock 自己的标准许可分发，免费使用的范围覆盖本站这类用途，
  但它不是开源许可。若要商用或用于付费产品，请先读
  <https://gsap.com/standard-license>。
- **highlight.js 是 BSD-3-Clause**（不是 MIT），保留署名即可。
- **react-helmet-async 是 Apache-2.0**，对该组件的修改需按该许可说明。

## 4. 字体与图标

| 资源 | 许可 |
|---|---|
| Font Awesome Free 6.7.2（`live2d-widgets/renderer.js` 的 `ICONS`，工具条图标） | 图标 CC BY 4.0 / 字体 SIL OFL 1.1 / 代码 MIT —— <https://fontawesome.com/license/free> |
| Roboto（@fontsource/roboto） | SIL OFL 1.1 |

## 5. Rust crates

`Cargo.toml` 声明的依赖（axum、tokio、sea-orm、sqlx、serde、tower-http、tracing、
chrono、jsonwebtoken、argon2、reqwest 等）绝大多数是 MIT 或 Apache-2.0（不少是双许可），
准确版本与各自的许可见 `Cargo.lock` 与 crates.io 上各包的元数据。

## 6. 许可兼容性

引入新依赖前先确认许可与本仓库（GPL-2.0）兼容，判据与例外见
[CONTRIBUTING.md](CONTRIBUTING.md) 的《许可》一节，这里只强调三条容易搞错的：

- **MIT / BSD / ISC / Zlib / OFL-1.1**：兼容，可以进本仓源码树。
- **Apache-2.0**：与 GPL-2.0 **不兼容**（专利条款），与 GPL-3.0 才兼容。作为**构建期依赖
  使用**没有问题（本文件 §3 的 react-helmet-async 就是），但**不要把它并进本仓的源码树**。
- **CC BY-NC-SA 4.0**：带非商业限制，**不是 OSI 开源许可**。看板娘的美术资源按它分发，
  属于"同一介质上的聚合"、不是并进本仓源码树，所以不冲突；但它是**独立分发项**——
  分发给第三方时，代码随 GPL-2.0、美术随 CC BY-NC-SA 4.0，边界按"文件是代码还是美术"划。

同理，Live2D Cubism Core 与 GSAP 各有自己的条款，都不并入本仓库的 GPL-2.0 声明。

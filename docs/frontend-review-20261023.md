# 前端复查（2026-10-23）

基线为 `b38b7cd8033fbd14d62fa3a5684b6401bd2b4d6e`，排除 IoT。本次检查公共头部、首页和路由入口、归档/分类、后台账号/文章/待办、Redux 读取、Markdown/Widget 安全边界、依赖与公网响应。不是全站所有页面和所有登录身份的完整浏览器验收。

## 本批修复

| 问题 | 实际影响 | 修复与验证 |
| --- | --- | --- |
| 头像外圈几何遗漏 | 清理 Dashboard/Home 的前台重复样式时，漏迁头像独有的 46px 盒及 Flex 居中，行盒基线重新造成头像偏移 | Head 独立持有固定圆环尺寸，禁止收缩并居中；真实 Chromium 比较圆环/头像中心、宽高，覆盖冷启动及后台样式延迟加载 |
| 登录菜单偏移 | 悬停放大后，原 `left:-2px` 计算忽略边框坐标，浏览器测得水平中心差 6px | 使用 `left:50%` 与 `translateX(-50%)`，按父盒高度放在头像下方；回归验证 2 倍放大后的中心与上下位置 |
| 公开资料故障清除登录 | `store/components/user.tsx::fetchUserInfo` 捕获公开站点资料请求失败后调用 deleteToken；断网或站点资料故障可让有效会话被本机清掉 | 业务信封/对象形状校验，失败保留旧资料及令牌；真实 thunk/reducer 验证网络失败、业务失败、空载荷 |
| 后台先挂载再跳走 | AuthRouter 原来仅在 effect 里重定向，始终渲染 children；未登录/普通用户仍能先触发后台组件 effect 和请求 | 准入失败直接返回 null；订阅本标签页 auth-change、跨标签页 storage 及令牌到期；真实 React 子组件挂载计数覆盖拒绝、准入、退出、换角色和到期。后端授权仍是安全边界 |
| 导航冗余全量文章请求 | 公共 Head 挂载时 dispatch(fetchNoteList())，调用全量 `/api/public/notes`；前台没有读取这个 Redux 文章缓存的活跃消费者，首页另有分页请求 | 删除公共入口的无用读取，保留后台显式加载；浏览器断言 Head 不再请求全量文章。没有据此声称 LCP/INP 的测量提升 |
| DOMPurify 安全补丁 | Mermaid 间接依赖锁定 3.4.16，命中本次 npm audit 公告 | 仅将锁文件中的 DOMPurify 更新到 3.4.17，符合原 Mermaid 的 `^3.2.4` 范围；不跨主版本、不新增直接依赖、不运行强制 audit fix |

DOMPurify 公告需特定选项及 DOM/shadow root/hook 条件：[SAFE_FOR_TEMPLATES 公告](https://github.com/cure53/DOMPurify/security/advisories/GHSA-cg2g-xh64-v4q7)、[IN_PLACE 公告](https://github.com/cure53/DOMPurify/security/advisories/GHSA-mrv2-3pqr-j5jr)。维护方公告的分级与 npm registry 扫描结果不同；不能把扫描器的 Critical 节点标签当成本站已确认的 Critical XSS。未证明本站满足这些利用前提。

## 仍需处理的发现

优先级按本站业务影响排列，不等同安全漏洞 CVSS。以下没有在本批假装完成。

### R1 · P1：待办整表覆盖仍可能丢失跨端修改

`pages/Dashboard/Home/index.tsx` 的保存 effect 使用 600ms 防抖，调用 `DashboardMethods.saveTodos` 发送整份 PUT。只有收到本标签页 Agent 事件时才先 GET 合并；另一设备在 GET 和 PUT 之间新增的条目仍会被旧快照覆盖。`src/routes/todos.rs::save_todos` 在事务中删旧行再重建，没有对这条整表 PUT 校验客户端读到的版本。

后端已有部分基于稳定 id/version 的操作接口，不能因此推断当前整表 PUT 具备并发检查。建议迁移到稳定 id 的增量操作，或整表版本/If-Match；冲突时保留本地编辑。这是前后端共同修改，不能用再加一次读取代替并发控制。

### R2 · P2：归档截断、读取失败缺少恢复态

`frontHome/Content/Times/index.tsx` 固定请求 `page:1,pageSize:999`，并把当前数组长度称为文章总数，没有后续页或总数证明。超过 999 篇会漏项；请求拒绝没有 catch，业务失败或缺 data 时直接 `.map` 会抛错，界面没有重试。每秒更新页面时间也会触发整个大 Timeline 的 React 重算。

应做有界分页/按年份加载，显式区分“已加载条数”和“总数”，补业务/网络失败与卸载取消；将时钟拆成独立小组件。

### R3 · P2：后台大列表仍全量读、重复读

`pages/Dashboard/index.tsx` 和 `pages/Dashboard/Home/index.tsx` 各自加载管理员全量文章；AllNotes 的筛选和分页仍主要在浏览器，Users/tempUsers 也缓存整份账号列表。AllNotes 的 live refresh 回调主要 setState，返回 void，网络请求在另一个 effect 中，刷新器的 Promise 单飞不能完整覆盖真实请求。

新有界 articles/accounts 目录已经存在，但字段/筛选语义需要一起迁移；不能只换 URL 或只过滤当前页。建议先统一后台摘要，再迁移服务端分页、取消过时请求、让刷新返回真实请求 Promise。

### R4 · P2：分类与标签 Redux 仍可能把错误变成空目录

`store/components/categories.tsx` 和 `tags.tsx` 对业务错误/缺 data 使用空数组并提交；公共 Head 对 fetchTags 的 rejected Promise 没有捕获。网络故障可能成为未处理拒绝；业务错误可以清空先前有效目录。CategoryResource 会把“目录未加载”和“确实不存在”合在同一句提示中。

管理标签页的严格读取已经修复，但 Redux 入口是另一条链，并未一起获得保护。应统一严格信封、保留旧目录、提供独立读取错误态及重试。

### R5 · P2：账号凭据按钮与后端权限不一致

`pages/Dashboard/Users/index.tsx` 的“修改密码 / 生成恢复码”仍无条件渲染在账号行。`src/authz.rs::can_manage_credentials` 禁止自己管理自己的凭据、普通管理员操作管理员、任何人操作站长及未知角色。

后端会拒绝，因此不是权限绕过；但界面让用户执行必定失败的操作。建议共享 capability 或至少覆盖完整角色矩阵，并在角色/账号切换时更新界面快照。

### R6 · P2：后台全局样式仍存在跨路由污染面

`pages/Dashboard/index.css` 仍有裸 `body`、`.icon`、`.image`、`.text`、`.content`、全局 Ant Design 选择器和滚动条规则。SPA 懒加载样式进入后不会随路由卸载，访问后台再回前台会继续匹配这些名字。

本轮头像和头部的真实回归已验证；不能从源码匹配就断言所有选择器都造成可见错位。本项剩余部分是有证据的结构风险，应逐组件做前后台往返检查后收进后台根作用域，避免批量前缀导致 portal/弹窗失去样式。

### R7 · P2：Widget 备用 Markdown 链的安全债仍在

当前 pin 仍为 `e6948095...`。其 `chat-render.js` 备用分支仍直接使用 `window.marked.parse`；mini 转义只处理 `&<>`，随后把输入拼入双引号属性。默认 Live2dAgent 在 boot 之前注册主仓 rehype-sanitize 渲染器，主链有安全纯文本异常回退；未证明默认页面能远程触发危险备用路径。

应在 Agent 仓修复备用路径，再更新本仓 widget.lock.json 的 sha/tree。只改本机忽略目录无法发布。

### R8 · P2：看板娘脚本首次失败后无法随 SPA 重进恢复

`components/Live2dAgent/index.tsx` 在脚本成功之前就把 `window.__agentChatInjected` 设为 true，没有 onerror 清理。boot.js 第一次下载失败后，再挂载组件会直接退出，直至整页刷新。

建议分开 pending/loaded/failed 状态，失败释放标记与脚本，提供有界重试；同时保持成功后全局单实例，不能简单移除防重标记。

### R9 · P2：键盘操作覆盖仍不足

头部大多数导航使用可点击 li/div，桌面头像靠 hover 打开且没有键盘焦点入口，登录/设置/退出也是 div。手机汉堡已改成真实 button，但不能据此说整个头部可键盘操作。

应优先使用 Link/button，补焦点、Enter/Space、Escape 和关闭后的焦点恢复；保留管理员双击头像入口及当前鼠标交互。

### R10 · P2：依赖公告与 CSP 仍有后续工作

本次 `npm audit --omit=dev --package-lock-only --ignore-scripts --json` 在补丁前报告 12 个受影响包节点（其中 Critical 1）；这是依赖图节点数，不是本站漏洞数量。补丁后降为 11 个包节点（Critical 0、High 1、Moderate 5、Low 5）；其余 react-router/refractor/prismjs/follow-redirects/KaTeX 仍需按浏览器可达性分批验证，不能强制跨版本升级。

2026-10-23 本次公网只读 GET 首页仍没有 CSP 或 Report-Only；已有 nosniff 等头不等于有 CSP。这是纵深防御缺口，不证明已存在 XSS。应先验证资源需求并逐步部署 Report-Only，避免直接强制策略弄坏 Widget、Markdown 和图表。

## 验证边界

本地隔离 Chromium 使用真实 Head、Redux、Ant Design 与样式，覆盖 1440px/390px、后台样式延迟注入、头像中心、悬停放大、菜单对齐、手机抽屉与无全量文章读取；API 均隔离，没有生产写操作。公开接口小页和站点响应头只读探测正常。

AuthRouter 和公开资料的新增真实 React/thunk 测试 11 项通过。没有在共享主机运行生产构建，没有测量真实显卡占用或手机 LCP/INP，没有把本轮抽查称为所有前端问题均已排除。最终全量验证与部署以本 PR CI 和线上 build-info 为准。


## 第一批安全与紧急修复（2026-10-23）

- R5：凭证按钮按后端 `authz::can_manage_credentials` 的角色、目标身份和自身账号规则显示，未知身份默认拒绝；响应同页/跨标签页登录态变化与到期，提交前复核，防重复提交，恢复码异步结果不跨登录身份展示。
- R7：agent PR #49 已合并；移除原始 marked 与手写 HTML 回退。宿主安全渲染器不可用时转义纯文本。博客更新 widget 锁定提交及入口缓存版本。
- R8：共享在途脚本加载，成功后才记已加载；错误/超时移除失败节点并有界重试，耗尽后后续挂载仍可重新尝试。
- R4：标签、分类业务失败/异常结构/网络失败保留已有数据，标签两次读取全部成功才提交，不再产生未处理拒绝或修改响应对象。

本批不改后端授权规则。待办多端并发（R1）、归档与后台分页（R2/R3）仍列为后续两批；CSP、全局样式和键盘操作仍待单独验证。

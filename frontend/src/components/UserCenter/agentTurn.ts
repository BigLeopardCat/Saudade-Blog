/**
 * 「看板娘一轮对话收尾」这个信号（20260924 从 favorites.ts 拆出来）。
 *
 * 派发点只有一处：`public/live2d-widgets/chat-stream.js` 在流收尾的 `finally` 里
 * **无条件**派发 `new CustomEvent('agent-turn-done')`（成功、失败、被 RESET 都发）。
 *
 * 语义：一轮对话结束 = **agent 可能刚写过服务端的账**——收藏、通知已读、站内信已读、
 * 后台的标签/分类/公告/文章。这一刻所有显示这些数据的常驻界面都该重算，而不是等下一次
 * 轮询（红点 60 秒）或等用户刷新网页。
 *
 * 为什么单独一个模块、常量不挂在某个订阅方名下：订阅方已经不止收藏一个
 * （favorites.ts / unread.ts / UserCenter/index.tsx），挂在谁那里都会让其余几个
 * 产生"我为什么要 import 收藏模块"的疑问。**改名字要三处一起改**：
 * 这里、chat-stream.js 的派发点、以及 tests/favorites-sync.test.mjs 的跨文件断言。
 */
export const AGENT_TURN_DONE_EVENT = 'agent-turn-done'

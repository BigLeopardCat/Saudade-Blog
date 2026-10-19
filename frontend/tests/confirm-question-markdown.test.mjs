// ═ 卡面问句必须能过**博客同款 markdown 管线**（20261020）══
//   node tests/confirm-question-markdown.test.mjs
//
// 现场（用户 20261020）：确认卡片上的问句把 `**` 原样印了出来 ——
//   `要**在后台首页的待办里加一条「…」，排期 未排期（…）**吗？点「确定」我就去处理。`
//
// **为什么单起一层**：`confirm-card.test.py` 的 ⑪ 节声称锁的就是"问句渲染 markdown"，
// 但它那个 harness 页面**没有注册 `window.__chatRenderMarkdown`**（grep 那个文件，零命中），
// 于是 ⑪ 跑的其实是 chat-render.js 里那支**自带的迷你正则渲染器**
// （`/\*\*([^*]+)\*\*/g`）。正则不认 CommonMark 的 flanking 规则，**什么形状都能出
// `<strong>`** —— ⑪ 因此是一条**假绿**：线上跑的是 unified 管线，⑪ 验的是正则。
// 这条 bug 正是从这个缝里漏到生产上的，所以判据必须跑**真渲染器**。
//
// 这里不重抄一遍管线（抄一份就是留一个漂移源），而是把**生产的那个模块**
// （`src/utils/chatMarkdown.ts`，`window.__chatRenderMarkdown` 就是它的 `renderBlogMarkdown`）
// 用 esbuild 摊平成 .mjs 直接 import —— 与 `asset-name.test.mjs` 同一套做法。
//
// 判据两条（只判其一都会被骗）：
//   ① 动作真的被包进了 `<strong>`；
//   ② 渲染结果里**看不到 `**`**（"渲染了但没生效"就是这种形态）。
//
// ⚠️ 夹具与 agent 仓 `agent/adminops_confirm.py::render_confirm_question` 的文案同字。
// 两侧各锁一半：**这一侧**锁"这个形状在真管线上成立"；"agent 侧别再写回一行"由 agent 仓
// `tests/test_confirm.py` 的形状判据（`**吗` 不许出现）钉住。改 agent 文案时两处一起看。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

// `chatMarkdown.ts` 在**模块加载时**就往 window 上注册（第 291 行，无 `typeof window` 守卫）
// —— node 里没有 window，先补一个空壳再 import。
globalThis.window = globalThis.window || {};
const out = mkdtempSync(path.join(tmpdir(), 'confirmmd-'));
const file = path.join(out, 'chatMarkdown.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/chatMarkdown.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
});
const { renderBlogMarkdown } = await import(pathToFileURL(file).href);

/** 渲染 + 取纯文本（判据 ② 看的是"屏幕上读得到什么"）。 */
const render = (md) => {
    const html = renderBlogMarkdown(md);
    const text = html.replace(/<[^>]*>/g, '');
    return { html, text };
};
const strongCount = (html) => (html.match(/<strong>/g) || []).length;

// ── ① 生产文案的形状：单件卡（动作独占一段）────────────────────────────
// 逐字取自 `render_confirm_question` 单件那一支（20261020 改版后）。
const SINGLE_PAREN = '要处理这个任务吗？\n\n'
    + '**把全部未读通知标记为已读（不可撤销：标的就不再是未读，头顶的红点会消失）**\n\n'
    + '点「确定」我就去处理；点「取消」就当没说过。';
const SINGLE_PLAIN = '要处理这个任务吗？\n\n**删除标签「测试」**\n\n'
    + '点「确定」我就去处理；点「取消」就当没说过。';

console.log('\n① 单件卡：动作独占一段（20261020 起的两支）');
for (const [name, md, want] of [
    ['动作以「）」收尾（这一支以前会漏出星号）', SINGLE_PAREN, '把全部未读通知标记为已读'],
    ['动作以「」」收尾', SINGLE_PLAIN, '删除标签「测试」'],
]) {
    const { html, text } = render(md);
    ok(strongCount(html) === 1, `  ${name}：产出了强调标签`, html);
    ok(html.includes(`<strong>${want}`), `  ${name}：<strong> 包住的正是那一条动作`, html);
    ok(!text.includes('**'), `  ${name}：屏幕上读不到 ** 原文`, text);
}

// ── ② 多件卡（有序列表 + 逐条加粗）──────────────────────────────────
console.log('\n② 多件卡：动作逐条独立成项');
const MULTI = '要处理这几个任务吗？\n\n'
    + '1. **在后台首页的待办里加一条「亲亲泠月喵。」，排期 未排期（加完随时能改能删）**\n'
    + '2. **把全部未读通知标记为已读（不可撤销：标的就不再是未读）**\n\n'
    + '点「全部处理」我就都处理；只想处理其中一个任务，点「只处理第 N 个」（N 就是上面的编号）。';
{
    const { html, text } = render(MULTI);
    ok(strongCount(html) === 2, '  两条动作各有一个强调标签', html);
    ok(/<ol>[\s\S]*<li><strong>/.test(html), '  真的渲染成了有序列表（编号就是按钮指的那个下标）', html);
    ok(!text.includes('**'), '  屏幕上读不到 ** 原文', text);
}

// ── ③ 气泡正文（render_confirm_text）────────────────────────────────
console.log('\n③ 气泡正文：动作同样独占一段');
const BUBBLE = '好呀，这一步要动到站内数据，我先跟你确认一下：\n\n'
    + '**把全部未读通知标记为已读（不可撤销：标的就不再是未读，头顶的红点会消失）**\n\n'
    + '点「确定」我就去处理；点「取消」就当没说过，或者直接告诉我改成别的。';
{
    const { html, text } = render(BUBBLE);
    ok(strongCount(html) === 1 && !text.includes('**'), '  气泡里的动作加粗且不漏星号', html);
}

// ── ④ 反控：**旧形状**在真管线上确实是坏的 ─────────────────────────────
// 这一条是**特征化断言**（把一个已知坏形状钉住），不是"我们想要这样"。它存在的理由：
//   ① 证明上面那三条不是因为"判据写松了"才绿的 —— 同一个渲染器，换个形状就红；
//   ② 若哪天 unified/remark 换了实现、这条不再漏星号，这里会红，提醒有人来复核
//      （那时 agent 侧的 `**吗` 形状锁可以放宽，但**不要**只看这一条就放宽）。
console.log('\n④ 反控：旧的「一行内联加粗」形状在真管线上确实关不掉星号');
const OLD_BAD = '要**把全部未读通知标记为已读（不可撤销：标的就不再是未读，头顶的红点会消失）**吗？'
    + '点「确定」我就去处理。';
const OLD_OK = '要**把全部未读通知标记为已读**吗？点「确定」我就去处理。';
{
    const bad = render(OLD_BAD);
    ok(strongCount(bad.html) === 0 && bad.text.includes('**'),
        '  反例：收尾 ** 前面是标点（「）」）、后面紧跟汉字（「吗」）⇒ 星号原样留着', bad.html);
    const good = render(OLD_OK);
    ok(strongCount(good.html) === 1 && !good.text.includes('**'),
        '  对照：同一句话去掉那个括号就能渲染 ⇒ 坏的是**位置**不是"内联加粗"本身', good.html);
    ok(render(SINGLE_PAREN).text.includes('把全部未读通知标记为已读（不可撤销'),
        '  而 ① 那一支（同一个带括号的动作）没有漏 ⇒ 判据真的分得开这两个形状');
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);

// ═ 「HTTP 200 不等于成功」——非 SSE 响应的前端兜底（20261002）══
//   node tests/chat-non-sse-fallback.test.mjs
//
// 为什么这条套件存在（生产事故复盘）：
//   agent 服务炸掉不断重启那段时间，主人的两次对话**前端一行异常都没有**——用户那句话
//   照常进了对话框，然后什么都没有。查下来是一条把三端都骗过去的链：
//     · Rust 的流式早退路径（agent 连不上 / 上游非 2xx / 请求体过大 / 会话创建失败）
//       返回的是 `Json(ChatResponse{success:false, error:…})`，而 axum 的 `Json` 默认
//       **HTTP 200**；
//     · 浏览器侧唯一的失败判据是 `if (!resp.ok)` ⇒ 全部当作成功；
//     · 于是它照常建气泡、去读一个 JSON body——里面没有 `\n\n`，一帧都切不出来——
//       一路走到"空回复"那一支：气泡删掉、`console.warn` 一句，**用户零提示**；
//     · 服务端 rust.log 里它和一次成功完全同形（`status=200`），agent 侧连 trace 都没有
//       （请求根本没到 agent）⇒ 谁都没发现。
//   实测：20261002 08:37:54 / 08:39:30 两次请求 rust.log 记 200、agent 无对应 trace。
//
// 两道防线：① Rust 侧改成发 `__ERROR__` 帧（`src/routes/chat.rs::early_exit_response`，
// 由那边的单测锁）；② **本套件锁的这一道**——前端不依赖服务端自觉，发现响应不是
// `text/event-stream` 就如实报错。将来谁再加一条 JSON 出口，也不会再静默。
//
// 手法沿用 `chat-error-frame.test.mjs`：**求值真源码**而不是扫字符串。扫
// `'text/event-stream'` 这种子串对"判反了/取错字段/忘了设 userText"完全无感。
// 两个切片锚点都做非空校验：找不到就退出，否则正则漂了会变成"零断言通过"。
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(here, '../public/live2d-widgets/chat-stream.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ✅ ' + name); return; }
    fail++;
    console.log('  ❌ ' + name + (extra ? '\n      ' + extra : ''));
};
const eq = (a, b, name) => ok(a === b, name, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`);

/** 取两段锚点之间的真源码；任一锚点缺失就报错退出（防"零断言通过"）。 */
const sliceBetween = (startAnchor, endAnchor, label, withEnd = false) => {
    const i = SRC.indexOf(startAnchor);
    const j = i < 0 ? -1 : SRC.indexOf(endAnchor, i);
    ok(i >= 0 && j > i, `能从 chat-stream.js 切出「${label}」（锚点没漂）`, `start=${i} end=${j}`);
    if (i < 0 || j <= i) { console.log('\n切片失败，后续断言无意义'); process.exit(1); }
    return SRC.slice(i, withEnd ? j + endAnchor.length : j);
};

// ── 切出真源码：① 内容类型守卫 ② catch 里的 errMsg 取值 ──────────────────────
const guardSrc = sliceBetween(
    "const ctype = String(resp.headers.get('content-type') || '');",
    'throw ctErr;',
    '内容类型守卫',
    true,
);
const errMsgSrc = sliceBetween(
    'const errMsg = (e && e.userText)',
    "未知错误'));",
    'errMsg 取值',
    true,
);

/** 在桩环境里跑一遍真守卫：返回它抛出来的那个 error（没抛就返回 null）。 */
const guardOf = (contentType, body) => {
    const resp = {
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
        text: async () => body,
    };
    // 源码里有 await，包一层 async IIFE；切片止于 `throw ctErr;`，缺的那只 `}` 由
    // 这里补上（否则整段是语法错，`new Function` 自己抛 SyntaxError —— 那种"红"
    // 看起来像断言失败，实则是切片切坏了，浪费的是排查人的时间）
    const run = new Function('resp', `return (async () => {${guardSrc}\n}\nreturn null;})()`);
    return run(resp);
};
/** 在桩环境里跑一遍真 errMsg 取值。 */
const errMsgOf = new Function('e', errMsgSrc + "\nreturn errMsg;");

const SERVER_TEXT = '服务这边暂时联系不上，这一轮没有生成回复，请稍后再说一次。';

// ── ① agent 不可用：200 + JSON 错误体（事故当天的真形态）────────────────────
let thrown = null;
try { await guardOf('application/json', JSON.stringify({ reply: '', success: false, error: SERVER_TEXT })); }
catch (e) { thrown = e; }
ok(thrown !== null, '① 200 + application/json 确实抛异常（不再当成一次成功）');
if (thrown) {
    eq(thrown.userText, SERVER_TEXT, '① userText = 服务端那句话本身');
    eq(errMsgOf(thrown), SERVER_TEXT, '① 展示文本就是那句话（服务端自己写的，不套前缀）');
    ok(!errMsgOf(thrown).startsWith('网络错误'),
       '① 展示文本不带「网络错误: 」前缀（这不是网络故障）');
}

// ── ② 访客合规告知：200 + success:true + reply（有正文的早退）───────────────
// 这一支没有 error 字段，取 reply。判据仍是"抛出去"，展示的仍是服务端原话。
const NOTICE = '尊敬的访客：本站部署的AI虚拟形象Agent仅供技术学习交流…';
thrown = null;
try { await guardOf('application/json', JSON.stringify({ reply: NOTICE, success: true })); }
catch (e) { thrown = e; }
ok(thrown !== null, '② 200 + success:true + reply 也抛（它同样是"没有流"）');
if (thrown) eq(thrown.userText, NOTICE, '② 取不到 error 时回落到 reply（合规文案照常展示）');

// ── ③ 200 + text/html（nginx 把未知路径兜成 index.html）─────────────────────
// 这种响应 JSON.parse 必然失败 ⇒ 走兜底话术，且**必须**带上 userText，
// 否则用户又会读到「网络错误: Unexpected token '<'」那种看不懂的东西。
thrown = null;
try { await guardOf('text/html', '<!DOCTYPE html><html>…</html>'); }
catch (e) { thrown = e; }
ok(thrown !== null, '③ 200 + text/html（注入式 200）也抛');
if (thrown) {
    ok(!!thrown.userText && thrown.userText.length > 0, '③ 非 JSON 也有可读话术');
    ok(!errMsgOf(thrown).startsWith('网络错误'), '③ 兜底话术不带「网络错误: 」前缀');
    ok(!errMsgOf(thrown).includes('Unexpected token'), '③ 不把 JSON.parse 的英文异常摆给用户');
}

// ── ④ 判据自检：正常的 SSE 响应**不**被误伤（否则这条守卫会把全部对话打死）───
thrown = null;
try { await guardOf('text/event-stream; charset=utf-8', 'data: __END__\n\n'); }
catch (e) { thrown = e; }
eq(thrown, null, '④ text/event-stream（带 charset 参数）照常放行 —— 守卫不误伤正常流');

// ── ⑤ 判据自检：没有 userText 的异常确实被套上「网络错误: 」─────────────────
// （证明①的"不带前缀"不是因为 errMsg 那段坏了，而是真被 userText 挡住了）
const oldShape = new Error('boom');
eq(errMsgOf(oldShape), '网络错误: boom',
   '⑤ 判据自检：没有 userText 的异常确实被套前缀（老形态复现）');
if (thrown === null) {
    const bare = new Error('服务没有返回流式响应');
    ok(errMsgOf(bare).startsWith('网络错误'),
       '⑤ 对照：正是 userText 这一味药挡住了前缀（不是 errMsg 失效）');
}

console.log(`\n════ ${pass} 通过 / ${fail} 失败 ════`);
process.exit(fail ? 1 : 0);

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

// 切出真源码：① 内容类型守卫 ② catch 里的 errMsg 取值
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

// ① agent 不可用：200 + JSON 错误体（线上真形态）
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

// ② 访客合规告知：200 + success:true + reply（有正文的早退）
// 这一支没有 error 字段，取 reply。判据仍是"抛出去"，展示的仍是服务端原话。
const NOTICE = '尊敬的访客：本站部署的AI虚拟形象Agent仅供技术学习交流…';
thrown = null;
try { await guardOf('application/json', JSON.stringify({ reply: NOTICE, success: true })); }
catch (e) { thrown = e; }
ok(thrown !== null, '② 200 + success:true + reply 也抛（它同样是"没有流"）');
if (thrown) eq(thrown.userText, NOTICE, '② 取不到 error 时回落到 reply（合规文案照常展示）');

// ③ 200 + text/html（nginx 把未知路径兜成 index.html）
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

// ④ 判据自检：正常的 SSE 响应**不**被误伤（否则这条守卫会把全部对话打死）
thrown = null;
try { await guardOf('text/event-stream; charset=utf-8', 'event: done\ndata: {}\n\n'); }
catch (e) { thrown = e; }
eq(thrown, null, '④ text/event-stream（带 charset 参数）照常放行 —— 守卫不误伤正常流');

// ⑤ 判据自检：没有 userText 的异常确实被套上「网络错误: 」
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

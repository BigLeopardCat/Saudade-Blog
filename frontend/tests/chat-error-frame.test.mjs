import { readFileSync } from 'fs';
import '../public/live2d-widgets/chat-protocol.js';
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

/**
 * 取两段锚点之间的真源码；任一锚点缺失就报错退出（防"零断言通过"）。
 * `withEnd` = 结束锚点本身也算在内（切一段完整语句时需要，否则会切在字符串中间）。
 */
const sliceBetween = (startAnchor, endAnchor, label, withEnd = false) => {
    const i = SRC.indexOf(startAnchor);
    const j = i < 0 ? -1 : SRC.indexOf(endAnchor, i);
    ok(i >= 0 && j > i, `能从 chat-stream.js 切出「${label}」（锚点没漂）`, `start=${i} end=${j}`);
    if (i < 0 || j <= i) { console.log('\n切片失败，后续断言无意义'); process.exit(1); }
    return SRC.slice(i, withEnd ? j + endAnchor.length : j);
};

// 切出真源码：① 帧分支（抛异常那一段） ② catch 里的 errMsg 取值
const branchSrc = sliceBetween(
    "if (type === 'error')",
    "if (type === 'done')",
    '帧分支',
);
const errMsgSrc = sliceBetween(
    'const errMsg = (e && e.userText)',
    "未知错误'));",
    'errMsg 取值',
    true,
);

/** 在桩环境里跑一遍真帧分支：给载荷，返回它抛出来的那个 error。 */
const branch = new Function('type', 'data', branchSrc + '\nreturn null;');
const handleFrame = (wire) => {
  const parser = globalThis.__waifuChatProtocol.createStream(({type, data}) => branch(type, data));
  parser.feed(wire);
};
/** 在桩环境里跑一遍真 errMsg 取值。 */
const errMsgOf = new Function('e', errMsgSrc + "\nreturn errMsg;");

/** 服务端现在会发的那句话（`server.PRODUCER_ERROR_TEXT` 的当前值，只为可读）。 */
const SERVER_TEXT = '服务这边出了点问题，这一轮没能生成回复，请再说一次。';

// ① JSON 编码的载荷：解出来 → userText 原样，不套前缀
const frameOf = (text) => 'event: error\ndata: ' + JSON.stringify(text) + '\n\n';

let thrown = null;
try { handleFrame(frameOf(SERVER_TEXT)); } catch (e) { thrown = e; }
ok(thrown !== null, '① 帧分支确实抛异常（终止语义没变）');
if (thrown) {
    eq(thrown.userText, SERVER_TEXT, '① userText = 载荷原文（服务端自己写的那句话）');
    eq(errMsgOf(thrown), SERVER_TEXT, '① 展示文本就是那句话本身');
    ok(!errMsgOf(thrown).startsWith('网络错误'),
       '① 展示文本不带「网络错误: 」前缀（这不是网络故障）');
}

// ② 判据自检：坏形态确实会被套上前缀（上面那条才有牙）
// 用**线上真形态**：`new Error('pending_confirm')`，没有 userText。
const oldShape = new Error('pending_confirm');
eq(errMsgOf(oldShape), '网络错误: pending_confirm',
   '② 判据自检：没有 userText 的异常确实被套上「网络错误: 」（老形态复现）');
ok(errMsgOf(oldShape) !== errMsgOf(thrown || oldShape),
   '② 判据自检：加了 userText 与没加**取值不同**（这一格真被测到了）');

// ③ 载荷不是合法 JSON 时按原文兜底（别把载荷吃了）
okThrowsMalformed();
function okThrowsMalformed() {
  let error;
  try { handleFrame('event: error\ndata: unstructured\n\n'); } catch (e) { error = e; }
  ok(!!error && !error.userText, '③ 非 JSON 错误不能冒充合法服务端文案');
}

const nasty = 'line1\n\nline2 "quoted" \\ tail';
let nastyThrown = null;
try { handleFrame(frameOf(nasty)); } catch (e) { nastyThrown = e; }
if (nastyThrown) {
    eq(nastyThrown.userText, nasty, '④ 多行/引号载荷逐字还原（JSON 解码路径生效）');
    ok(!errMsgOf(nastyThrown).includes('__ERROR__'),
       '④ 展示文本里不残留协议前缀（帧头已剥掉）');
}

// ⑤ 契约对齐：与 409 那条先例同形（服务端自己写的话都不套前缀）
// 409 分支用 `usedErr.userText`，本分支用 `errFrame.userText` —— 两处取的是同一个字段，
// 这一条锁的是"别将来只改一处、另一处又退回带前缀"。判据 = 两个 error 走同一个 errMsgOf。
const usedErr = new Error('这张确认卡片已经用过一次了');
usedErr.userText = '这张确认卡片已经用过一次了';
eq(errMsgOf(usedErr), '这张确认卡片已经用过一次了', '⑤ 与 409 先例同形：userText 优先于前缀');

console.log(`\n════ ${pass} 通过 / ${fail} 失败 ════`);
process.exit(fail ? 1 : 0);

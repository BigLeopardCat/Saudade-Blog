// ═ `__ERROR__` 终止帧的展示契约（20260927）══
//   node tests/chat-error-frame.test.mjs
//
// 为什么这条套件存在：`__ERROR__` 是三种终止帧之一（另两种 `__END__` / `__NAV_END__`），
// 但**只有超时与异常路径可达**——正常对话永远碰不到。于是它是全链路里最没人走的一段，
// 前端这一格此前**没有任何断言**（当时那支时间标签排查脚本在"创建新会话失败"那一步
// 就早退了，根本到不了这个分支；它已于 20260927 修好并升格为
// `chat-time-divider.test.mjs`）。
//
// 20260927 07:29 生产事故：服务端在这一帧里发了 `'pending_confirm'`（一个内部 KeyError
// 的名字），前端把**任何**异常都套上「网络错误: 」前缀 ⇒ 主人读到「网络错误: 'pending_confirm'」。
// 两处都错：名字错（不是网络问题）、内容也看不懂。服务端那一半已改成中文话术
// （`server.PRODUCER_ERROR_TEXT`，由 agent 仓 `tests/test_error_frame.py` 锁）；
// 这一半（前端**不把服务端自己的话读成网络故障**）由本套件锁。
//
// 手法沿用 `chat-user-label.test.mjs`：**求值真源码**而不是扫字符串。扫 `'userText'`
// 这种子串对"括号优先级写反了 / 回退档位反了"完全无感——而那正是这一格全部的内容。
// 两处切片锚点都做非空校验：找不到就退出，否则正则漂了会变成"零断言通过"，
// 那种绿比红更坏。
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

// ── 切出真源码：① 帧分支（抛异常那一段） ② catch 里的 errMsg 取值 ──────────────
const branchSrc = sliceBetween(
    "if (payload.startsWith('__ERROR__:'))",
    "if (payload === '__END__' || payload === '__NAV_END__')",
    '帧分支',
);
const errMsgSrc = sliceBetween(
    'const errMsg = (e && e.userText)',
    "未知错误'));",
    'errMsg 取值',
    true,
);

/** 在桩环境里跑一遍真帧分支：给载荷，返回它抛出来的那个 error。 */
const handleFrame = new Function('payload', branchSrc + '\nreturn null;');
/** 在桩环境里跑一遍真 errMsg 取值。 */
const errMsgOf = new Function('e', errMsgSrc + "\nreturn errMsg;");

/** 服务端现在会发的那句话（`server.PRODUCER_ERROR_TEXT` 的当前值，只为可读）。 */
const SERVER_TEXT = '服务这边出了点问题，这一轮没能生成回复，请再说一次。';

// ── ① JSON 编码的载荷：解出来 → userText 原样，不套前缀 ──────────────────────
const frameOf = (text) => '__ERROR__:' + JSON.stringify(text);

let thrown = null;
try { handleFrame(frameOf(SERVER_TEXT)); } catch (e) { thrown = e; }
ok(thrown !== null, '① 帧分支确实抛异常（终止语义没变）');
if (thrown) {
    eq(thrown.userText, SERVER_TEXT, '① userText = 载荷原文（服务端自己写的那句话）');
    eq(errMsgOf(thrown), SERVER_TEXT, '① 展示文本就是那句话本身');
    ok(!errMsgOf(thrown).startsWith('网络错误'),
       '① 展示文本不带「网络错误: 」前缀（这不是网络故障）');
}

// ── ② 判据自检：坏形态确实会被套上前缀（上面那条才有牙）──────────────────────
// 用**事故当天的真形态**：`new Error('pending_confirm')`，没有 userText。
const oldShape = new Error('pending_confirm');
eq(errMsgOf(oldShape), '网络错误: pending_confirm',
   '② 判据自检：没有 userText 的异常确实被套上「网络错误: 」（老形态复现）');
ok(errMsgOf(oldShape) !== errMsgOf(thrown || oldShape),
   '② 判据自检：加了 userText 与没加**取值不同**（这一格真被测到了）');

// ── ③ 载荷不是合法 JSON 时按原文兜底（别把载荷吃了）──────────────────────────
let rawThrown = null;
try { handleFrame('__ERROR__:服务响应超时，请稍后重试'); } catch (e) { rawThrown = e; }
ok(rawThrown !== null, '③ 裸文本载荷也抛异常');
if (rawThrown) {
    eq(rawThrown.userText, '服务响应超时，请稍后重试', '③ JSON.parse 失败时保留原文（超时话术照常展示）');
    ok(!errMsgOf(rawThrown).startsWith('网络错误'), '③ 超时话术同样不带「网络错误: 」前缀');
}

// ── ④ 带引号/换行的载荷不被撕坏（JSON 编码就是为这个）────────────────────────
const nasty = 'line1\n\nline2 "quoted" \\ tail';
let nastyThrown = null;
try { handleFrame(frameOf(nasty)); } catch (e) { nastyThrown = e; }
if (nastyThrown) {
    eq(nastyThrown.userText, nasty, '④ 多行/引号载荷逐字还原（JSON 解码路径生效）');
    ok(!errMsgOf(nastyThrown).includes('__ERROR__'),
       '④ 展示文本里不残留协议前缀（帧头已剥掉）');
}

// ── ⑤ 契约对齐：与 409 那条先例同形（服务端自己写的话都不套前缀）────────────
// 409 分支用 `usedErr.userText`，本分支用 `errFrame.userText` —— 两处取的是同一个字段，
// 这一条锁的是"别将来只改一处、另一处又退回带前缀"。判据 = 两个 error 走同一个 errMsgOf。
const usedErr = new Error('这张确认卡片已经用过一次了');
usedErr.userText = '这张确认卡片已经用过一次了';
eq(errMsgOf(usedErr), '这张确认卡片已经用过一次了', '⑤ 与 409 先例同形：userText 优先于前缀');

console.log(`\n════ ${pass} 通过 / ${fail} 失败 ════`);
process.exit(fail ? 1 : 0);

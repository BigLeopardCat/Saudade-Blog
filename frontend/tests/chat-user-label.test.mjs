import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(here, '../public/live2d-widgets/chat-engine.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); return; }
  fail++;
  console.log('  ❌ ' + name + (extra ? '\n      ' + extra : ''));
};
const eq = (a, b, name) => ok(a === b, name, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`);

// ── 按函数声明切出标识逻辑，不依赖说明注释──────────────────────────────
const START = 'const getUserId = () => {';
const END = 'const loadLocalHistory = () => {';
const i = SRC.indexOf(START);
const j = SRC.indexOf(END, i);
ok(i >= 0 && j > i, '能从 chat-engine.js 切出标识函数（锚点没漂）',
   `start=${i} end=${j}`);
if (i < 0 || j <= i) { console.log('\n切片失败，后续断言无意义'); process.exit(1); }
const BLOCK = SRC.slice(i, j);
ok(/const rememberedName = \(\) => \{/.test(BLOCK) && /const userLabel = \(\) => \{/.test(BLOCK),
   '切出的块里三个函数都在（getUserId / rememberedName / userLabel）');

// ── 桩环境求值 ──────────────────────────────────────────────────────────────
/** 造一个 userLabel：token 传 null 表示未登录；nickname/username 传 undefined 表示缓存里没有 */
const buildLabel = ({ tokenUid = null, lastUser = undefined } = {}) => {
  const store = {};
  if (tokenUid !== null) {
    // 真形状的 JWT：header.payload.sig，payload 是 base64url 的 {sub}
    const payload = Buffer.from(JSON.stringify({ sub: tokenUid })).toString('base64');
    store.tokenKey = `x.${payload}.z`;
  }
  if (lastUser !== undefined) store['saudade.lastUser'] = lastUser;
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
  };
  // chat-engine 用裸 atob（浏览器全局）。桩里补上 base64 解码（Node 有 Buffer）
  const atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
  const fn = new Function('localStorage', 'atob', `${BLOCK}\nreturn userLabel;`);
  return fn(localStorage, atob);
};

const remembered = (nickname, username) =>
  JSON.stringify({ username, nickname, avatar: '', at: '2026-09-26 07:00:00' });

// ── 断言 ────────────────────────────────────────────────────────────────────
eq(buildLabel()(), '你: ', '未登录：还是「你: 」（不编昵称、不编 UID）');
eq(buildLabel({ tokenUid: 1 })(), '用户1（UID:1）: ',
   '登录但没有昵称缓存：退回「用户<uid>」，UID 照样给出');
eq(buildLabel({ tokenUid: 1, lastUser: remembered('Sora Saudade', 'sora') })(),
   'Sora Saudade（UID:1）: ', '登录且有昵称缓存：昵称（UID:1）');
eq(buildLabel({ tokenUid: 7, lastUser: remembered('', 'niuniu') })(),
   'niuniu（UID:7）: ', '昵称为空：退回用户名（不显示空白标识）');
eq(buildLabel({ tokenUid: 7, lastUser: remembered('   ', '  niuniu  ') })(),
   'niuniu（UID:7）: ', '昵称/用户名是空白串或带空格：trim 后再判');
eq(buildLabel({ tokenUid: 3, lastUser: '{坏 JSON' })(),
   '用户3（UID:3）: ', '缓存坏了（JSON 解析抛错）：不冒泡、退回用户<uid>');
eq(buildLabel({ tokenUid: 3, lastUser: '"字符串"' })(),
   '用户3（UID:3）: ', '缓存不是对象：同样退回用户<uid>');

// 负断言：旧文案不许任何一条出现（用户点名的就是它）
const all = [
  buildLabel({ tokenUid: 1, lastUser: remembered('Sora Saudade', 'sora') })(),
  buildLabel({ tokenUid: 1 })(),
  buildLabel()(),
].join('|');
ok(!all.includes('（你）'), '旧标识「（你）」不再出现在任何一条上', all);
ok(/（UID:\d+）/.test(all), '每条登录态标识都带 UID', all);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

// ═ 命令只认程序帧：正文里写的命令一律不执行（20260926 批 2）══
//   node tests/agent-cmd-program-only.test.mjs
// 背景（真实事故，trace 20260926T215115）：navigate_to 真返回了跳转命令、页面真的
//   跳了，narrator 引执行回执时**把命令前缀一起抄进了正文** ⇒ gate 判"假装发命令"、
//   整段换成"已经被我拦下啦"——把一件办成的事说成了没办。根因是同一根字符串既当
//   连线命令、又当模型唯一看得见的凭据。批 2 把命令搬上执行回执（`__CMD__` 帧），
//   正文从此不再是执行来源：**兜底扫描一条不留**。
// 本测试锁两半（都是源码级，同 live2d-widget-scope 的扫法）：
//   ⓪ **到达即执行**（20261002）：命令在 `__CMD__` 帧到达时就处置一次（能当场做的
//      ——SPA 跳转/特效/夜间——立刻做掉），流尾那一趟只捞"只能等流尾"的整页目标。
//      理由：系统在 t≈3.2s 就印"页面已跳转：…"，而跳转原本要等流结束（t≈9.4s）
//      ——陈述与动作分家，主人读到"跳好了"还得再等几秒。整页目标（/device-console/）
//      跳不了：它掐断 SSE ⇒ 本轮回复丢失，所以那一格必须留在流尾。
//   ① 只认程序帧：`__CMD__` 进独立缓冲 programCmds，不进任何展示文本；缓冲在
//      `__RESET__` 里**按 scope 决定清不清**——`all`（决策被推翻，gate 打回重规划）
//      清、`text`（终局 fallback）不清。20261001 之前是无条件清，两个后果都实测过：
//      清的那半边让系统在 fallback 后印着"页面已跳转：…"却说不出为什么没跳，
//      而不清的那半边是"道歉了但还是跳了"——所以判据落在帧里的 scope 上，不是取舍；
//   ② 兜底不复活：正文扫描（effectMatch / 伪工具调用 / 中文动词转跳 / DARKMODE 正则）
//      一条都不许回来。它们**看着像无害的保险**，实际是"模型在正文里写命令就能执行"
//      这条通道本身——CLAUDE.md §3 至今还写着"前端兜底解析仍在"，下一个读者会照它
//      把代码加回去，所以这里用测试钉住，而不是只改文档。
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const s = readFileSync(path.join(here, '../public/live2d-widgets/chat-stream.js'), 'utf8');
const stripComment = (l) => {
  const i = l.indexOf('//');
  return i >= 0 ? l.slice(0, i) : l;
};

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; return; }
  fail++;
  console.log('  ✗ ' + name + (extra ? '\n      ' + extra : ''));
};

// Only named command events enter the action buffer.
{
  const i = s.indexOf("if (type === 'command')");
  const seg = s.slice(i, s.indexOf('displayText += data', i));
  ok(i >= 0 && /programCmds.push\(data\)/.test(seg), '具名命令进入独立缓冲');
  ok(/applyCmd\(data, contentSpan, false\)/.test(seg), '允许 SPA 动作到达即执行');
  ok(!/text.startsWith\('__CMD__:/.test(s), '正文不识别控制前缀');
  ok((s.match(/programCmds = \[\]/g) || []).length === 1, '没有重置帧能清除命令缓冲');
}

// ── ③ 执行只吃这个缓冲，三处调用点都换过来了 ─────────────────────────────────
{
  const calls = s.match(/execAgentCommands\((?:.|\n)*?\)/g) || [];
  const withBuf = (s.match(/execAgentCommands\(programCmds/g) || []).length;
  ok(withBuf === 3, `三处调用点都传 programCmds（实得 ${withBuf}）`);
  // 流尾那一趟必须**允许整页跳转**（allowDeferred=true）——它是整页目标唯一的
  // 出场机会；传错成 false，`/device-console/` 就永远跳不了（命令静默作废）。
  ok(/applyCmd\(c, contentSpan, true\)/.test(s),
     '  流尾兜底那一趟允许整页跳转（applyCmd(..., true)）');
  // 幂等：每条命令只执行一次（到达时已跑过的，流尾不许再跑）
  ok(/c\.__done = true/.test(s), '  命令带 `__done` 标记（同一条不执行两次）');
  ok(/if \(!c \|\| typeof c !== 'object' \|\| c\.__done\) return true;/.test(s),
     '  applyCmd 入口就挡掉已处置的命令');
  // 同一地址只跳一次：多轮里 round0/round1 可能选出同一个目标（旧版靠"取最后一条"
  // 压住，改成按到达顺序执行之后必须显式去重，否则会跳两遍）
  ok(/navUrl === jumpedUrl/.test(s), '  同一目标本轮不重复跳');
  ok(!/execAgentCommands\((fullText|cmdText|displayText|text)/.test(s),
     '  没有任何调用点还在吃展示文本（那就是"正文可执行"的旧形态）',
     calls.join(' | ').slice(0, 200));
}

// ── ④ 正文兜底扫描一条都不许复活 ─────────────────────────────────────────────
{
  const body = s.split('\n').map(stripComment).join('\n');   // 注释里提到不算
  for (const [name, re] of [
    ['effectMatch', /effectMatch/],
    ['伪工具调用解析（toggle_effect(...) 写进正文也会执行）', /toggle_effect\s*\(\s*effect/],
    ['正文链接/中文动词转跳兜底', /fallbackNav/],
    ['DARKMODE 正则兜底', /darkMatch/],
    ['裸命令前缀解析（cmdNav）', /cmdNav/],
  ]) {
    ok(!re.test(body), `正文兜底扫描已删除：${name}`);
  }
  // 反向哨兵：命令前缀仍然**隐藏**（不渲染），只是不再执行——删伪装会把命令行
  // 当正文渲染给用户看（历史 bug：strip_command_lines 留下的空行/裸命令）
  ok(!/COMMAND_RE/.test(body), '正文不会按命令前缀隐藏');
}

console.log(`\n${fail ? '✗' : '✓'} agent-cmd-program-only：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

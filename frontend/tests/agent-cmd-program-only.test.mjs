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

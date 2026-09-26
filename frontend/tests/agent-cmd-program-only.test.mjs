// ═ 命令只认程序帧：正文里写的命令一律不执行（20260926 批 2）══
//   node tests/agent-cmd-program-only.test.mjs
// 背景（真实事故，trace 20260926T215115）：navigate_to 真返回了跳转命令、页面真的
//   跳了，narrator 引执行回执时**把命令前缀一起抄进了正文** ⇒ gate 判"假装发命令"、
//   整段换成"已经被我拦下啦"——把一件办成的事说成了没办。根因是同一根字符串既当
//   连线命令、又当模型唯一看得见的凭据。批 2 把命令搬上执行回执（`__CMD__` 帧），
//   正文从此不再是执行来源：**兜底扫描一条不留**。
// 本测试锁两半（都是源码级，同 live2d-widget-scope 的扫法）：
//   ① 只认程序帧：`__CMD__` 进独立缓冲 programCmds，不进任何展示文本；缓冲在
//      `__RESET__`（gate 打回那一轮）必须一起清——不清 = 被打回的命令照旧执行；
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

// ── ① 只认程序帧 ─────────────────────────────────────────────────────────────
{
  ok(/let programCmds = \[\];/.test(s), 'chat-stream.js 有独立的程序命令缓冲 programCmds');
  ok(/text\.startsWith\('__CMD__:'\)/.test(s), '解析 `__CMD__:` 帧');
  ok(/JSON\.parse\(text\.slice\('__CMD__:'\.length\)\)/.test(s),
     '  帧体按 JSON 解（结构化命令，不是文本前缀）');
  const iCmd = s.indexOf("text.startsWith('__CMD__:')");
  const iPush = s.indexOf('programCmds.push(cmd)');
  ok(iCmd > 0 && iPush > iCmd, '  解析后进 programCmds 缓冲');
  // 分支必须在 COMMAND_RE 分流之前——晚于它，帧体会落进 displayText（渲染出一坨
  // JSON）或落进 cmdText（等于正文命令照样执行）
  const iSplit = s.indexOf('ctx.core.COMMAND_RE.test(text)');
  ok(iCmd > 0 && iSplit > iCmd, '  `__CMD__` 分支在正文/命令行分流**之前**');
  const seg = s.slice(iCmd, iPush + 120);
  ok(/continue;/.test(seg), '  处理完就 continue（不进正文/命令行两条路）');
  ok(!/displayText/.test(seg) && !/cmdText/.test(seg),
     '  这个分支碰都不碰 displayText/cmdText');
}

// ── ② 打回时缓冲必须一起清 ───────────────────────────────────────────────────
{
  const i = s.indexOf("text === '__RESET__'");
  const seg = i >= 0 ? s.slice(i, s.indexOf('continue;', i)) : '';
  ok(i >= 0 && /programCmds = \[\];/.test(seg),
     '`__RESET__`（gate 打回）分支清空 programCmds',
     '不清 = 被否定的那一轮的命令仍然会执行');
}

// ── ③ 执行只吃这个缓冲，三处调用点都换过来了 ─────────────────────────────────
{
  const calls = s.match(/execAgentCommands\((?:.|\n)*?\)/g) || [];
  const withBuf = (s.match(/execAgentCommands\(programCmds/g) || []).length;
  ok(withBuf === 3, `三处调用点都传 programCmds（实得 ${withBuf}）`);
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
  ok(/COMMAND_RE\.test\(text\)/.test(body), '  命令行仍然照旧不进正文（只隐藏、不执行）');
}

console.log(`\n${fail ? '✗' : '✓'} agent-cmd-program-only：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

// ═ 看板娘对话脚本：作用域洞 + 确认卡片位置 回归（20260921d）══
//   node tests/live2d-widget-scope.test.mjs
// 背景（真实事故）：写操作确认卡片点「确定」在生产上**什么都没发生**——前端错误
//   上报抓到 `Uncaught ReferenceError: sendMessage is not defined
//     at handleAskChoice (chat-stream.js:89) at HTMLDivElement.<anonymous> (…:1549)`。
//   成因：handleAskChoice 写在模块工厂层（4 空格），它调的 sendMessage 是 init 的
//   局部 const（6 空格）——回调里抛错 ⇒ 请求没发出、界面也没有任何提示（用户看到的
//   就是"点了确定，轮次像被截断"）。这类洞**只有真点一次才暴露**：离线测试、golden、
//   HTTP 探针全都碰不到（它们不发浏览器点击）。
// 本测试把两件事锁死：
//   ① 作用域：工厂层代码不得引用 init 局部名（注释不算）——同类洞一次也不许再出现；
//   ② 卡片位置：确认卡片是 .chat-messages 的末位子节点（对话流内），且清空消息区
//      的三处都必须同时丢掉挂起的确认（否则卡片被摘掉、pendingAsk 还活着，下一轮
//      收尾会把它重新冒出来）。
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const W = (f) => readFileSync(path.join(here, '../public/live2d-widgets/', f), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; return; }
  fail++;
  console.log('  ✗ ' + name + (extra ? '\n      ' + extra : ''));
};
const eq = (a, b, name) => ok(a === b, name, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`);

// ── ① 作用域洞扫描 ──────────────────────────────────────────────────────────
// 扫描法：从 `const init = () => {` 起、到文件末尾，收集 6 空格缩进的 init 局部名；
// 再看 init **之前**的代码行（剥掉注释）有没有**调用**它们（`name(` 形态——本次事故
// 正是"调了一个不存在的函数"，ReferenceError 直接抛在事件回调里）。只扫调用形态是
// 刻意的：同名变量在别的闭包里取属性（如回调里 `list.map(...)`）是合法遮蔽，不是洞。
const stripComment = (l) => {
  const i = l.indexOf('//');
  let code = i >= 0 ? l.slice(0, i) : l;
  return /^\s*\*/.test(code) ? '' : code;   // 块注释续行
};
const scanScopeHoles = (file) => {
  const lines = W(file).split('\n');
  const initAt = lines.findIndex((l) => l.startsWith('    const init = () => {'));
  if (initAt < 0) return { holes: [], locals: 0 };
  const locals = new Set();
  for (let i = initAt; i < lines.length; i++) {
    let m = lines[i].match(/^ {6}(?:const|let|function|async function)\s+([A-Za-z_$][\w$]*)/);
    if (m) locals.add(m[1]);
    m = lines[i].match(/^ {6}const\s*\{([^}]*)\}\s*=/);
    if (m) m[1].split(',').forEach((n) => locals.add(n.trim()));
  }
  // 同名但**本就在工厂层声明过**的不算洞（如 chat-session 的 list：上下两层各有一个
  // 同名变量是合法遮蔽，不是引用越界）
  for (let i = 0; i < initAt; i++) {
    let m = lines[i].match(/^ {0,4}(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)/);
    if (m) locals.delete(m[1]);
    m = lines[i].match(/^ {0,4}(?:const|let)\s*\{([^}]*)\}\s*=/);
    if (m) m[1].split(',').forEach((n) => locals.delete(n.trim()));
  }
  const holes = [];
  for (let i = 0; i < initAt; i++) {
    const code = stripComment(lines[i]);
    if (!code.trim()) continue;
    for (const n of locals) {
      if (new RegExp('(?<![\\w$.])' + n.replace(/\$/g, '\\$') + '\\s*\\(').test(code)) {
        holes.push(`${file}:${i + 1} → ${n}`);
      }
    }
  }
  return { holes, locals: locals.size };
};

for (const f of ['chat-stream.js', 'chat-engine.js', 'chat-render.js', 'chat-session.js', 'chat-core.js']) {
  const { holes, locals } = scanScopeHoles(f);
  ok(holes.length === 0, `${f}：工厂层不引用 init 局部（扫了 ${locals} 个局部名）`, holes.join('\n      '));
}

// chat-stream 的 init 里必须同时有 sendMessage 与 handleAskChoice（同层才调得到）
{
  const src = W('chat-stream.js');
  const at = src.indexOf('const init = () => {');
  ok(at > 0, 'chat-stream.js 有 init');
  const body = src.slice(at);
  ok(/^ {6}const sendMessage = async \(opts\) => \{/m.test(body), 'sendMessage 定义在 init 内层');
  ok(/^ {6}const handleAskChoice = \(value\) => \{/m.test(body), 'handleAskChoice 定义在 init 内层（与 sendMessage 同层）');
  ok(/sendMessage\(\{ silent: true, confirmToken: ask\.token/.test(body),
     '确认点击发的是隐藏请求（silent + confirmToken）');
  // 两个早退（无待办 / 流未收尾）必须都在 settle 之前——settle 之后到 sendMessage
  // 之间不许再有 return 暗门（卡片显示"已确认"却不发请求 = 静默失效）
  const h = body.slice(body.indexOf('const handleAskChoice'));
  const seg = h.slice(0, h.indexOf('askBtns.addEventListener'));
  const iReturn = seg.lastIndexOf('return;');
  ok(iReturn >= 0 && iReturn < seg.indexOf("askSettle('已确认')"),
     'handleAskChoice 的早退全在 settle 之前（确立反馈=发请求，不会静默吞掉）');
  ok(/askSettle\('已确认'\)/.test(seg) && /askSettle\('已取消'\)/.test(seg),
     '点确定/取消都有可见反馈（按钮换灰字）');
}

// ── ② 卡片位置与清空联动 ────────────────────────────────────────────────────
{
  const r = W('chat-render.js');
  const mIdx = r.indexOf('<div class="chat-messages" id="chat-messages">');
  const aIdx = r.indexOf('id="chat-ask"');
  ok(mIdx > 0 && aIdx > mIdx, 'chat-render.js：确认卡片在 .chat-messages 内部');
  // 卡片是 messages 的**直接子节点**：两者之间只应有 messages 自己的开标签与卡片
  // 自己的开标签（2 个 <div），多一个就意味着中间又套了一层容器
  const between = r.slice(mIdx, aIdx);
  eq((between.match(/<div/g) || []).length, 2, '卡片是 messages 的直接子节点（中间不再套容器）');
  ok(!/chat-new-msg-note[\s\S]{0,400}id="chat-ask"/.test(r), '卡片不再挂在输入区上方那一族兄弟节点里');
  // 定位覆盖：conv-open/conv-out 给 .chat-nav-confirm 加的 margin-left 位移必须被压过
  const css = W('waifu.css');
  ok(/#waifu-chat #chat-ask \{/.test(css), 'waifu.css：卡片有自己的定位覆盖（两个 id 压过位移群）');
  ok(/#waifu-chat #chat-ask \.chat-ask-note/.test(css), 'waifu.css：已确认/已取消灰字样式在');
  ok(/#waifu-chat #chat-ask \.nav-question \{ margin-bottom: 8px; white-space: pre-line; \}/.test(css),
     'waifu.css：问题文本保留换行（pre-line）');
}

{
  const e = W('chat-engine.js');
  // 三处 messages.innerHTML = '' 必须都清 pendingAsk
  const wipes = e.split('\n').reduce((acc, l, i) => {
    if (l.includes("messages.innerHTML = ''")) acc.push(i);
    return acc;
  }, []);
  eq(wipes.length, 3, 'chat-engine.js 有三处清空消息区');
  const tail = (i) => e.split('\n').slice(i, i + 6).join('\n');
  for (const i of wipes) {
    ok(/ctx\.state\.pendingAsk = null/.test(tail(i)), `清空消息区（第 ${i + 1} 行）同时丢掉挂起的确认`);
  }
}
{
  // 帧协议与版本：__CONFIRM__ 解析仍在，autoload/index.tsx 的 ?v= 与 VER 一致
  const s = W('chat-stream.js');
  ok(/text\.startsWith\('__CONFIRM__:'\)/.test(s), 'chat-stream.js 仍解析 __CONFIRM__ 帧');
  ok(/confirm_token: opts\.confirmToken/.test(s), '请求体带 confirm_token');
  const ver = (W('autoload.js').match(/const VER = '([^']+)'/) || [])[1];
  const idx = readFileSync(path.join(here, '../src/components/Live2dAgent/index.tsx'), 'utf8');
  ok(ver && idx.includes(`autoload.js?v=${ver}`), `autoload.js VER 与 index.tsx 的 ?v= 一致（${ver}）`);
}

console.log(`\n${fail ? '✗' : '✓'} live2d-widget-scope：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

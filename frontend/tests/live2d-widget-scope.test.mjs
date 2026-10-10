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
  const iPending = seg.indexOf("askSettle('确认中…'");
  ok(iReturn >= 0 && iPending >= 0 && iReturn < iPending,
     'handleAskChoice 的早退全在 settle 之前（确立反馈=发请求，不会静默吞掉）');
  // 括号里**不锚定参数个数**：askSettle 现在带第三个参数（结算结论，逐跳埋点用），
  // 锚死 `'已取消')` 会在每次加参数时假红一次——要锁的是"这一跳写了可见反馈"，
  // 不是那条调用的参数表（判据锚在文案上，不锚在形状上）。
  ok(iPending >= 0 && /askSettle\('已取消'[^)]*\)/.test(seg),
     '点确定/取消都有可见反馈（按钮换灰字）');
  // 20260924：点下去写的是「确认中…」而**不是**「已确认」——"已确认"是点击那一刻
  // 写下的乐观文本、没有任何回滚（生产事故：卡片说已确认、系统里零执行）。真实
  // 结算只允许出现在轮次收尾，故这里连同"点击那一段里不许出现它"一起锁住。
  ok(!/askSettle\('已确认/.test(seg), '点确定不写「已确认」（乐观态不许再回到点击那一跳）');
  ok(/askSettle\('已确认，结果见下方回复'[^)]*\)/.test(body),
     '成功结算写在轮次收尾（而非点击处）');
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
  const css = W('widget.css');
  ok(/#waifu-chat #chat-ask \{/.test(css), 'widget.css：卡片有自己的定位覆盖（两个 id 压过位移群）');
  ok(/#waifu-chat #chat-ask \.chat-ask-note/.test(css), 'widget.css：已确认/已取消灰字样式在');
  // 20260925：pre-line 撤掉（问句改走 markdown，换行由渲染管线自己出）——它会把
  // HTML 里标记之间的换行再渲染一次，两段问句多出一条空行（实测 60.6px → 42.4px）。
  // 断言反过来锁：这两条不能再回来。
  ok(/\.nav-question p \{ margin: 0; \}/.test(css),
     'widget.css：问句段落下边距归零（markdown 产出的 <p> 不该吃 UA 的 1em）');
  ok(!/\.nav-question \{[^}]*white-space: pre-line/.test(css),
     'widget.css：问句不残留 white-space: pre-line（markdown 已管换行，再管一次是双倍行距）');
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
// ── ②b 初始位置：回到最初的 15px / -15px（20261011 回退，撤销 20261003 两次位移）──
// 沿革（三段，别只看最后一段）：最初 `left: 15px` + `translateY(-15px)` ⇒ 20261003
// 先「右移看板娘板块宽度的一半」（板块 = `#live2d` 的 300px，半宽 150px，15 + 150 = 165），
// 再按「稍微左移一点下移一点」收 20px ⇒ 145（纵向同步从 -15px 收到 -5px）⇒
// **20261011 用户裁决「默认位置回退到当时让你改的那个版本」= 两次位移一起撤掉，横纵都回最初**。
// ⚠️ 与那两次位移同时撤掉的还有 `<480px` 里那条 `#waifu { left: 15px }` 窄屏回落：
// 基态回到 15px 之后它就是同值空转，已删 ⇒ 下面那条断言是**反向**的（不许再出现回落）。
// 也别再"锁推导"：15px 不是从 `#live2d` 的宽度算出来的，它就是个初值。
{
  // ⚠️ 断言一律跑在**剥掉注释**的文本上：这个文件的注释里会写选择器与取值（本轮就有一条
  // 提到已删的垮屏回落规则），注释里的花括号会让 `[^}]*` 这种朴素匹配在注释处截断——
  // 实测症状是"基态 transform 明明改了却红了"。②c 的媒体块解析出于同一原因先剥注释。
  const css = W('widget.css').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(/#waifu \{[^}]*\bleft: 15px/.test(css),
     'widget.css：#waifu 初始 left = 15px（20261011 回退到最初值）');
  // 纵向：整块抬 15px；`#waifu:hover` 必须**同值**（现状是刻意的"hover 不抬升"，
  // 只改一处鼠标一上去就跳）——两处一起锁，改一处当场红。
  ok(/#waifu \{[^}]*transform: translateY\(-15px\)/.test(css),
     'widget.css：#waifu 基态 transform = translateY(-15px)');
  ok(/#waifu:hover \{\s*[^}]*transform: translateY\(-15px\)/.test(css),
     'widget.css：#waifu:hover 与基态同值（不抬升）');
  // 横向回落已随 20261003 那两次位移一起撤掉。判据取媒体块**之后**的整段：基态就是
  // 15px，那里再写一条 `#waifu { left: … }` 不是空转就是两处各说各话。
  // 只排 `#waifu ` 一条——`#waifu-toggle { left: 15px }` 是另一个元素，不在判据里。
  const fromMedia = css.slice(css.indexOf('@media (max-width: 479px)'));
  ok(fromMedia.length > 0 && !/#waifu \{[^}]*left:/.test(fromMedia),
     'widget.css：<480px 起不再有 #waifu 的横向回落（基态即 15px）');
  // 收起态那枚唤回贴纸**不跟着动**：它只在与本体互斥的收起态出现，恒贴左下角。
  // 它本来就恒在 15px，与基态同值是巧合——这条钉的是"两处语义不同"，
  // 别把它们当成"一处改两遍"而连带删掉。
  ok(/#waifu-toggle \{[^}]*\bleft: 15px/.test(css),
     'widget.css：#waifu-toggle 仍恒在 15px（它不属于"看板娘本体"，不跟着动）');
}

// ── ②c 手机档：整块缩到半尺寸、贴住左缘（20261005 用户第 4 条）────────────────
// 报的是「手机上盖住大半个正文与表格」：修前 390×844 下 300×300 的盒子占满
// x15..315，角色墨迹本身就有 165×291px 压在正文栏中间，而且盒子里**没画东西的地方
// 也吃点击**（正文在那个矩形里一律点不到）。真渲染与命中行为由
// `tests/live2d-render.test.py` ⑨ 负责（含"换回修前 widget.css 要变红"的红基线）；
// 这里锁**结构**：缩放加在哪个元素上、工具条有没有重锚、命中是不是按子节点放行。
//
// 为什么锁得这么细：这四条里有三条**改错任何一条都不会报错**——
//   · 缩放加到 `#waifu` 上 ⇒ 对话面板（它的子节点）一起缩，且祖先的 transform 会
//     成为面板的包含块（`bottom: calc(100% + 12px)` 按缩放后的盒解析）⇒ 面板飘走；
//   · 忘了重锚工具条 ⇒ 六个钮留在 300px 盒的右缘，而角色已经缩到左边 ⇒ 钮飘在空处；
//   · 忘了放行子节点（只写容器那句 `pointer-events: none`）⇒ 连角色和按钮都点不中。
// 三者都编译得过、都渲染得出画面。
{
  const css = W('widget.css');
  // 取 `@media (max-width: 479px)` 的块内容：花括号配对，且**先剥注释**
  // （这个文件的注释里会写选择器与取值，注释里的花括号会把朴素计数带跑偏）。
  const mediaBody = (src, q) => {
    const s = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const i = s.indexOf('@media ' + q);
    if (i < 0) return '';
    let depth = 0, start = -1;
    for (let k = i; k < s.length; k++) {
      if (s[k] === '{') { if (depth === 0) start = k; depth++; }
      else if (s[k] === '}') { depth--; if (depth === 0) return s.slice(start + 1, k); }
    }
    return '';
  };
  const mob = mediaBody(css, '(max-width: 479px)');
  ok(mob.length > 0, 'widget.css：找得到 <480px 那个块');
  const rules = [...mob.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sel: m[1].split(',').map((s) => s.trim()).filter(Boolean), body: m[2],
  }));
  const withSel = (sel) => rules.filter((r) => r.sel.includes(sel));
  const has = (sel, re) => withSel(sel).some((r) => re.test(r.body));

  ok(has('#waifu-canvas', /transform:\s*translateX\(-34px\)\s*scale\(\.5\)/),
     '手机档：缩放落在 #waifu-canvas 上（translateX(-34px) scale(.5)）');
  ok(has('#waifu-canvas', /transform-origin:\s*left bottom/),
     '手机档：#waifu-canvas 的 transform-origin = left bottom（缩完贴住盒底）');
  // 负空间：缩放**不许**挂到 #waifu 上——那是面板的祖先。
  ok(!rules.some((r) => r.sel.includes('#waifu') && /transform:\s*scale|zoom:/.test(r.body)),
     '手机档：#waifu 身上没有缩放（有的话对话面板一起缩、包含块也变）');
  ok(!rules.some((r) => r.sel.includes('#waifu') && /transform:/.test(r.body)
                        && !/pointer-events/.test(r.body) && /scale|rotate|skew/.test(r.body)),
     '手机档：#waifu 上没有别的（缩放类）transform');
  // 工具条重锚：原来 `right:-10px` 锚在 300px 盒的右缘。
  ok(has('#waifu-tool', /right:\s*auto/) && has('#waifu-tool', /left:\s*88px/),
     '手机档：工具条重锚（right:auto + left:88px，跟着缩小的角色走）');
  // 命中放行：容器 none，四个子节点 auto。四个各有各的理由（见 widget.css 注释）：
  // 画布本体、工具条、chat-stream 追加的特效钮、对话面板。
  ok(has('#waifu', /pointer-events:\s*none/),
     '手机档：#waifu 不吃命中（空白处的点击穿到底下的正文）');
  const auto = rules.filter((r) => /pointer-events:\s*auto/.test(r.body)).flatMap((r) => r.sel);
  for (const sel of ['#waifu-canvas', '#waifu-tool', '#waifu-tool-star-box', '#waifu-chat']) {
    ok(auto.includes(sel), `手机档：${sel} 重新拿到命中（pointer-events: auto）`);
  }
  // 负空间：`#waifu-tips` 在手机档不需要任何规则——本仓这条是 `display: none !important`
  // （提示语整个走对话面板）。给它写定位是一条**永远不会生效**的死声明。
  ok(!auto.includes('#waifu-tips') && !withSel('#waifu-tips').length,
     '手机档：没有给 #waifu-tips 写规则（它是 display:none，写了也不生效）');
}

// ── ③ 确认卡片存活（20260923：帧到了、卡片却被当孤儿删掉）────────────────────
// 真实事故（静态版判据）：agent 帧齐、Rust 真转发、前端也真渲染出了卡片，但弹卡后
// 几十毫秒另一次 reconcileDOM（别的窗口写了会话缓存 ⇒ 本轮收尾补拉历史）把它当
// "无 data-mid 的孤儿"删了——屏幕上什么都没有，而 pendingAsk 还活着。两段代码各自
// 看都对，只有"真模块 + 真时序"看得见（行为层回归见 tests/confirm-card.test.py）。
// 这里锁住三样"少了任何一样都会静默复发"的东西：
//   ① 模板节点带 chat-keep（孤儿清理的豁免标记）；
//   ② 孤儿清理认这个标记（消息流里其他带 id 的常驻节点也靠它）；
//   ③ 收尾只 syncAsk 不 hideAsk + reconcile 收尾调自愈钩子（双保险）。
{
  const r = W('chat-render.js');
  ok(/<div class="chat-nav-confirm chat-ask chat-keep" id="chat-ask">/.test(r),
     'chat-render.js：模板卡片带 chat-keep（孤儿清理豁免标记，就写在卡片那一个 div 上）');
  const e = W('chat-engine.js');
  // 20260925：豁免判据从删除循环里挪到了 items 循环**之前**预计算的 `doomed`
  // 集合（位置对齐的插入点也要跳过同一批节点，两处不能各判一份）。所以这里锁两半：
  // ① 预计算里豁免常驻节点；② 真删除只认那个集合——少一半就是判据又分了家。
  ok(/classList\.contains\('chat-keep'\)[^;]*continue;/.test(e),
     'chat-engine.js：孤儿判定豁免 chat-keep 节点');
  ok(/if \(!doomed\.has\(child\)\) continue;/.test(e),
     'chat-engine.js：真删除只认预先算好的 doomed 集合（判据只有一处）');
  ok(/__reportError\(\{ type: 'orphan_dom_drop'/.test(e),
     'chat-engine.js：删掉带 id 的常驻节点要上报（漏加 chat-keep 的探照灯）');
  ok(/onAskResync/.test(e) && /ui\.onAskResync\(\)/.test(e),
     'chat-engine.js：reconcileDOM 收尾调用 onAskResync（DOM 重建后卡片自愈）');
  const s = W('chat-stream.js');
  ok(/const syncAsk = \(\) => \{/.test(s) && !/const showAsk = /.test(s),
     'chat-stream.js：showAsk 已改成幂等 syncAsk（重复调用零副作用）');
  // 20260924 起钩子是"先接存档再挂卡"：只 syncAsk 的话，刷新后内存里那份待办
  // 本来就是空的（卡片活在 localStorage 里），自愈钩子会对着空气同步——这条断言
  // 因此两半都锁，少一半就红
  // 20260927：这个正则原先把钩子对象整个锁死（`} })` 紧跟 onAskResync 之后），
  // 于是**多注册一个兄弟钩子就假红**——那次加的是 onFailedResync，一字未动
  // onAskResync 却判它"两半缺一"。锁的是这一半的两句，就别把"后面还有什么"钉进去。
  const resync = s.match(/engine\.setConvUI\(\{ onAskResync: \(\) => \{([^}]*)\}/);
  ok(!!resync && /restoreAsk\(\)/.test(resync[1]) && /syncAsk\(\)/.test(resync[1]),
     'chat-stream.js：onAskResync 钩子 = 接回存档 + 挂卡（两半缺一不可）');
  // 失败轮按钮与确认卡同构：引擎负责"节点在不在"、交互层负责"点了做什么"，
  // 两半缺一就是"刷新后按钮没了"（20260927 用户报的那个缺口）。
  ok(/onFailedResync/.test(e) && /ui\.onFailedResync\(\)/.test(e),
     'chat-engine.js：reconcileDOM 收尾调用 onFailedResync（提示条重建后按钮自愈）');
  ok(/onFailedResync: \(\) => \{ attachHistoryFailedRetry\(\); \}/.test(s),
     'chat-stream.js：onFailedResync 钩子 = 重挂失败轮重发/编辑按钮');
  // 收尾那段：唯一允许出现的 hideAsk 是"用户改口打字"那条（sendMessage 里），
  // 收尾的 setTimeout 里不许再有 hideAsk（它会把待办当成"用户改口"销毁掉）
  const fin = s.slice(s.indexOf("if (ctx.state.pendingPull) { ctx.state.pendingPull = false;"));
  const finSeg = fin.slice(0, fin.indexOf('agent-turn-done'));
  ok(/if \(!ctx\.state\.isSending\) syncAsk\(\);/.test(finSeg),
     'chat-stream.js：收尾忙时保留待办（不再 hideAsk 销毁）+ 到点 syncAsk');
  ok(!/hideAsk\(\)/.test(finSeg.split('\n').map(stripComment).join('\n')),
     'chat-stream.js：收尾段没有 hideAsk 暗门（注释里提到不算）');
  // 上报替换掉的静默 return（缺字段的确认帧 / 终止帧之后的帧）
  ok(/__CONFIRM__ 帧不可用/.test(s) && /终止帧之后又收到一帧/.test(s),
     'chat-stream.js：确认帧与终止帧两处静默失败改为上报');
}

{
  // 帧协议与版本：__CONFIRM__ 解析仍在，autoload/index.tsx 的 ?v= 与 VER 一致
  const s = W('chat-stream.js');
  ok(/text\.startsWith\('__CONFIRM__:'\)/.test(s), 'chat-stream.js 仍解析 __CONFIRM__ 帧');
  ok(/confirm_token: opts\.confirmToken/.test(s), '请求体带 confirm_token');
  const ver = (W('boot.js').match(/const VER = '([^']+)'/) || [])[1];
  const idx = readFileSync(path.join(here, '../src/components/Live2dAgent/index.tsx'), 'utf8');
  ok(ver && idx.includes(`boot.js?v=${ver}`), `boot.js VER 与 index.tsx 的 ?v= 一致（${ver}）`);
}

// ── ④ 工具条：图标 ↔ 功能（20261002 修「图标对不上功能」）─────────────────────
// 用户报「看板娘的操作图标功能紊乱，图标对不上功能」。实测：`switch-model` 穿的是
// T 恤、`switch-texture` 举的是相机、`photo` 是一张加号相框——**三条各错一个位**。
// 阴险之处在于 tooltip 与点击行为都是对的，错的只有**形状**，所以肉眼扫过去只
// "觉得别扭"、说不清哪里错；而图标是纯 SVG 字面量，没有任何运行期判据能发现它。
//
// 判据 = Font Awesome Free 6.7.2 的 path **前 32 字符**当指纹（同一字形换 FA 版本
// 才会变，那时这里该红一次、提醒把新指纹抄进来）。每一行都带"为什么是它"，因为
// 这张表就是"名字应当长什么样"这份语义本身——抄错一行 = 抄错一份功能定义。
// 注意字号对应的是**按钮语义**（tooltip / ACTIONS），不是按钮在工具条里的位置：
// 位置不表达语义，别按顺序去凑。
const FA = {
  'switch-model':   ['street-view', 'M320 64A64 64 0 1 0 192 64a64 64',
                     'title「更换看板娘」= 换一个人 ⇒ 人形'],
  'switch-texture': ['shirt', 'M211.8 0c7.8 0 14.3 5.7 16.7 13.',
                     'title「换装」= 换一件衣服 ⇒ T 恤'],
  photo:            ['camera-retro', 'M220.6 121.2L271.1 96 448 96l0 9',
                     'ACTIONS.photo 把 canvas 存成 PNG ⇒ 相机'],
  info:             ['circle-info', 'M256 512A256 256 0 1 0 256 0a256',
                     'ACTIONS.info 报的是实现来源 ⇒ 圈里一个 i'],
  quit:             ['xmark', 'M342.6 150.6c12.5-12.5 12.5-32.8',
                     'ACTIONS.quit 收起看板娘 ⇒ 叉'],
};
{
  const r = W('renderer.js');
  const at = r.indexOf('const ICONS = {');
  ok(at > 0, 'renderer.js：ICONS 表在');
  const src = r.slice(at, r.indexOf('\n  };', at));
  const dOf = (s) => { const m = s.match(/<path\s+d="([^"]+)"/); return m ? m[1].slice(0, 32) : null; };
  const got = {};
  for (const line of src.split('\n')) {
    const m = line.match(/^\s{4}'?([A-Za-z_$][\w$-]*)'?:\s*'([^']*)'/);
    if (m) got[m[1]] = dOf(m[2]);
  }
  eq(Object.keys(got).sort().join(','), Object.keys(FA).sort().join(','),
     'ICONS 的名字集合未变（多一个/少一个都意味着工具条动过）');
  for (const [name, [slug, pre, why]] of Object.entries(FA)) {
    eq(got[name], pre, `${name} 画的是 ${slug}（${why}）`);
  }
  eq(new Set(Object.values(got)).size, Object.keys(FA).length,
     '六个图标两两不同（同一个字形贴两处 = 有一处一定对不上功能）');
  // 第六个按钮（对话面板开关）的字形不在 ICONS 里——chat-stream.js 自建它
  const s = W('chat-stream.js');
  const hk = s.slice(s.indexOf("hitokotoBtn.id = 'waifu-tool-hitokoto'"));
  eq(dOf(hk.slice(0, hk.indexOf('</svg>'))), 'M512 240c0 114.9-114.6 208-256 2',
     '对话按钮画的是 comment（气泡 ⇒ 打开对话面板）');
  // 功能一侧也要钉住：字形对了、tooltip 接到别的按钮上，照样是"对不上功能"。
  // 20261002 起 tooltip 与 ICONS 同居 renderer.js 的 TITLES（同一把 key）：按钮由
  // registerTools() 建出，title 随之写下，不存在时序问题。旧写法把其中两条挂在
  // chat-stream 的一次性 `setTimeout(…, 1000)` 上，而按钮 4.8–6.2s 才建出来 ⇒
  // 那两条 title 在慢机上**从未挂上**（无头 Chrome + CPU 节流 ×6 实测），photo/info/quit
  // 更是一直没有提示。故这里两半都锁：文案对得上 + 不许再退回定时器抢跑。
  const TITLES_WANT = {
    'switch-model': '更换看板娘',   // 人形图标对应的那条功能
    'switch-texture': '换装',       // T 恤图标对应的那条功能
    photo: '拍照',
    info: '关于',
    quit: '收起看板娘',
  };
  const tAt = r.indexOf('const TITLES = {');
  ok(tAt > 0, 'renderer.js：TITLES 表在（tooltip 跟按钮一起建出来，不是事后补）');
  const tSrc = r.slice(tAt, r.indexOf('\n  };', tAt));
  const gotTitles = {};
  for (const line of tSrc.split('\n')) {
    const m = line.match(/^\s{4}'?([A-Za-z_$][\w$-]*)'?:\s*'([^']*)'/);
    if (m) gotTitles[m[1]] = m[2];
  }
  eq(Object.keys(gotTitles).sort().join(','), Object.keys(TITLES_WANT).sort().join(','),
     'TITLES 与 ICONS 一一对应（五个按钮条条都有 tooltip，不多不少）');
  for (const [n, t] of Object.entries(TITLES_WANT)) eq(gotTitles[n], t, `${n} 的 tooltip 是「${t}」`);
  ok(/span\.title = label/.test(r) && /setAttribute\('aria-label', label\)/.test(r),
     'renderer.js：title 与 aria-label 都在按钮建出时写（图标按钮没有可读文本，读屏靠它）');
  // 反锁"丢提示"的那种写法：两条"点完弹一句"的监听不许再抢跑一次就放弃
  ok(/bindTool\('waifu-tool-switch-model'/.test(s) && /bindTool\('waifu-tool-switch-texture'/.test(s),
     'chat-stream.js：两条监听都走 bindTool 有界重试（不再是 setTimeout 抢跑一次）');
  ok(/const bindTool = \(id, onReady, tries\) => \{/.test(s) && /widget_tool_bind_timeout/.test(s),
     'chat-stream.js：重试到点仍没有就上报，不静默装死');
  ok(/hitokotoBtn\.title = '对话'/.test(s),
     '对话按钮的 title 是「对话」（该按钮由 chat-stream 自建，故仍留在那一侧）');
  // 同一文件里 ACTIONS 的语义也核一遍（改行为的改动不该悄悄换掉图标的含义）。
  // 取各自的动作体再判——**不锚"从这里到那里多少字符"**：那种窗口在函数里
  // 加一行注释就假红一次（本仓的既有教训），而这里要锁的是"这个动作体里有没有
  // 那个动作"，与它离函数头多远无关。
  const aAt = r.indexOf('const ACTIONS = {');
  const aSrc = r.slice(aAt, r.indexOf('\n    };', aAt));
  const body = (n) => {
    const i = aSrc.search(new RegExp(`\\n      '?${n}'?:`));
    const j = aSrc.slice(i + 1).search(/\n      '?[A-Za-z_$][\w$-]*'?:/);
    return i < 0 ? '' : aSrc.slice(i, j < 0 ? undefined : i + 1 + j);
  };
  ok(/canvas\.toDataURL\('image\/png'\)/.test(body('photo')),
     'ACTIONS.photo 仍是"把画布存成 PNG"（所以它的图标必须是相机）');
  ok(/classList\.add\('waifu-hidden'\)/.test(body('quit')),
     'ACTIONS.quit 仍是"收起看板娘"（所以它的图标必须是叉）');
}

console.log(`\n${fail ? '✗' : '✓'} live2d-widget-scope：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

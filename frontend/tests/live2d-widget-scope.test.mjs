import { readFileSync } from 'fs';
import path from 'path';
import { runtime, widgetSource } from './helpers/widget-runtime.mjs';
import { fileURLToPath } from 'url';
import { JSDOM, VirtualConsole } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const W = widgetSource;

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; return; }
  fail++;
  console.log('  ✗ ' + name + (extra ? '\n      ' + extra : ''));
};
const eq = (a, b, name) => ok(a === b, name, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`);

const stripComment = (l) => {
  const i = l.indexOf('//');
  let code = i >= 0 ? l.slice(0, i) : l;
  return /^\s*\*/.test(code) ? '' : code;
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

{
  const f = runtime();
  try {
    ok(typeof f.engine.hooks.onAskResync === 'function', '确认卡恢复接入实际工厂');
    ok(typeof f.engine.hooks.onFailedResync === 'function', '失败操作恢复接入实际工厂');
    ok(!!f.doc.querySelector('#waifu-tool-hitokoto[title="对话"]'), '工具栏从构建产物初始化');
  } finally { f.close(); }
}

{
  const r = W('chat-render.js');
  const template = r.match(/const chatHTML = `([\s\S]*?)`;/)?.[1];
  ok(!!template, 'chat-render.js：能够解析实际面板模板');
  const dom = new JSDOM(template || '');
  const messages = dom.window.document.querySelector('#chat-messages.chat-messages');
  const card = dom.window.document.getElementById('chat-ask');
  ok(!!messages && !!card && messages.contains(card), 'chat-render.js：确认卡片在消息区域内部');
  ok(!!card && card.parentElement === messages, '卡片是 messages 的直接子节点');
  ok(!!card && card.classList.contains('chat-keep'), '模板卡片具有孤儿清理豁免标记');
  dom.window.close();
  ok(!/chat-new-msg-note[\s\S]{0,400}id="chat-ask"/.test(r), '卡片不再挂在输入区上方那一族兄弟节点里');
  const css = W('widget.css');
  ok(/#waifu-chat #chat-ask \{/.test(css), 'widget.css：卡片有自己的定位覆盖（两个 id 压过位移群）');
  ok(/#waifu-chat #chat-ask \.chat-ask-note/.test(css), 'widget.css：已确认/已取消灰字样式在');
  ok(/\.nav-question p \{ margin: 0; \}/.test(css),
     'widget.css：问句段落下边距归零（markdown 产出的 <p> 不该吃 UA 的 1em）');
  ok(!/\.nav-question \{[^}]*white-space: pre-line/.test(css),
     'widget.css：问句不残留 white-space: pre-line（markdown 已管换行，再管一次是双倍行距）');
}

{
  const e = W('chat-engine.js');
  const wipes = e.split('\n').reduce((acc, l, i) => {
    if (l.includes("messages.innerHTML = ''")) acc.push(i);
    return acc;
  }, []);
  eq(wipes.length, 3, 'chat-engine.js 有三处清空消息区');
  const tail = (i) => e.split('\n').slice(Math.max(0, i - 20), i + 16).join('\n');
  for (const i of wipes) {
    ok(/ctx\.state\.pendingAsk = null/.test(tail(i)), `清空消息区（第 ${i + 1} 行）同时丢掉挂起的确认`);
  }
}
{
  const css = W('widget.css').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(/#waifu \{[^}]*\bleft: 15px/.test(css),
     'widget.css：#waifu 初始 left = 15px');
  ok(/#waifu \{[^}]*transform: translateY\(-15px\)/.test(css),
     'widget.css：#waifu 基态 transform = translateY(-15px)');
  ok(/#waifu:hover \{\s*[^}]*transform: translateY\(-15px\)/.test(css),
     'widget.css：#waifu:hover 与基态同值（不抬升）');
  const fromMedia = css.slice(css.indexOf('@media (max-width: 479px)'));
  ok(fromMedia.length > 0 && !/#waifu \{[^}]*left:/.test(fromMedia),
     'widget.css：<480px 起不再有 #waifu 的横向回落（基态即 15px）');
  ok(/#waifu-toggle \{[^}]*\bleft: 15px/.test(css),
     'widget.css：#waifu-toggle 仍恒在 15px（它不属于"看板娘本体"，不跟着动）');
}

{
  const css = W('widget.css');
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
  ok(!rules.some((r) => r.sel.includes('#waifu') && /transform:\s*scale|zoom:/.test(r.body)),
     '手机档：#waifu 身上没有缩放（有的话对话面板一起缩、包含块也变）');
  ok(!rules.some((r) => r.sel.includes('#waifu') && /transform:/.test(r.body)
                        && !/pointer-events/.test(r.body) && /scale|rotate|skew/.test(r.body)),
     '手机档：#waifu 上没有别的（缩放类）transform');
  ok(has('#waifu-tool', /right:\s*auto/) && has('#waifu-tool', /left:\s*88px/),
     '手机档：工具条重锚（right:auto + left:88px，跟着缩小的角色走）');
  ok(has('#waifu', /pointer-events:\s*none/),
     '手机档：#waifu 不吃命中（空白处的点击穿到底下的正文）');
  const auto = rules.filter((r) => /pointer-events:\s*auto/.test(r.body)).flatMap((r) => r.sel);
  for (const sel of ['#waifu-canvas', '#waifu-tool', '#waifu-tool-star-box', '#waifu-chat']) {
    ok(auto.includes(sel), `手机档：${sel} 重新拿到命中（pointer-events: auto）`);
  }
  ok(!auto.includes('#waifu-tips') && !withSel('#waifu-tips').length,
     '手机档：没有给 #waifu-tips 写规则（它是 display:none，写了也不生效）');
}

{
  const r = W('chat-render.js');
  const e = W('chat-engine.js');
  ok(/classList\.contains\('chat-keep'\)[^;]*continue;/.test(e),
     'chat-engine.js：孤儿判定豁免 chat-keep 节点');
  ok(/if \(!doomed\.has\(child\)\) continue;/.test(e),
     'chat-engine.js：真删除只认预先算好的 doomed 集合（判据只有一处）');
  ok(/__reportError\(\{ type: 'orphan_dom_drop'/.test(e),
     'chat-engine.js：删掉带 id 的常驻节点要上报（漏加 chat-keep 的探照灯）');
  ok(/onAskResync/.test(e) && /ui\.onAskResync\(\)/.test(e),
     'chat-engine.js：reconcileDOM 收尾调用 onAskResync（DOM 重建后卡片自愈）');
  const f = runtime({steering: {begin() {}, end() {}, restore() { restored++; }}});
  let restored = 0;
  try {
    const card = {id:'restore',token:'fixture-only',q:'继续操作？',exp:Date.now()/1000+600,
      opts:[{value:'yes',label:'确认'},{value:'no',label:'取消'}]};
    f.approval.receive(card,42,null); f.approval.syncAsk();
    f.ctx.dom.askBox.classList.remove('active');
    f.engine.hooks.onAskResync();
    ok(f.ctx.dom.askBox.classList.contains('active'), 'DOM重建后恢复挂起确认卡');
    const slot = f.doc.createElement('div'); slot.className='chat-msg-retry-slot';
    slot.dataset.failedText='继续请求'; slot.dataset.turnId='failed-turn';
    f.ctx.dom.messages.appendChild(slot);
    f.engine.hooks.onFailedResync();
    eq(slot.querySelectorAll('.chat-retry-btn').length,2,'失败恢复实际重挂重发/编辑按钮');
    eq(restored,1,'失败恢复同时核对任务补充状态');
    f.engine.hooks.onFailedResync();
    eq(slot.querySelectorAll('.chat-retry-btn').length,2,'重复恢复不会重复添加操作');
    const parser=f.win.__waifuChatProtocol.createStream(()=>{});
    let rejected=false;
    try {parser.feed('event: done\ndata: {}\n\nevent: text\ndata: "late"\n\n');}
    catch {rejected=true;}
    ok(rejected,'构建协议拒绝终局后的迟到事件');
  } finally {f.close();}

}

{
  const s = W('chat-stream.js');
  ok(s.includes("type === 'confirmation'"), '确认卡只由具名事件产生');
  ok(/confirm_token: opts\.confirmToken/.test(s), '请求体带 confirm_token');
  const idx = readFileSync(path.join(here, '../src/components/Live2dAgent/loader.ts'), 'utf8');
  ok(W('boot.js').includes("entry.searchParams.get('v')")
      && idx.includes('boot.js?v=${widgetLock.sha}'), '组件子资源沿用宿主锁定的版本');
}

{
  const r = W('renderer.js');
  const labels = {
    'switch-model': '更换看板娘', 'switch-texture': '换装', photo: '拍照',
    info: '关于 Agent 项目', quit: '收起看板娘',
  };
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://fixture.invalid/', runScripts: 'outside-only', virtualConsole: new VirtualConsole(),
  });
  try {
    dom.window.eval(r);
    dom.window.__waifuRenderer().init();
    await new Promise(resolve => setTimeout(resolve, 0));
    const buttons = [...dom.window.document.querySelectorAll('#waifu-tool button')];
    eq(buttons.map(button => button.id).join(','), Object.keys(labels).map(name => `waifu-tool-${name}`).join(','),
      '渲染后的工具按钮保留稳定顺序与动作 ID');
    const paths = [];
    for (const [name, label] of Object.entries(labels)) {
      const button = dom.window.document.getElementById(`waifu-tool-${name}`);
      eq(button?.type, 'button', `${name} 使用原生按钮语义`);
      eq(button?.title, label, `${name} 的工具提示正确`);
      eq(button?.getAttribute('aria-label'), label, `${name} 提供可读名称`);
      const svg = button?.querySelector('svg');
      eq(svg?.getAttribute('aria-hidden'), 'true', `${name} 的装饰图标不重复朗读`);
      ok(!!svg?.querySelector('path[d]'), `${name} 的图标可渲染`);
      paths.push(svg?.querySelector('path')?.getAttribute('d'));
    }
    eq(new Set(paths).size, buttons.length, '工具使用互不混淆的图标');
    const opened = [];
    dom.window.open = (...args) => opened.push(args);
    dom.window.document.getElementById('waifu-tool-info').click();
    eq(JSON.stringify(opened), JSON.stringify([['https://github.com/BigLeopardCat/saudade-blog-agent', '_blank', 'noopener,noreferrer']]),
      '关于按钮打开 Agent 仓库并隔离 opener');
  } finally { dom.window.close(); }
  const f = runtime();
  try {
    const chat = f.doc.getElementById('waifu-tool-hitokoto');
    eq(chat?.title, '对话', '对话入口保留可读提示');
    ok(!!chat?.querySelector('svg path[d]'), '对话入口包含图标');
  } finally { f.close(); }
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

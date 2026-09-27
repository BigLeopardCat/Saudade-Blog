/**
 * 看板娘对话脚本的最小 DOM stub（20260927 从 chat-autoload-smoke.test.mjs 与
 * chat-time-divider.test.mjs 抽出——两者当时还叫 smoke-harness.mjs / repro-timegap.mjs）。
 *
 * **为什么抽出来**：那两个 harness 各自复制了一份，注释写着"与 … 同构"——同构靠人记，
 * 漂了就各自出各自的结论。20260927 实测：**两份都没有 `document.querySelector`**，
 * 于是两支都在 `chat-stream.js:1896`（拖拽图片入输入栏）抛 TypeError，谁也没跑到自己
 * 声称在测的地方；冒烟那支还因为 `/api/chat/conversations` 没有桩，在
 * `ensureConversation` 的 catch 里被吞成 false，**每一轮都停在「创建新会话失败」气泡上**
 * ——自称在测 SSE 往返，其实一次都没发出去。
 *
 * 三处刻意按真机语义写（都是有原因才写成这样的，别顺手简化）：
 *   ① `appendChild` / `insertBefore` **移动**节点（已挂载的先摘再插）。不移动的话同一个
 *      节点会同时挂在两个父节点的 children 里，reconcile 的重排断言就永远是假的。
 *   ② `insertAdjacentHTML` 按**栈**还原嵌套。真机上 `#chat-ask`（常驻确认卡）就在
 *      `#chat-messages` 里，把 `id="…"` 一律摊平成直接子节点会让 `children` 语义整体失真
 *      （"初始无消息"数 `children.length` 正是那个形状才成立）。
 *   ③ `style` 是 CSSStyleDeclaration（要 `setProperty`），不是裸 `{}`
 *      （chat-session.js:607 用它覆写面板几何，裸对象上会抛）。
 *
 * 顺带一提：真机 `element.style.width = '10px'` 这类直接赋值在本 stub 上照常可用
 * （Style 就是个普通对象 + 三个方法）；只有"读回来"这件事是近似的。
 */
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

class Style {
  constructor() { this._p = {}; }
  setProperty(k, v) { this._p[k] = String(v); }
  getPropertyValue(k) { return this._p[k] ?? ''; }
  removeProperty(k) { const v = this._p[k] ?? ''; delete this._p[k]; return v; }
}

class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach(x => this.set.add(x)); }
  remove(...c) { c.forEach(x => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c) { this.contains(c) ? this.remove(c) : this.add(c); }
}

// 空元素：写不写自闭合斜杠都不该进栈（`<input … hidden>` 就没写）
const VOID_TAGS = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'source',
  'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);

// 扁平注册表：`document.querySelector` 要能查到**任意位置**的元素（真实 DOM 里它从根
// 往下搜）。只实现到 Element 一级是不够的——那个洞让两支 harness 都死在第 1896 行。
const allEls = [];

class Element {
  constructor(tag, id) {
    this.tagName = String(tag).toUpperCase();
    this.id = id || '';
    this.children = [];
    this.dataset = {};
    this.style = new Style();
    this.classList = new ClassList();
    this.parentNode = null;
    this._listeners = {};
    this._attrs = {};
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0;
    this.textContent = '';
    this._html = '';
    this.disabled = false;
    this.title = '';
    this.value = '';
    this.src = '';
    this.type = '';
    allEls.push(this);
  }
  get className() { return this._className || ''; }
  set className(v) { this._className = v; this.classList = new ClassList(); String(v).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c)); }
  get firstChild() { return this.children[0] || null; }
  get previousSibling() { return this.parentNode ? this.parentNode.children[this.parentNode.children.indexOf(this) - 1] || null : null; }
  get nextSibling() { return this.parentNode ? this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null : null; }
  appendChild(c) {
    // 真机语义：已挂载的元素先摘再插（不然同一个节点会在两个父节点里各挂一份）
    if (c.parentNode && c.parentNode !== this) {
      const i = c.parentNode.children.indexOf(c);
      if (i >= 0) c.parentNode.children.splice(i, 1);
    }
    c.parentNode = this; this.children.push(c); return c;
  }
  insertBefore(c, ref) {
    if (c.parentNode && c.parentNode !== this) { const i = c.parentNode.children.indexOf(c); if (i >= 0) c.parentNode.children.splice(i, 1); }
    if (c.parentNode === this) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
    if (!ref) { c.parentNode = this; this.children.push(c); return c; }
    const i = this.children.indexOf(ref);
    if (i < 0) { c.parentNode = this; this.children.push(c); return c; }
    c.parentNode = this;
    this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return this._attrs[k] ?? null; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { const a = this._listeners[t]; if (a) this._listeners[t] = a.filter(f => f !== fn); }
  focus() {}
  contains() { return false; }
  animate() {}
  matches() { return false; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (matchesSel(c, sel)) out.push(c); walk(c); } };
    walk(this); return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  set innerHTML(v) { this._html = v; this.textContent = String(v).replace(/<[^>]*>/g, ''); this._htmlSets = (this._htmlSets || 0) + 1; }
  get innerHTML() { return this._html; }
  insertAdjacentHTML(pos, html) {
    // 极简 HTML 解析：只认开始/结束标签 + id/class 两个属性，按**栈**还原嵌套
    //（见文件头 ②；注释里的 `<div …>` 不参与——`<(` 不匹配 `<!`）
    const stack = [this];
    const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
    let m;
    while ((m = re.exec(html))) {
      const tag = m[2].toLowerCase();
      let attrs = m[3] || '';
      const selfClose = /\/\s*$/.test(attrs);
      if (m[1] === '/') { if (stack.length > 1) stack.pop(); continue; }
      attrs = attrs.replace(/\/\s*$/, '');
      const el = new Element(tag);
      const idm = /(?:^|\s)id="([^"]*)"/.exec(attrs);
      const clm = /(?:^|\s)class="([^"]*)"/.exec(attrs);
      if (idm) { el.id = idm[1]; document._byId[el.id] = el; }
      if (clm) el.className = clm[1];
      stack[stack.length - 1].appendChild(el);
      if (!selfClose && !VOID_TAGS.has(tag)) stack.push(el);
    }
  }
  click() { (this._listeners.click || []).forEach(fn => fn({ target: this, stopPropagation() {}, preventDefault() {} })); }
}

function matchesSel(el, sel) {
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('[')) return true;   // 属性选择器：只当"存在性"用，不解析条件
  return el.tagName === sel.toUpperCase();
}

const document = {
  _byId: {},
  _listeners: {},
  head: new Element('head'),
  createElement(tag) { return new Element(tag); },
  createTextNode(t) {
    const n = new Element('text');
    n.textContent = String(t);
    return n;
  },
  getElementById(id) { return this._byId[id] || null; },
  // 文档级查询走扁平注册表（真实 DOM 里从根往下搜；全仓只有 1 个调用点，
  // 形态固定是 `querySelector('.some-class')`，class 选择器在 matchesSel 里是准的）
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  querySelectorAll(sel) { return allEls.filter((el) => matchesSel(el, sel)); },
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
  removeEventListener() {},
  dispatchEvent() {},
};

/** 装上 DOM 全局。返回 `{ document, Element }`，调用方一般用不到返回值。 */
export function installDom() {
  globalThis.document = document;
  globalThis.Element = Element;   // live2d-widget.js 的 animate 检测引用全局 Element
  globalThis.addEventListener = (t, fn) => { (document._listeners[t] = document._listeners[t] || []).push(fn); };
  globalThis.removeEventListener = (t, fn) => { const a = document._listeners[t]; if (a) document._listeners[t] = a.filter(f => f !== fn); };
  return { document, Element };
}

/**
 * `document.head.appendChild` → **真读磁盘上的子模块并执行**（autoload 的动态加载路径
 * 由此走通），随后触发 onload/onerror。`dir` = `public/live2d-widgets` 的绝对路径。
 *
 * type=module 的脚本（waifu-tips.js）**跳过执行**：它是 ES module，其 initWidget 由
 * harness 桩接管，这里只需把加载链走完（执行它反而会走真 initWidget 去建真看板娘）。
 */
export function installScriptLoader(dir) {
  document.head.appendChild = (el) => {
    setTimeout(() => {
      if (el.tagName === 'SCRIPT' && el.src && el.src.includes('/live2d-widgets/') && el.type !== 'module') {
        const name = el.src.split('/').pop().split('?')[0];
        const p = dir + '/' + name;
        if (existsSync(p)) vm.runInThisContext(readFileSync(p, 'utf8'), { filename: name });
      }
      if (el.onload) el.onload(); else if (el.onerror) el.onerror();
    }, 0);
    return el;
  };
}

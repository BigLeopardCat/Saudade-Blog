/**
 * 聊天脚本接线测试的共享 DOM 桩，不计算 CSS 布局；几何与滚动由 Playwright 验证。
 * 节点插入会移动原节点，HTML 保留嵌套，选择器按值匹配。
 * style 支持直接赋值和 setProperty；computed style 仅返回已设置的行内值及必要默认值。
 */
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

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
  prepend(...nodes) {
    for (const node of nodes.reverse()) {
      if (node !== this.firstChild) this.insertBefore(node, this.firstChild);
    }
  }
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
  contains(node) {
    for (let current = node; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }
  animate() {}
  matches(sel) { return matchesSel(this, sel); }
  closest(sel) {
    let n = this;
    while (n) { if (n.matches && n.matches(sel)) return n; n = n.parentNode; }
    return null;
  }
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

/**
 * 选择器判定：`,` 列表 + 标签名 + `.class` + `#id` + `[attr]` / `[attr="值"]`
 * （含 `data-*` ↔ `dataset` 的映射）。**认不出来的写法一律 false。**
 *
 * 20260927 修：属性选择器此前是 `return true`（"只当存在性用"），于是
 * `querySelector('[data-mtype="user"][data-mid="…"]')` **返回注册表里第一个元素**，
 * 与条件毫无关系——`restoreAndCleanup` 拿它去 `removeChild`，"删掉那条用户气泡"
 * 这条链路要么删错人、要么（父节点为空时）静默不删，两种都让判据假绿。
 * 属性选择器在本仓只用于三类真实取值（`[data-mid=…]` 定位消息、`[data-mtype=…]`
 * 与 `[data-ask-value]`），值匹配比"存在性"更接近真机，不存在"故意恒真"的用法。
 */
function matchesSel(el, sel) {
  return String(sel).split(',').some(one => matchesSimple(el, one.trim()));
}

function matchesSimple(el, sel) {
  if (!sel) return false;
  let s = sel;
  const tag = /^([a-zA-Z][\w-]*|\*)/.exec(s);
  if (tag) {
    s = s.slice(tag[0].length);
    if (tag[0] !== '*' && el.tagName !== tag[0].toUpperCase()) return false;
  }
  while (s) {
    let m;
    if (s[0] === '.' && (m = /^\.([\w-]+)/.exec(s))) {
      s = s.slice(m[0].length);
      if (!el.classList.contains(m[1])) return false;
    } else if (s[0] === '#' && (m = /^#([\w-]+)/.exec(s))) {
      s = s.slice(m[0].length);
      if (el.id !== m[1]) return false;
    } else if (s[0] === '[' && (m = /^\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/.exec(s))) {
      s = s.slice(m[0].length);
      const v = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
      if (!attrMatches(el, m[1], v)) return false;
    } else {
      return false;   // 认不出来的写法（后代/子代/伪类…）：本 stub 不支持，别假装匹配
    }
  }
  return true;
}

function attrMatches(el, name, v) {
  let cur;
  if (name.startsWith('data-')) {
    const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    cur = el.dataset ? el.dataset[key] : undefined;
  } else if (el._attrs && name in el._attrs) {
    cur = el._attrs[name];
  } else if (name in el && typeof el[name] !== 'object') {
    cur = el[name];
  }
  if (v === undefined) return cur !== undefined && cur !== null && cur !== '' && cur !== false;
  return String(cur) === v;
}

const document = {
  _byId: {},
  _listeners: {},
  head: new Element('head'),
  // 真机恒有 body（看板娘渲染层把 #waifu 骨架 insertAdjacentHTML 到 body 上）。
  // 此前没有它是因为没有任何被测模块用过 document.body —— 不是"故意不提供"，
  // 而是直到 20261001 渲染层换自研才第一次被用到。
  body: new Element('body'),
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
  // Layout and resize delivery are checked in Playwright; this harness wires events only.
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.getComputedStyle = el => Object.assign({ maxHeight: 'none' }, el.style);
  globalThis.document = document;
  globalThis.Element = Element;   // stage.js 的 animate 检测引用全局 Element
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
    setTimeout(async () => {
      if (el.tagName === 'SCRIPT' && el.src && el.src.includes('/live2d-widgets/')) {
        const name = el.src.split('/').pop().split('?')[0];
        const p = dir + '/' + name;
        if (existsSync(p) && el.type === 'module') await import(pathToFileURL(p).href);
        else if (existsSync(p)) vm.runInThisContext(readFileSync(p, 'utf8'), { filename: name });
      }
      if (el.onload) el.onload(); else if (el.onerror) el.onerror();
    }, 0);
    return el;
  };
}

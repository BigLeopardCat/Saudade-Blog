/**
 * 博客同款 Markdown 渲染器（与文章页 bytemd <Viewer> 同一套 unified 管线）
 *
 * 看板娘对话框是 public/ 下的原生脚本，无法直接 import npm 包，
 * 因此由 React 应用在启动时注册两个全局供 public/live2d-widgets/autoload.js 复用：
 *  - window.__chatRenderMarkdown(text) => HTML 字符串
 *  - window.__chatEnhance(root)        => 渲染后增强：代码高亮 + KaTeX 公式（懒加载）
 *
 * 管线与 bytemd Viewer 保持一致：remark-parse + gfm/breaks/gemoji/math 插件
 * + remark-rehype(allowDangerousHtml) + rehype-raw + rehype-sanitize(默认 schema + className)
 * + rehype-stringify，输出与博客文章渲染完全一致。
 */
import { unified, type Processor } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import { defaultSchema } from 'hast-util-sanitize'
import gfm from '@bytemd/plugin-gfm'
import breaks from '@bytemd/plugin-breaks'
import gemoji from '@bytemd/plugin-gemoji'
import math from '@bytemd/plugin-math'
import mermaid from '@bytemd/plugin-mermaid'
import { remarkStickers } from './stickers'

// 与 bytemd Viewer 相同：克隆默认 schema 并允许 className（供高亮等插件使用）
const schema = JSON.parse(JSON.stringify(defaultSchema)) as { attributes: Record<string, string[]> }
schema.attributes['*'].push('className')

// 渲染管线（gfm 删除线/表格/任务列表、breaks 硬换行、gemoji 表情、内置表情包 :名字:、math 公式、raw HTML 白名单过滤）
let processor: Processor = unified().use(remarkParse)
// singleTilde: false——remark-gfm 默认允许单 ~ 成对作删除线，中文范围写法
// （"30~50""10~15"）会被误渲染成 <del>（20260831 对话框实测，文章页/编辑器同步）
for (const plugin of [gfm({ singleTilde: false }), breaks(), gemoji(), math()]) {
  if (plugin.remark) processor = plugin.remark(processor)
}
// 内置表情包在 gemoji 之后执行：:中文名: 与 :smile: 互不冲突（gemoji 只动 ASCII 名）
processor = processor.use(remarkStickers)
processor = processor
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, schema)
  .use(rehypeStringify)

const mermaidViewerEffect = mermaid().viewerEffect

export const renderBlogMarkdown = (text: string): string => {
  try {
    return String(processor.processSync(text))
  } catch (e) {
    console.error('[chatMarkdown] render failed:', e)
    return text
  }
}

// ── 代码块标签栏 + 复制按钮（20260914）──
// 文章页 bytemd <Viewer> 与对话框都只渲染 markdown（高亮插件只往 token 上套 span），
// 没有语言标签栏与复制按钮（bytemd 的工具栏只存在于 Editor）——渲染后统一装饰：
// 读 <code class="language-x"> 显示语言名，最右侧挂复制按钮（复制原始代码文本）。
// 文章页在 ReadArticle 的 effect 里对 #content 调用，对话框走 __chatEnhance
// （applyMsg 每次 innerHTML 渲染后必调），两条路径共用本函数。
const LANG_LABELS: Record<string, string> = {
  js: 'JavaScript', javascript: 'JavaScript', mjs: 'JavaScript', jsx: 'JSX',
  ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX',
  py: 'Python', python: 'Python', sh: 'Shell', bash: 'Shell', shell: 'Shell', zsh: 'Shell',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI', sql: 'SQL',
  html: 'HTML', xml: 'XML', css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less',
  md: 'Markdown', markdown: 'Markdown', rust: 'Rust', rs: 'Rust', go: 'Go',
  java: 'Java', kt: 'Kotlin', c: 'C', cpp: 'C++', 'c++': 'C++', cs: 'C#',
  php: 'PHP', rb: 'Ruby', dockerfile: 'Dockerfile', makefile: 'Makefile',
  diff: 'Diff', nginx: 'Nginx', nix: 'Nix', lua: 'Lua', vue: 'Vue', text: 'Text',
}

// 语言名：hljs 别名表转展示名；未收录的原样显示（不猜），无标注显示「代码」
const langLabel = (code: HTMLElement): string => {
  const m = /(?:^|\s)language-([\w+#.-]+)/.exec(code.className)
  if (!m) return '代码'
  const raw = m[1].toLowerCase()
  return LANG_LABELS[raw] || m[1]
}

// 剪贴板：优先异步 API（https/安全上下文），失败回退 execCommand（http 调试场景）
const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 落到 execCommand 兜底 */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch { return false }
}

/**
 * 渲染后装饰：给每个代码块上方插入语言标签栏 + 复制按钮。幂等（重复调用不重复插入），
 * 并清理落单的标签栏（mermaid 异步把 pre 换成图后会留下），可在 MutationObserver 里反复跑。
 */
export const decorateCodeBlocks = (root: HTMLElement | null): void => {
  if (!root) return
  root.querySelectorAll<HTMLElement>('pre').forEach((pre) => {
    if (pre.dataset.codeHead === '1') return
    const code = pre.querySelector('code')
    if (!code) return
    // mermaid 代码块由 @bytemd/plugin-mermaid 渲染成图（异步），不留标签栏
    if (/(?:^|\s)language-mermaid(?:\s|$)/.test(code.className) || pre.closest('.bytemd-mermaid')) return

    const head = document.createElement('div')
    head.className = 'code-block-head'
    const label = document.createElement('span')
    label.className = 'code-lang'
    label.textContent = langLabel(code)
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'code-copy'
    btn.textContent = '复制'
    btn.addEventListener('click', () => {
      // 点击时现取代码文本：React/bytemd 重渲染后节点会被换掉，闭包里的 code 可能已脱离文档
      const next = head.nextElementSibling as HTMLElement | null
      const text = next?.querySelector('code')?.textContent || ''
      copyText(text).then((ok) => {
        btn.textContent = ok ? '已复制' : '复制失败'
        btn.classList.toggle('copied', ok)
        window.setTimeout(() => {
          btn.textContent = '复制'
          btn.classList.remove('copied')
        }, 1500)
      })
    })
    head.appendChild(label)
    head.appendChild(btn)
    pre.dataset.codeHead = '1'
    pre.parentNode?.insertBefore(head, pre)
  })
  root.querySelectorAll<HTMLElement>('.code-block-head').forEach((head) => {
    const next = head.nextElementSibling
    if (!next || next.tagName !== 'PRE') head.remove()
  })
}

/**
 * 渲染后装饰：给正文里出现的**站内色板色值**加一个色块预览（20260921 颜色预览）。
 *
 * 「agent 在决定颜色时回复颜色描述和颜色编码以及对应色块预览」——文字（色名）
 * 与编码（#eb2f96）由 narrator 写在正文里，色块由这里渲染：**不让模型自己画符号**
 * （模型画不出色块，只会写 🟥 或 ![img]，两边都不可控）。
 *
 * 三条约束：
 *  ① 只认**站内 8 色板**内的色值（与 `agent/adminops.py::NEW_TAG_COLORS` 和
 *    `components/NoteTagSelect/index.tsx` 同源）——色板是白名单，不是"任意 hex 都画"，
 *     否则正文里随手一个 #fff 也会冒出色块；
 *  ② 跳过 `pre`/`code`/`a` 内部的文本节点：代码块里的 #1677ff 不该被装饰；
 *  ③ 幂等：色块与编码一起包进 `.chat-swatch-wrap`，再调用时整段被跳过
 *     （装饰后的编码文本仍是文本，不包起来第二次就会再加一个色块）。
 */
export const chatColorPalette = ['#1677ff', '#52c41a', '#fa8c16', '#eb2f96',
                                 '#722ed1', '#13c2c2', '#f5222d', '#a0d911'] as const

const HEX_IN_TEXT_RE = /#[0-9a-fA-F]{6}\b/g
// 非 /g 版本只用于"这段文本里有没有色值"的预筛——/g 正则带 lastIndex 状态，
// 混用会在多次调用间留下陈旧游标
const HEX_ANY_RE = /#[0-9a-fA-F]{6}\b/

export const decorateColorSwatches = (root: HTMLElement | null): void => {
  if (!root) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  let node = walker.nextNode()
  while (node) {
    const t = node as Text
    const parent = t.parentElement
    if (parent && !parent.closest('pre, code, a, .chat-swatch-wrap') && HEX_ANY_RE.test(t.data)) {
      targets.push(t)
    }
    node = walker.nextNode()
  }
  targets.forEach((t) => {
    const text = t.data
    const frag = document.createDocumentFragment()
    let last = 0
    HEX_IN_TEXT_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = HEX_IN_TEXT_RE.exec(text))) {
      const hex = m[0].toLowerCase()
      if (!(chatColorPalette as readonly string[]).includes(hex)) continue
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)))
      const wrap = document.createElement('span')
      wrap.className = 'chat-swatch-wrap'
      const chip = document.createElement('span')
      chip.className = 'chat-swatch'
      chip.style.background = hex
      chip.setAttribute('aria-label', hex)
      wrap.appendChild(chip)
      wrap.appendChild(document.createTextNode(hex))
      frag.appendChild(wrap)
      last = m.index + m[0].length
    }
    if (!last) return
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
    t.parentNode?.replaceChild(frag, t)
  })
}

// 渲染后增强：代码高亮（与 @bytemd/plugin-highlight 一致）+ KaTeX 公式（与 @bytemd/plugin-math 一致）。
// 均懒加载，atom-one-dark / katex 样式已由文章页与编辑器全局注入。
export const enhanceChatContent = (root: HTMLElement): void => {
  // 代码块标签栏 + 复制按钮（同步注入：不等 highlight.js 懒加载，标签栏先出来）
  try {
    decorateCodeBlocks(root)
  } catch { /* 装饰失败不影响正文 */ }
  // 色块预览（20260921）：站内色板色值 → 色块 + 编码并列
  try {
    decorateColorSwatches(root)
  } catch { /* 装饰失败不影响正文 */ }
  try {
    mermaidViewerEffect?.({ markdownBody: root })
  } catch { /* Mermaid 单图失败不影响正文 */ }
  // 代码高亮
  if (root.querySelector('pre>code')) {
    import('highlight.js').then((m) => {
      root.querySelectorAll<HTMLElement>('pre>code').forEach((el) => {
        try {
          m.default.highlightElement(el)
        } catch {
          /* 单个代码块高亮失败不影响正文 */
        }
      })
    })
  }
  // 公式渲染
  if (root.querySelector('.math')) {
    import('katex').then((m) => {
      const katex = m.default
      root.querySelectorAll<HTMLElement>('.math.math-inline').forEach((el) => {
        try { katex.render(el.innerText, el, { throwOnError: false, displayMode: false }) } catch { /* ignore */ }
      })
      root.querySelectorAll<HTMLElement>('.math.math-display').forEach((el) => {
        try { katex.render(el.innerText, el, { throwOnError: false, displayMode: true }) } catch { /* ignore */ }
      })
    })
  }
}

declare global {
  interface Window {
    __chatRenderMarkdown?: (text: string) => string
    __chatEnhance?: (root: HTMLElement) => void
    /** 色块装饰单独暴露（20260921）：chat-render.js 的迷你渲染器路径没有
     *  __chatEnhance 时也能画色块（该函数幂等，重复调用安全） */
    __chatDecorateColors?: (root: HTMLElement) => void
  }
}

// 模块加载即注册，Live2dAgent 在注入看板娘脚本前 import 本模块即可
window.__chatRenderMarkdown = renderBlogMarkdown
window.__chatEnhance = enhanceChatContent
window.__chatDecorateColors = decorateColorSwatches

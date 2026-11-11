/**
 * 评论/看板娘共享 Markdown 渲染器（与文章页保持共同格式和清洗约定）
 *
 * 看板娘对话框是 public/ 下的原生脚本，无法直接 import npm 包，
 * 因此由 React 应用在启动时注册两个全局供 public/live2d-widgets/boot.js 复用：
 *  - window.__chatRenderMarkdown(text) => HTML 字符串
 *  - window.__chatEnhance(root)        => 渲染后增强：代码高亮 + KaTeX 公式（懒加载）
 *
 * 语法沿用文章页的 gfm/breaks/gemoji/math 组合，独立采用 unified 11 插件：remark-parse
 * + remark-rehype(allowDangerousHtml) + rehype-raw + rehype-sanitize(默认 schema + className)
 * + rehype-stringify，通过行为测试保持文章/评论/对话的共同格式与安全约定。
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import { defaultSchema } from 'hast-util-sanitize'
import gfm from 'remark-gfm'
import breaks from 'remark-breaks'
import gemoji from 'remark-gemoji'
import math from 'remark-math'
import mermaid from '@bytemd/plugin-mermaid'
import { MERMAID_CONFIG } from './mermaidTheme'
import { remarkStickers } from './stickers'
import { remarkMathElements } from './remarkMathElements'
import { remarkAutolinkBoundary } from './remarkAutolinkBoundary'

// 与 bytemd Viewer 相同：克隆默认 schema 并允许 className（供高亮等插件使用）
const schema = JSON.parse(JSON.stringify(defaultSchema)) as { attributes: Record<string, string[]> }
schema.attributes['*'].push('className')

// 渲染管线（gfm 删除线/表格/任务列表、breaks 硬换行、gemoji 表情、内置表情包 :名字:、math 公式、raw HTML 白名单过滤）
// 直接使用 unified 11 的插件，避免把 Bytemd 自有的旧 Processor/VFile 类型跨代拼接。
// 文章编辑器仍由 Bytemd 管理依赖；两条管线通过渲染行为测试核对，而非强制覆盖传递依赖。
const processor = unified()
  .use(remarkParse)
  // 中文范围 “30~50”“10~15” 不应被单波浪线识别为删除线。
  .use(gfm, { singleTilde: false })
  .use(remarkAutolinkBoundary)
  .use(breaks)
  .use(gemoji)
  .use(math)
  .use(remarkMathElements)
  .use(remarkStickers)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, schema)
  .use(rehypeStringify)

// 插件声明的入参是完整 BytemdViewerContext（含 file），但实现只解构 markdownBody
//（@bytemd/plugin-mermaid dist 里 viewerEffect({ markdownBody })）⇒ 按实际使用面收窄签名，
// 不伪造一个 file 去迎合类型
// 配色走 `utils/mermaidTheme.ts` 那一份（**必须**与文章页传同一个值：mermaid 是全局单例，
// 谁先渲染谁定调）。裸 `mermaid()` 会让对话框里的图和文章页不同款。
const mermaidViewerEffect = mermaid(MERMAID_CONFIG).viewerEffect as
  ((ctx: { markdownBody: HTMLElement }) => void) | undefined

/** HTML 转义（只给下面那条回退路径用）。
 *
 * 这是**唯一**允许出现在本模块里的另一套转义：管线自身靠 rehype-sanitize，
 * 而回退路径根本没有管线可依赖，只能把原文当纯文本吐出去。 */
export const escapeHtmlText = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

export const renderBlogMarkdown = (text: string): string => {
  try {
    return String(processor.processSync(text))
  } catch (e) {
    console.error('[chatMarkdown] render failed:', e)
    return escapeHtmlText(String(text))
  }
}

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
    __chatDecorateColors?: (root: HTMLElement) => void
  }
}

// 模块加载即注册，Live2dAgent 在注入看板娘脚本前 import 本模块即可
window.__chatRenderMarkdown = renderBlogMarkdown
window.__chatEnhance = enhanceChatContent
window.__chatDecorateColors = decorateColorSwatches

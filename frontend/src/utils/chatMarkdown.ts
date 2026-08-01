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

// 与 bytemd Viewer 相同：克隆默认 schema 并允许 className（供高亮等插件使用）
const schema = JSON.parse(JSON.stringify(defaultSchema)) as { attributes: Record<string, string[]> }
schema.attributes['*'].push('className')

// 渲染管线（gfm 删除线/表格/任务列表、breaks 硬换行、gemoji 表情、math 公式、raw HTML 白名单过滤）
let processor: Processor = unified().use(remarkParse)
for (const plugin of [gfm(), breaks(), gemoji(), math()]) {
  if (plugin.remark) processor = plugin.remark(processor)
}
processor = processor
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, schema)
  .use(rehypeStringify)

export const renderBlogMarkdown = (text: string): string => {
  try {
    return String(processor.processSync(text))
  } catch (e) {
    console.error('[chatMarkdown] render failed:', e)
    return text
  }
}

// 渲染后增强：代码高亮（与 @bytemd/plugin-highlight 一致）+ KaTeX 公式（与 @bytemd/plugin-math 一致）。
// 均懒加载，atom-one-dark / katex 样式已由文章页与编辑器全局注入。
export const enhanceChatContent = (root: HTMLElement): void => {
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
  }
}

// 模块加载即注册，Live2dAgent 在注入看板娘脚本前 import 本模块即可
window.__chatRenderMarkdown = renderBlogMarkdown
window.__chatEnhance = enhanceChatContent

/**
 * 博客内置表情包（自定义 markdown 表情语法 :名字: → <img>）
 *
 * 设计：
 * - 语法为 :中文名:（如 :头疼:），名字均为中文/数字，天然与 gemoji 插件的
 *   GitHub ASCII 表情（:smile: 等）无冲突；
 * - 仅当名字命中 STICKERS 映射时才转换，未知名字原样保留为文本；
 * - 表情以纯文本形式存储（文章正文/对话历史/摘要），渲染时按需转换，
 *   无协议/DB 改动，全端（文章/编辑器/对话）共用同一插件；
 * - 20260903 素材换为泠月喵 PNG 贴纸（public/stickers/ 下，原始大图压缩至
 *   长边 128px，透明底原样保留），语法不变；暂不做输入框选择按钮（纯渲染）。
 *   注意：chat-render.js（看板娘对话 fallback 渲染器）内联了一份同源清单，
 *   增删表情需两处同步。
 */
import type { Root } from 'mdast'

/** 名字（中文）→ 素材路径（public/stickers/ 下） */
export const STICKERS: Record<string, string> = {
  头疼: '/stickers/touteng.png',
  委屈: '/stickers/weiqu.png',
  害羞: '/stickers/haixiu.png',
  比耶: '/stickers/biye.png',
  犯错: '/stickers/fancuo.png',
  生气: '/stickers/shengqi.png',
  贴贴: '/stickers/tietie.png',
  震惊: '/stickers/zhenjing.png',
}

export const STICKER_NAMES: string[] = Object.keys(STICKERS)

const STICKER_RE = /:([^:\s]{1,12}):/g

/**
 * remark 插件（attacher 模式）：返回 transformer，把 :名字: 文本节点拆分为
 * text + image 节点序列。自写递归遍历（不用 unist-util-visit：v4 的 visitor
 * 返回约定与原地 splice 组合会破坏其迭代，已实测崩溃）；
 * 跳过代码块/行内代码（代码里的 :xx: 不应转表情）。
 */
export function remarkStickers(this: unknown) {
  return (tree: Root) => {
    const transform = (node: any) => {
      if (!node || typeof node !== 'object') return
      const children = node.children
      if (!children || !Array.isArray(children)) return
      for (let i = 0; i < children.length; i++) {
        const child = children[i]
        if (child && child.type === 'text' && typeof child.value === 'string' && child.value.includes(':')) {
          const pieces = splitStickerText(child.value)
          if (pieces.length > 1) children.splice(i, 1, ...pieces)
        }
        // 非文本节点继续下钻（inlineCode/code 是叶子，无 children 自动跳过）
        transform(child)
      }
    }
    transform(tree)
  }
}

/** 把一段文本拆成 text/image 交替节点；无命中时原样返回 [原文] */
function splitStickerText(value: string): any[] {
  const matches: RegExpExecArray[] = []
  STICKER_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = STICKER_RE.exec(value)) !== null) {
    if (STICKERS[m[1]]) matches.push(m)
  }
  if (matches.length === 0) return [value]

  const pieces: any[] = []
  let cursor = 0
  for (const match of matches) {
    const idx = match.index
    if (idx > cursor) pieces.push({ type: 'text', value: value.slice(cursor, idx) })
    pieces.push({
      type: 'image',
      url: STICKERS[match[1]],
      alt: match[1],
      title: null,
      // hProperties 是 remark-rehype 的标准透传口：给 <img> 加 class="sticker"
      data: { hProperties: { className: ['sticker'] } },
    })
    cursor = idx + match[0].length
  }
  if (cursor < value.length) pieces.push({ type: 'text', value: value.slice(cursor) })
  return pieces
}

/** bytemd 插件形式（文章 Viewer / 后台 Editor 用） */
export const bytemdStickers = {
  remark: (processor: any) => processor.use(remarkStickers),
}

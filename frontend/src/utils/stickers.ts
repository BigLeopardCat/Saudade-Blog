/** Shared site sticker aliases for Markdown and plain-text rendering. */
import type { Root } from 'mdast'

/** Render-safe pieces for hosts that do not use Markdown. */
export type StickerPiece =
  | { kind: 'text'; text: string }
  | { kind: 'sticker'; name: string; url: string }

/** 名字（中文）→ 素材路径（public/stickers/ 下） */
export const STICKERS: Record<string, string> = {
  头疼: '/stickers/v2/touteng-cardigan.webp',
  委屈: '/stickers/v2/weiqu-hoodie.webp',
  害羞: '/stickers/v2/haixiu-cardigan.webp',
  比耶: '/stickers/v2/biye-cardigan.webp',
  犯错: '/stickers/v2/fancuo-jacket.webp',
  生气: '/stickers/v2/shengqi-jacket.webp',
  贴贴: '/stickers/v2/tietie-hoodie.webp',
  震惊: '/stickers/v2/zhenjing-jacket.webp',
  困困: '/stickers/v2/kunkun-hoodie.webp',
  躺平: '/stickers/v2/tangping-hoodie.webp',
  嫌弃: '/stickers/v2/xianqi-jacket.webp',
  比心: '/stickers/v2/bixin-cardigan.webp',
  期待: '/stickers/v2/qidai-hoodie.webp',
  疑惑: '/stickers/v2/yihuo-hoodie.webp',
  喝茶: '/stickers/v2/hecha-hoodie.webp',
  晚安: '/stickers/v2/wanan-hoodie.webp',
  收到: '/stickers/v2/shoudao-cardigan.webp',
  思考: '/stickers/v2/sikao-cardigan.webp',
  加油: '/stickers/v2/jiayou-cardigan.webp',
  早安: '/stickers/v2/zaoan-cardigan.webp',
  得意: '/stickers/v2/deyi-jacket.webp',
  略略: '/stickers/v2/luelue-jacket.webp',
  偷笑: '/stickers/v2/touxiao-jacket.webp',
  无语: '/stickers/v2/wuyu-jacket.webp',
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
          // A single sticker replaces one text node too; unmatched text stays unchanged.
          if (pieces.length !== 1 || pieces[0] !== child.value) children.splice(i, 1, ...pieces)
        }
        // 非文本节点继续下钻（inlineCode/code 是叶子，无 children 自动跳过）
        transform(child)
      }
    }
    transform(tree)
  }
}

/** 扫出所有**命中清单**的 `:名字:` 位置。
 *  两个渲染器（mdast 侧与 React 片段侧）共用这一遍扫描：同一份正则、同一条
 *  "未知名字原样保留为文本"的判据 ⇒ 改匹配规则只有这一处。 */
function matchStickers(value: string): RegExpExecArray[] {
  const matches: RegExpExecArray[] = []
  STICKER_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = STICKER_RE.exec(value)) !== null) {
    if (STICKERS[m[1]]) matches.push(m)
  }
  return matches
}

/** 把一段文本拆成 text/image 交替节点；无命中时原样返回 [原文] */
function splitStickerText(value: string): any[] {
  const matches = matchStickers(value)
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

/** 把一段**纯文本**拆成 text/sticker 交替的片段；无命中（含空串）时返回一个纯文本片段。
 *
 *  与 `splitStickerText` 的差别只在产物形状：那个产 mdast 节点（喂 remark-rehype），
 *  这个产数据片段（喂 React）。**扫描是同一遍**（`matchStickers`）。
 *
 *  判据与 mdast 侧一致：只有命中 `STICKERS` 的名字才算表情，未知名字（`:不存在的:`
 *  或被 `STICKER_RE` 长度上限挡掉的）原样留在文本里。 */
export function splitStickers(value: string): StickerPiece[] {
  const matches = matchStickers(value)
  if (matches.length === 0) return [{ kind: 'text', text: value }]

  const pieces: StickerPiece[] = []
  let cursor = 0
  for (const match of matches) {
    const idx = match.index
    if (idx > cursor) pieces.push({ kind: 'text', text: value.slice(cursor, idx) })
    pieces.push({ kind: 'sticker', name: match[1], url: STICKERS[match[1]] })
    cursor = idx + match[0].length
  }
  if (cursor < value.length) pieces.push({ kind: 'text', text: value.slice(cursor) })
  return pieces
}

/** bytemd 插件形式（文章 Viewer / 后台 Editor 用） */
export const bytemdStickers = {
  remark: (processor: any) => processor.use(remarkStickers),
}

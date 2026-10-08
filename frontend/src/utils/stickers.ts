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

/** 一段文本拆出来的片段：普通文本，或一个**命中的**表情（未知名字不是片段，是普通文本）。
 *  给**纯文本宿主**用（个人中心的通知、公告弹窗、`.ucBodyText` 这类不跑 markdown 的地方）：
 *  React 直接把片段渲染成文本节点与 `<img>`，全程不产生 HTML 字符串 ——
 *  于是也不必碰 `dangerouslySetInnerHTML`（那条路的纪律是"只许喂 renderBlogMarkdown 的产物"，
 *  见 CommentSection/index.tsx 头注）。markdown 宿主仍走 `renderBlogMarkdown`（同一条 remarkStickers）。 */
export type StickerPiece =
  | { kind: 'text'; text: string }
  | { kind: 'sticker'; name: string; url: string }

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
  困困: '/stickers/kunkun.png',
  躺平: '/stickers/tangping.png',
  嫌弃: '/stickers/xianqi.png',
  比心: '/stickers/bixin.png',
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
          // 判据是「拆出来的不是原来那一个文本节点」，**不能写成 `pieces.length > 1`**
          // （20261002 修）：整段**只有一个**表情时（`:头疼:` 独占一行/整条评论只有表情），
          // 拆出来恰好是长度 1 的 `[image]`，旧判据会跳过替换 ⇒ "只发表情"反而渲染成字面文本。
          // 无命中时 splitStickerText 返回 `[value]`（同一个字符串），这里按值比对即可。
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

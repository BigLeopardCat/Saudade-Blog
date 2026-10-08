import { splitStickers } from '../utils/stickers'

/**
 * 纯文本里的内置表情包渲染（`:名字:` → `<img class="sticker">`）。
 *
 * **只给"内容是一段纯文本"的宿主用**：个人中心的公告和通知、公告弹窗。
 * 这些地方本来就不跑 markdown（正文与换行由 `white-space: pre-wrap` 负责），
 * 而 `renderBlogMarkdown` 会把它们变成 `<p>` 块——列表行那道
 * `-webkit-line-clamp: 4` 是按行数的，塞进来一个块级子元素就判不准了。
 *
 * 表情清单与匹配规则只有一份（`utils/stickers.ts`，mdast 侧那条 remark 插件
 * 与它共用同一遍扫描）；这里**不产出 HTML 字符串**，由 React 建节点，
 * 所以没有 `dangerouslySetInnerHTML` 那一族"只许喂 sanitizer 产物"的约束。
 *
 * 尺寸/对齐走 `src/index.css` 的全局 `img.sticker` 规则 —— 新增宿主不必再各写一份
 * （`.readContent` / `.commentSection` / `Editor` 里那三份是这条规则之前就有的，
 * 它们是 scoped 选择器，优先级更高、行为不变）。
 */
const StickerText = ({ text }: { text: string }) => (
  <>
    {splitStickers(text).map((p, i) =>
      p.kind === 'sticker' ? (
        // `title` 让悬停能看出这是哪一个表情（alt 只在图片加载失败/读屏时出声）
        <img key={i} className="sticker" src={p.url} alt={p.name} title={p.name} />
      ) : (
        <span key={i}>{p.text}</span>
      ),
    )}
  </>
)

export default StickerText

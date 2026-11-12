import { splitStickers } from '../utils/stickers'

/** 纯文本表情渲染，与 Markdown 共用 splitStickers；直接创建 React 节点，保留行内排版。 */
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

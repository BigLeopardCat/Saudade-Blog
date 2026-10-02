/**
 * 评论表情选择器（20261002）。
 *
 * `utils/stickers.ts` 的 `STICKER_NAMES`（:29）从 20260903 起就导出着，但**全站
 * 没有消费方**——那份文件头注 :11 写得很直白：「暂不做输入框选择按钮（纯渲染）」。
 * 这个组件就是那个缺口的补位：把站点内置表情包摆出来给评论用。
 *
 * 三条纪律：
 *
 * ① **只插入文本 `:名字:`，不插入 `<img>` 标签**。表情在库里就是一段普通文本，
 *    渲染时由 `remarkStickers`（同一条 markdown 管线）转成 `img.sticker`。
 *    直接插 HTML 等于绕过 sanitize 从侧门写标签——正是这条路会把 XSS 防线撬开。
 * ② **素材清单不在这里抄第二份**：遍历 `STICKER_NAMES` / `STICKERS`。新增表情
 *    只改 `utils/stickers.ts` 一处（那里的 chat-render.js 内联清单是历史遗留，见该文件头注）。
 * ③ **点击外部 / Esc 关闭**，且不吞掉点击（用 `mousedown` 判定而不是给 body 挂
 *    捕获阶段监听——后者会把「点表情」本身也判成"点到了外部"）。
 */
import { useEffect, useRef, useState } from 'react'
import { STICKERS, STICKER_NAMES } from '../../utils/stickers'
import { resolveApiAssetUrl } from '../../utils/runtimeApi'

interface StickerPickerProps {
    /** 选中一个表情：回名字（中文），调用方拼成 `:名字:` 插进输入框 */
    onPick: (name: string) => void
    disabled?: boolean
}

const StickerPicker = ({ onPick, disabled }: StickerPickerProps) => {
    const [open, setOpen] = useState(false)
    const boxRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return
        const onDown = (e: MouseEvent) => {
            // 点在面板**或其触发按钮**上都算内部（触发按钮自己 toggle，不在这里关）
            if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
        }
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDown)
            document.removeEventListener('keydown', onKey)
        }
    }, [open])

    return (
        <div className="commentSticker" ref={boxRef}>
            <button
                type="button"
                className={`commentStickerBtn${open ? ' isOpen' : ''}`}
                disabled={disabled}
                aria-expanded={open}
                aria-haspopup="true"
                title="插入表情"
                onClick={() => setOpen((v) => !v)}
            >
                😊 表情
            </button>
            {open && (
                <div className="commentStickerPanel" role="menu" aria-label="站内表情包">
                    {STICKER_NAMES.map((name) => (
                        <button
                            key={name}
                            type="button"
                            className="commentStickerItem"
                            role="menuitem"
                            title={`:${name}:`}
                            onClick={() => { onPick(name); setOpen(false) }}
                        >
                            <img src={resolveApiAssetUrl(STICKERS[name])} alt={name} />
                            <span>{name}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

export default StickerPicker

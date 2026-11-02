/** Insert a known :name: token; the shared renderer resolves its image. */
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
                            <img src={resolveApiAssetUrl(STICKERS[name])} alt={name} loading="lazy" decoding="async" />
                            <span>{name}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

export default StickerPicker

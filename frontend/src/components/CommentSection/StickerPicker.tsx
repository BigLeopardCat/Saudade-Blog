import {t as tr, useLocale} from '../../i18n';
/** Accessible sticker popover; positioning and viewport collision use Ant Design. */
import { useEffect, useRef, useState } from 'react'
import { Popover } from 'antd'
import { STICKERS, STICKER_NAMES } from '../../utils/stickers'
import { resolveApiAssetUrl } from '../../utils/runtimeApi'
import { useIsDarkMode } from '../../theme'
import './StickerPicker.sass'

interface StickerPickerProps {
    onPick: (name: string) => void
    disabled?: boolean
}

const StickerPicker = ({ onPick, disabled }: StickerPickerProps) => {
    useLocale();
    const [open, setOpen] = useState(false)
    const dark = useIsDarkMode()
    const trigger = useRef<HTMLButtonElement>(null)
    const panel = useRef<HTMLDivElement>(null)
    const close = () => { setOpen(false); trigger.current?.focus() }
    useEffect(() => {
        if (!open) return
        const frame = requestAnimationFrame(() => panel.current?.querySelector('button')?.focus())
        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.stopPropagation()
                setOpen(false)
                trigger.current?.focus()
            }
        }
        document.addEventListener('keydown', escape)
        return () => {
            cancelAnimationFrame(frame)
            document.removeEventListener('keydown', escape)
        }
    }, [open])
    useEffect(() => { if (disabled) setOpen(false) }, [disabled])

    return <Popover trigger="click" placement="topLeft" autoAdjustOverflow
        open={open && !disabled} onOpenChange={setOpen}
        classNames={{ root: `comment-sticker-popover${dark ? ' washiDark' : ''}` }}
        content={<div ref={panel} className="commentStickerPanel" role="dialog"
            aria-label={tr("选择站内表情")}>
            {STICKER_NAMES.map(name => <button key={name} type="button"
                className="commentStickerItem" aria-label={tr("插入{0}", {"0": name})} title={name}
                onClick={() => { onPick(name); close() }}>
                <img src={resolveApiAssetUrl(STICKERS[name])} alt="" loading="lazy" decoding="async" />
                <span>{name}</span>
            </button>)}
        </div>}>
        <button ref={trigger} type="button" className="commentStickerBtn"
            disabled={disabled} aria-expanded={open && !disabled} aria-haspopup="dialog"
            title={tr("插入表情")}>{tr("😊 表情")}</button>
    </Popover>
}

export default StickerPicker

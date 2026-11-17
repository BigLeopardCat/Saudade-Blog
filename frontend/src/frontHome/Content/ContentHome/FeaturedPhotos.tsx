import {useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {getFeaturedPhotos, type FeaturedPhoto} from '../../../apis/featuredPhotos'
import {resolveApiAssetUrl} from '../../../utils/runtimeApi'
import './photos.css'

export default function FeaturedPhotos() {
    const [photos, setPhotos] = useState<FeaturedPhoto[]>([])
    const [current, setCurrent] = useState<number | null>(null)
    const [failed, setFailed] = useState(false)
    const [attempt, setAttempt] = useState(0)
    const trigger = useRef<HTMLButtonElement>(null)
    const dialog = useRef<HTMLDialogElement>(null)
    const close = () => setCurrent(null)
    const move = (step: number) => { setCurrent(index => index === null ? null : (index + step + photos.length) % photos.length); setFailed(false); setAttempt(0) }
    useEffect(() => {
        const controller = new AbortController()
        getFeaturedPhotos(controller.signal).then(setPhotos).catch(() => {})
        return () => controller.abort()
    }, [])
    const open = current !== null
    useEffect(() => {
        if (!open) return
        const modal = dialog.current!
        const overflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        modal.showModal()
        return () => { modal.close(); document.body.style.overflow = overflow; trigger.current?.focus({preventScroll: true}) }
    }, [open])
    if (!photos.length) return null
    const photo = current === null ? null : photos[current]
    return <>
        <button className="featuredPhotoStack" ref={trigger} type="button" aria-label={`打开精选相册（${photos.length} 张）`} onClick={() => { setFailed(false); setCurrent(0) }}>
            <span className="photoPaper photoPaperBack" aria-hidden="true"/>
            <span className="photoPaper photoPaperMiddle" aria-hidden="true"/>
            <span className="photoPaper photoPaperFront" aria-hidden="true"><svg viewBox="0 0 64 48" fill="none"><rect x="1" y="1" width="62" height="46" rx="3"/><circle cx="43" cy="14" r="4"/><path d="m5 41 17-19 13 14 9-10 15 15"/></svg><span>{photos.length.toString().padStart(2, '0')}</span></span>
        </button>
        {photo && createPortal(<dialog className="featuredPhotoViewer" ref={dialog} aria-label="精选相册" onCancel={event => { event.preventDefault(); close() }} onClick={event => { if (event.target === event.currentTarget) close() }} onKeyDown={event => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1) }
        }}>
            <button type="button" className="photoClose" aria-label="关闭相册" onClick={close}>×</button>
            <figure className="expandedPhoto">
                {/* Mount exactly one image after the user opens the album. */}
                {failed ? <button className="photoRetry" type="button" onClick={() => { setAttempt(value => value + 1); setFailed(false) }}>照片加载失败，重试</button> : <img key={`${photo.imageId}:${attempt}`} src={resolveApiAssetUrl(photo.url)} alt={photo.caption || `精选照片 ${current! + 1}`} decoding="async" onError={() => setFailed(true)}/>}
                <figcaption>{photo.caption}</figcaption>
            </figure>
            <div className="photoNavigation">
                {photos.length > 1 && <button type="button" aria-label="上一张照片" onClick={() => move(-1)}>←</button>}
                <output aria-live="polite">{current! + 1} / {photos.length}</output>
                {photos.length > 1 && <button type="button" aria-label="下一张照片" onClick={() => move(1)}>→</button>}
            </div>
        </dialog>, document.body)}
    </>
}

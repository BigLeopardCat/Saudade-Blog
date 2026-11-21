import {t as tr, useLocale} from '../../../i18n';
import {useNavigate} from 'react-router-dom'
import SectionHeading from '../../../components/SectionHeading'
import ArticleCard from '../../../components/ArticleCard'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {Modal} from 'antd'
import {Z} from '../../../zIndex'
import AnnouncementCard, {announcementTime} from '../../../components/AnnouncementCard'
import StickerText from '../../../components/StickerText'
import type {AnnouncementItem} from '../../../apis/AnnouncementMethods'
import {useIsDarkMode} from '../../../theme'
import type {NoteType} from '../../../interface/NoteType'
import type {CategoriesType} from '../../../interface/CategoriesType'
import type {renderNoteTags} from '../../../apis/TagMethods'

interface Props {
    items: NoteType[]
    announcements?: AnnouncementItem[]
    categories: CategoriesType[]
    avatar: string
    name: string
    tags: Parameters<typeof renderNoteTags>[1]
}
const GAP = 18
const SPEED = 18

const EMPTY: AnnouncementItem[] = []
type PinnedEntry = {kind: 'article'; key: string; title: string; article: NoteType} | {kind: 'announcement'; key: string; title: string; announcement: AnnouncementItem}
export default function FeaturedArticles({items, announcements = EMPTY, categories, avatar, name, tags}: Props) {
    useLocale();
    const entries = useMemo<PinnedEntry[]>(() => [
        ...announcements.map(item => ({kind: 'announcement' as const, key: `announcement-${item.id}`, title: item.title, announcement: item})),
        ...items.map(item => ({kind: 'article' as const, key: `article-${item.key}`, title: item.noteTitle, article: item})),
    ], [items, announcements])
    const [opened, setOpened] = useState<AnnouncementItem | null>(null)
    const dark = useIsDarkMode()
    const navigate = useNavigate()
    const root = useRef<HTMLElement>(null)
    const viewport = useRef<HTMLDivElement>(null)
    const track = useRef<HTMLDivElement>(null)
    const bars = useRef<(HTMLSpanElement | null)[]>([])
    const position = useRef(0)
    const touch = useRef<{x: number; y: number; offset: number} | null>(null)
    const swiped = useRef(false)
    const [width, setWidth] = useState(0)
    const [leading, setLeading] = useState(0)
    const [preview, setPreview] = useState<number | null>(null)
    const [hovered, setHovered] = useState(false)
    const previewCards = useRef<HTMLDivElement>(null)
    const [previewHeight, setPreviewHeight] = useState(280)
    const [focused, setFocused] = useState(false)
    const [dragging, setDragging] = useState(false)
    const [visible, setVisible] = useState(false)
    const [pageVisible, setPageVisible] = useState(!document.hidden)
    const [reducedMotion, setReducedMotion] = useState(false)
    const capacity = width >= 960 ? 3 : width >= 620 ? 2 : 1
    const count = Math.min(capacity, entries.length)
    const stride = (width + GAP) / capacity
    const moving = entries.length > count
    const groups = moving ? Math.ceil(entries.length / count) : 0
    const group = Math.min(groups - 1, Math.floor(leading / Math.max(1, count)))
    const paused = opened !== null || hovered || focused || dragging || !visible || !pageVisible || reducedMotion
    const paint = useCallback((offset: number) => {
        const total = entries.length * stride
        const next = moving && total > 0 ? (offset % total + total) % total : 0
        position.current = next
        if (track.current) track.current.style.transform = `translate3d(${-next}px, 0, 0)`
        const cardPosition = next / stride
        setLeading(Math.floor(cardPosition))
        bars.current.forEach((bar, index) => {
            if (!bar) return
            const length = Math.min(count, entries.length - index * count)
            const fraction = Math.max(0, Math.min(1, (cardPosition - index * count) / length))
            bar.style.transform = `scaleX(${fraction})`
        })
    }, [entries.length, stride, moving, count])
    const previousStride = useRef(stride)
    useEffect(() => {
        const offset = position.current / previousStride.current * stride
        previousStride.current = stride
        paint(offset)
        setPreview(null)
    }, [stride, paint])
    useEffect(() => {
        const resize = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
        if (viewport.current) resize.observe(viewport.current)
        const intersection = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
        if (root.current) intersection.observe(root.current)
        const media = window.matchMedia('(prefers-reduced-motion: reduce)')
        const motion = () => setReducedMotion(media.matches)
        const visibility = () => setPageVisible(!document.hidden)
        motion()
        media.addEventListener('change', motion)
        document.addEventListener('visibilitychange', visibility)
        return () => { resize.disconnect(); intersection.disconnect(); media.removeEventListener('change', motion); document.removeEventListener('visibilitychange', visibility) }
    }, [entries.length])
    useEffect(() => {
        if (!moving || paused || !width) return
        let frame = 0, last = 0
        const step = (time: number) => {
            if (last) paint(position.current + Math.min(time - last, 64) / 1000 * SPEED)
            last = time
            frame = requestAnimationFrame(step)
        }
        frame = requestAnimationFrame(step)
        return () => cancelAnimationFrame(frame)
    }, [moving, paused, width, paint])
    useEffect(() => {
        if (!previewCards.current) return
        const resize = new ResizeObserver(([entry]) => setPreviewHeight(entry.contentRect.height * .5))
        resize.observe(previewCards.current)
        return () => resize.disconnect()
    }, [preview])
    if (!entries.length) return null
    const previewItems = preview === null ? [] : Array.from({length: count}, (_, index) => (preview * count + index) % entries.length)
    const rendered = moving ? [...entries, ...entries.slice(0, count + 1)] : entries
    const jump = (index: number) => paint(index * count * stride)
    const card = (entry: PinnedEntry, index: number, preview = false, copy = false) => entry.kind === 'article'
        ? <ArticleCard item={entry.article} categories={categories} avatar={avatar} name={name} tags={tags}
            featured onOpen={navigate} number={index % entries.length + 1} className="featuredCard" tabIndex={copy ? -1 : undefined} preview={preview}/>
        : <AnnouncementCard item={entry.announcement} number={index % entries.length + 1} preview={preview}
            tabIndex={copy ? -1 : undefined} onOpen={() => setOpened(entry.announcement)}/>

    return <section className="featuredArticles" ref={root} aria-label={tr("置顶")} data-paused={paused}
        onPointerEnter={event => {if (event.pointerType === 'mouse') setHovered(true)}}
        onPointerLeave={event => {if (event.pointerType === 'mouse') {setHovered(false); setPreview(null)}}}
        onFocusCapture={event => {
            setFocused((event.target as HTMLElement).matches(':focus-visible'))
            const slot = (event.target as HTMLElement).closest<HTMLElement>('[data-rail-index]')
            if (slot) {
                const index = Number(slot.dataset.railIndex)
                if (index > leading + count - 1 || index < leading) paint(index * stride)
            }
        }}
        onBlurCapture={event => {if (!event.currentTarget.contains(event.relatedTarget)) {setFocused(false); setPreview(null)}}}>
        <div className="featuredLabel"><SectionHeading icon="top">{tr("置顶")}</SectionHeading></div>
        <div className="featuredViewport" ref={viewport}
            onPointerDown={event => {
                swiped.current = false
                if (event.pointerType === 'touch' && moving) touch.current = {x: event.clientX, y: event.clientY, offset: position.current}
            }}
            onPointerMove={event => {
                const start = touch.current
                if (!start) return
                const dx = event.clientX - start.x, dy = event.clientY - start.y
                if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
                    swiped.current = true; setDragging(true)
                    event.currentTarget.setPointerCapture(event.pointerId)
                    paint(start.offset - dx)
                }
            }}
            onPointerUp={() => {touch.current = null; setDragging(false)}}
            onPointerCancel={() => {touch.current = null; setDragging(false)}}
            onClickCapture={event => {if (swiped.current && event.detail > 0) {event.preventDefault(); event.stopPropagation()}}}>
            <div className="featuredTrack" ref={track} style={{gap: GAP}}>
                {rendered.map((item, index) => {
                    const copy = index >= entries.length
                    const shown = index >= leading && index < leading + count + 1
                    return <div key={`${item.key}-${index}`} className="featuredSlide" data-rail-index={index}
                        aria-hidden={copy || !shown || undefined} ref={element => {
                            element?.toggleAttribute('inert', !shown)
                            // Loop copies stay clickable without duplicating keyboard navigation.
                            if (copy) element?.querySelectorAll<HTMLElement>('a,button,[tabindex]').forEach(control => {control.tabIndex = -1})
                        }}
                        style={{width: stride - GAP}}>
                        {card(item, index, false, copy)}
                    </div>
                })}
            </div>
        </div>
        {groups > 0 && <div className="featuredNavigation" onPointerLeave={event => {if (event.pointerType === 'mouse') setPreview(null)}}>
            {preview !== null && <div className="featuredPreview" aria-hidden="true"
                style={{left: `clamp(0px, calc(${(preview + .5) / groups * 100}% - ${count * 90 + 10}px), calc(100% - ${count * 180 + 20}px))`, width: count * 180 + 20}}>
                <div className="featuredPreviewWindow" style={{height: previewHeight}}><div className="featuredPreviewCards" ref={previewCards} style={{gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`}}>
                    {previewItems.map(index => <div key={entries[index].key}>{card(entries[index], index, true)}</div>)}
                </div></div>
            </div>}
            <div className="featuredSegments" role="group" aria-label={tr("置顶内容分组")}>
                {Array.from({length: groups}, (_, index) => {
                    const labels = Array.from({length: count}, (_, slot) => entries[(index * count + slot) % entries.length].title)
                    return <button type="button" key={index} aria-label={tr("第 {0} 组：{1}", {"0": index + 1, "1": labels.join('、')})}
                        aria-pressed={group === index} onPointerEnter={event => {if (event.pointerType === 'mouse') setPreview(index)}}
                        onFocus={event => {if (event.currentTarget.matches(':focus-visible')) setPreview(index)}} onClick={() => jump(index)}
                        onKeyDown={event => {
                            let next: number | undefined
                            if (event.key === 'ArrowRight') next = (index + 1) % groups
                            if (event.key === 'ArrowLeft') next = (index + groups - 1) % groups
                            if (event.key === 'Home') next = 0
                            if (event.key === 'End') next = groups - 1
                            if (event.key === 'Escape') setPreview(null)
                            if (next !== undefined) {event.preventDefault(); (event.currentTarget.parentElement!.children[next] as HTMLElement).focus()}
                        }}><span className="featuredSegment"><span ref={element => {bars.current[index] = element}}/></span></button>
                })}
            </div>
        </div>}
        <Modal open={opened !== null} onCancel={() => setOpened(null)}
            title={<span className="pinnedAnnouncementTitle">{opened?.title}</span>} footer={null} width={640}
            centered zIndex={Z.modal}
            styles={{content: {padding: 0}, header: {padding: '26px 48px 12px', marginBottom: 0}, body: {padding: 0}}}
            rootClassName={dark ? 'washiModal pinnedAnnouncementModal washiDark' : 'washiModal pinnedAnnouncementModal'}>
            {opened && <div className="pinnedAnnouncementBody" role="region" tabIndex={0} aria-label={tr("公告内容")}>
                <time className="pinnedAnnouncementTime">{announcementTime(opened.createdAt)}</time>
                <div className="pinnedAnnouncementText"><StickerText text={opened.content}/></div>
            </div>}
        </Modal>
    </section>
}

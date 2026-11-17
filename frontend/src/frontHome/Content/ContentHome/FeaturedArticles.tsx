import {useNavigate} from 'react-router-dom'
import SceneIcon from '../../../components/SceneIcon'
import ArticleCard from '../../../components/ArticleCard'
import {useCallback, useEffect, useRef, useState} from 'react'
import type {NoteType} from '../../../interface/NoteType'
import type {CategoriesType} from '../../../interface/CategoriesType'
import type {renderNoteTags} from '../../../apis/TagMethods'

interface Props {
    items: NoteType[]
    categories: CategoriesType[]
    avatar: string
    name: string
    tags: Parameters<typeof renderNoteTags>[1]
}
const GAP = 18
const SPEED = 18

export default function FeaturedArticles({items, categories, avatar, name, tags}: Props) {
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
    const [focused, setFocused] = useState(false)
    const [dragging, setDragging] = useState(false)
    const [visible, setVisible] = useState(false)
    const [pageVisible, setPageVisible] = useState(!document.hidden)
    const [reducedMotion, setReducedMotion] = useState(false)
    const capacity = width >= 960 ? 3 : width >= 620 ? 2 : 1
    const count = Math.min(capacity, items.length)
    const stride = (width + GAP) / capacity
    const moving = items.length > count
    const groups = moving ? Math.ceil(items.length / count) : 0
    const group = Math.min(groups - 1, Math.floor(leading / Math.max(1, count)))
    const paused = hovered || focused || dragging || !visible || !pageVisible || reducedMotion
    const paint = useCallback((offset: number) => {
        const total = items.length * stride
        const next = moving && total > 0 ? (offset % total + total) % total : 0
        position.current = next
        if (track.current) track.current.style.transform = `translate3d(${-next}px, 0, 0)`
        const cardPosition = next / stride
        setLeading(Math.floor(cardPosition))
        bars.current.forEach((bar, index) => {
            if (!bar) return
            const length = Math.min(count, items.length - index * count)
            const fraction = Math.max(0, Math.min(1, (cardPosition - index * count) / length))
            bar.style.transform = `scaleX(${fraction})`
        })
    }, [items.length, stride, moving, count])
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
    }, [items.length])
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
    if (!items.length) return null
    const previewItems = preview === null ? [] : Array.from({length: count}, (_, index) => (preview * count + index) % items.length)
    const rendered = moving ? [...items, ...items.slice(0, count + 1)] : items
    const jump = (index: number) => paint(index * count * stride)
    return <section className="featuredArticles" ref={root} aria-label="置顶文章" data-paused={paused}
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
        <div className="featuredLabel"><span className="featuredTape"><SceneIcon name="pin" size={15}/>置顶文章</span></div>
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
                    const copy = index >= items.length
                    const shown = index >= leading && index < leading + count + 1
                    return <div key={`${item.key}-${index}`} className="featuredSlide" data-rail-index={index}
                        aria-hidden={copy || !shown || undefined} ref={element => {
                            element?.toggleAttribute('inert', !shown)
                            // Loop copies stay clickable without duplicating keyboard navigation.
                            if (copy) element?.querySelectorAll<HTMLElement>('a,button,[tabindex]').forEach(control => {control.tabIndex = -1})
                        }}
                        style={{width: stride - GAP}}>
                        <ArticleCard item={item} categories={categories} avatar={avatar} name={name} tags={tags}
                            featured onOpen={navigate} number={index % items.length + 1} className="featuredCard" tabIndex={copy ? -1 : undefined}/>
                    </div>
                })}
            </div>
        </div>
        {groups > 0 && <div className="featuredNavigation" onPointerLeave={event => {if (event.pointerType === 'mouse') setPreview(null)}}>
            {preview !== null && <div className="featuredPreview" aria-hidden="true"
                style={{left: `clamp(0px, calc(${(preview + .5) / groups * 100}% - ${count * 90 + 10}px), calc(100% - ${count * 180 + 20}px))`, width: count * 180 + 20}}>
                <div className="featuredPreviewWindow"><div className="featuredPreviewCards" style={{gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`}}>
                    {previewItems.map(index => <ArticleCard key={items[index].key} item={items[index]} categories={categories}
                        avatar={avatar} name={name} tags={tags} featured number={index + 1} preview/>)}
                </div></div>
            </div>}
            <div className="featuredSegments" role="group" aria-label="置顶文章分组">
                {Array.from({length: groups}, (_, index) => {
                    const labels = Array.from({length: count}, (_, slot) => items[(index * count + slot) % items.length].noteTitle)
                    return <button type="button" key={index} aria-label={`第 ${index + 1} 组：${labels.join('、')}`}
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
    </section>
}

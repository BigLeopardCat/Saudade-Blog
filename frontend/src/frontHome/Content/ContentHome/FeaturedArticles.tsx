import {useEffect, useRef, useState} from 'react'
import {Link, useNavigate} from 'react-router-dom'
import type {NoteType} from '../../../interface/NoteType'
import type {CategoriesType} from '../../../interface/CategoriesType'
import NoteByline from '../../../components/NoteByline'
import AssetImage from '../../../components/AssetImage'
import {renderNoteTags} from '../../../apis/TagMethods'
import {carouselCropOf, coverCropStyle} from '../../../utils/coverCrop'

interface Props {
    items: NoteType[]
    categories: CategoriesType[]
    avatar: string
    name: string
    tags: Parameters<typeof renderNoteTags>[1]
}

export default function FeaturedArticles({items, categories, avatar, name, tags}: Props) {
    const [current, setCurrent] = useState(0)
    const [paused, setPaused] = useState(false)
    const [hovered, setHovered] = useState(false)
    const [focused, setFocused] = useState(false)
    const [visible, setVisible] = useState(false)
    const [reducedMotion, setReducedMotion] = useState(false)
    const root = useRef<HTMLElement>(null)
    const navigate = useNavigate()
    useEffect(() => { setCurrent(index => Math.min(index, Math.max(0, items.length - 1))) }, [items.length])
    useEffect(() => {
        const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
        if (root.current) observer.observe(root.current)
        const media = window.matchMedia('(prefers-reduced-motion: reduce)')
        const update = () => setReducedMotion(media.matches)
        update()
        media.addEventListener('change', update)
        return () => { observer.disconnect(); media.removeEventListener('change', update) }
    }, [])
    useEffect(() => {
        if (items.length < 2 || paused || hovered || focused || !visible || reducedMotion) return
        const timer = setInterval(() => setCurrent(index => (index + 1) % items.length), 5000)
        return () => clearInterval(timer)
    }, [items.length, paused, hovered, focused, visible, reducedMotion])
    const index = Math.min(current, items.length - 1)
    const item = items[index]
    if (!item) return null
    const category = categories.find(value => value.categoryKey === Number(item.noteCategory))
    return <section className="featuredArticles" ref={root} aria-label="置顶文章"
        onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}>
        <div className="featuredHeading">
            <span className="featuredLabel"><i className="iconfont icon-sticky1" aria-hidden="true"/>置顶文章</span>
            {items.length > 1 && <div className="featuredControls" role="group" aria-label="切换置顶文章">
                <span className="featuredCount" aria-live={focused ? 'polite' : 'off'}>{index + 1} / {items.length}</span>
                <button type="button" aria-label={paused ? '播放置顶轮播' : '暂停置顶轮播'}
                    aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? '▷' : 'Ⅱ'}</button>
                <button type="button" aria-label="上一篇置顶文章"
                    onClick={() => setCurrent((index - 1 + items.length) % items.length)}>‹</button>
                <button type="button" aria-label="下一篇置顶文章"
                    onClick={() => setCurrent((index + 1) % items.length)}>›</button>
            </div>}
        </div>
        <article className="featuredCard" onClick={event => {
            if (!(event.target as Element).closest('a,button')) navigate(`/article/${item.key}`)
        }}>
            <div className="featuredCover">
                <AssetImage src={item.cover} alt="" style={coverCropStyle(carouselCropOf(item))}/>
            </div>
            <div className="featuredContent">
                {category && <span className="featuredCategory">{category.categoryTitle}</span>}
                <h2><Link to={`/article/${item.key}`}>{item.noteTitle}</Link></h2>
                <p className="featuredDescription">{item.description}</p>
                <div className="featuredTags">{renderNoteTags(item.noteTags, tags, item.noteTagRefs)}</div>
                <div className="featuredByline"><NoteByline item={item} siteAvatar={avatar} siteName={name} compact/></div>
            </div>
        </article>
    </section>
}

import {Children, cloneElement, type ReactElement, useEffect, useRef, useState} from 'react'
import {LayoutGroup} from 'framer-motion'
import type {ArticleOption} from './Article'

/** Real grid reflow, with FLIP animation on cards rather than frame-by-frame layout writes. */
export default function ArticleGrid({children}: {children: ReactElement<ArticleOption>[]}) {
    const grid = useRef<HTMLDivElement>(null)
    const [active, setActive] = useState<string | null>(null)
    const [columns, setColumns] = useState(1)
    const cards = Children.toArray(children) as ReactElement<ArticleOption>[]
    const activeIndex = cards.findIndex(card => String(card.key) === active)
    useEffect(() => {
        const element = grid.current!
        let width = 0, frame = 0
        const resize = new ResizeObserver(([entry]) => {
            if (Math.abs(width - entry.contentRect.width) < 1) return
            width = entry.contentRect.width
            setActive(null)
            cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => {
                setColumns(getComputedStyle(element).gridTemplateColumns.split(' ').filter(value => value.endsWith('px')).length || 1)
            })
        })
        resize.observe(element)
        return () => { resize.disconnect(); cancelAnimationFrame(frame) }
    }, [])
    const tracks = activeIndex >= 0 && columns > 1
        ? Array.from({length: columns}, (_, index) => index === activeIndex % columns ? '1.2fr' : '1fr').join(' ')
        : undefined
    return <LayoutGroup><div className="allArticles" ref={grid} style={{gridTemplateColumns: tracks}}>
        {cards.map(card => {
            const key = String(card.key)
            return cloneElement(card, {expanded: active === key, layoutKey: active,
                onExpand: open => setActive(previous => open ? key : previous === key ? null : previous)})
        })}
    </div></LayoutGroup>
}

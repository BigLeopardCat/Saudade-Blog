import {useLayoutEffect, useMemo, useRef, useState} from 'react'
import {Tag} from 'antd'
import {renderNoteTags, renderNoteTagsCollapsed} from '../../apis/TagMethods'
import type {NoteTagRef} from '../../interface/NoteType'
import './index.css'

export default function ResponsiveNoteTags({ids, catalog, refs}: {
    ids: number[]; catalog: Parameters<typeof renderNoteTags>[1]; refs?: NoteTagRef[]
}) {
    const tags = useMemo(() => renderNoteTags(ids, catalog, refs), [ids, catalog, refs])
    const root = useRef<HTMLDivElement>(null)
    const measure = useRef<HTMLSpanElement>(null)
    const badge = useRef<HTMLSpanElement>(null)
    const [visible, setVisible] = useState(tags.length)
    useLayoutEffect(() => {
        const host = root.current!, row = measure.current!, more = badge.current!
        let alive = true
        const fit = () => {
            if (!alive) return
            const width = host.getBoundingClientRect().width
            if (width <= 0) return
            const widths = Array.from(row.children).slice(0, tags.length).map(el => el.getBoundingClientRect().width)
            const gap = parseFloat(getComputedStyle(row).columnGap) || 0
            let used = widths.reduce((sum, value) => sum + value, 0)
            if (used + gap * Math.max(0, widths.length - 1) <= width + .5) {setVisible(tags.length); return}
            for (let count = tags.length - 1; count >= 0; count--) {
                used -= widths[count]
                more.textContent = `+${tags.length - count}`
                if (used + gap * count + more.getBoundingClientRect().width <= width + .5) {setVisible(count); return}
            }
            setVisible(0)
        }
        const observer = new ResizeObserver(fit)
        observer.observe(host)
        fit()
        void document.fonts?.ready.then(fit)
        return () => {alive = false; observer.disconnect()}
    }, [tags])
    return <div className="responsiveNoteTags" ref={root}>
        <span className="tagFitVisible">{renderNoteTagsCollapsed(ids, catalog, Math.min(visible, tags.length), refs)}</span>
        <span className="tagFitMeasure" ref={measure} aria-hidden="true">{tags}<Tag ref={badge}>+0</Tag></span>
    </div>
}

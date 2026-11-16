import type {CSSProperties} from 'react'

const paths = {
    home: 'm3 10 9-7 9 7v10H15v-6H9v6H3Z',
    archive: 'M4 8h16v12H4ZM3 4h18v4H3ZM9 12h6',
    category: 'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
    message: 'M21 11a8 8 0 0 1-8 8H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4ZM7 8h10M7 12h6',
    book: 'M4 4h12v17H4ZM8 4v17M16 6h4v15h-4',
    leaf: 'M20 3C9 2 2 7 5 15s17 5 15-12ZM4 21 16 9',
    search: 'M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
    palette: 'M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h3a5 5 0 0 0 5-5c0-3-4-5-9-5ZM7 8h.01M11 6h.01M6 12h.01M16 7h.01',
    sun: 'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z',
    moon: 'M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z',
    menu: 'M4 6h16M4 12h16M4 18h16',
    close: 'm6 6 12 12M6 18 18 6',
    down: 'm6 9 6 6 6-6',
    pin: 'm9 3 6 0-1 6 4 4H6l4-4ZM12 13v8',
    mail: 'M3 5h18v14H3ZM3 5l9 8 9-8',
    video: 'M4 6h16v14H4ZM8 2l4 4 4-4M8 11v4M16 11v4',
    github: 'M9 20c-4 1-4-2-6-2M15 22v-4c0-1 .2-2-1-3 4 0 7-2 7-6 0-2-1-3-1-3s.5-2 0-4c-2 0-4 2-4 2a13 13 0 0 0-8 0S6 2 4 2c-.5 2 0 4 0 4S3 7 3 9c0 4 3 6 7 6-1 1-1 2-1 3v4',
} as const
export type SceneIconName = keyof typeof paths
export default function SceneIcon({name, size = 20, style}: {name: SceneIconName; size?: number; style?: CSSProperties}) {
    return <svg className="sceneIcon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={style}><path d={paths[name]}/></svg>
}

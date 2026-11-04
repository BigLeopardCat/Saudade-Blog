import type {NoteType} from "../interface/NoteType";

export interface StatCell {
    key: 'views' | 'likes' | 'favorites' | 'comments'
    /** 人读的标签，同时用作 `title`（悬停说明），不显示在卡片上 */
    label: string
    value: number
}

export const STAT_CELL_ORDER: ReadonlyArray<{ key: StatCell['key']; label: string }> = [
    { key: 'views', label: '阅读量' },
    { key: 'likes', label: '点赞数' },
    { key: 'favorites', label: '收藏数' },
    { key: 'comments', label: '讨论数' },
]

export function statCells(item: Partial<NoteType> | null | undefined): StatCell[] {
    if (!item) return []
    const cells: StatCell[] = []
    for (const { key, label } of STAT_CELL_ORDER) {
        const v = item[key]
        if (typeof v === 'number' && Number.isFinite(v)) cells.push({ key, label, value: v })
    }
    return cells
}

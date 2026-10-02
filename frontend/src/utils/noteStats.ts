import type {NoteType} from "../interface/NoteType";

/**
 * 卡片上"三个数该显示哪几个"的**唯一判据**（20260930）。
 *
 * 为什么单独抽成纯函数：这条判据的核心是「**读不到 ≠ 0**」——后端三条聚合查询可能只挂了
 * 一条（它失败只降级、不影响列表本体），此时那个键**根本不存在**。把 `undefined` 显示成 0
 * 就等于在统计出故障的那天让全站文章集体谎报"0 阅读"。
 *
 * 这条规则值得一个能被直接断言的函数，而不是散在 JSX 里的三个 `&&`：
 *   · `views/likes/favorites` 各自独立判断（一个缺席不影响另外两个）；
 *   · `0` 是**事实**，照常显示；`undefined`/`null`/`NaN` 是**没有这个数**，不显示；
 *   · 三个都没有 ⇒ 返回空数组，调用方整个容器不渲染（父级是 flex，空 div 也会吃掉 gap）。
 *
 * 契约：只认数字（`typeof === 'number'` 且有限）。字符串 `"0"` 这种脏值也当"没有"——
 * 接口若哪天改了类型，宁可少显示一个数，也不要显示一个错的。
 */
export interface StatCell {
    key: 'views' | 'likes' | 'favorites' | 'comments'
    /** 人读的标签，同时用作 `title`（悬停说明），不显示在卡片上 */
    label: string
    value: number
}

/** 按固定顺序（阅读 → 点赞 → 收藏 → 讨论）给出该显示的几个数，顺序写死 = 卡片上
 *  几个数的次序恒定。**新加的一律排在末尾**：改这个数组会让站上每一张卡片的数换位置。
 *  ⚠️ 详情页那一列是另一套次序（收藏/浏览/点赞/讨论，20260926 起就在那儿），两处**没有**
 *  对齐过、也不由本文件决定——别拿这个数组去推详情页的 DOM 顺序。 */
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

/** 四类内容。与后端 `SearchHit::kind` 逐字同名（`search_core` 侧的 `counts` 也用这套键）。 */
export type SearchType = 'note' | 'talk' | 'board' | 'comment'

export interface AggregateHit {
    type: SearchType
    /** 该类型内的主键：文章 id / 说说 id / 留言 id / 评论 id */
    key: number
    /** 行首标题（留言恒为空串、评论是它所属文章的标题） */
    title: string
    snippet: string
    author: string
    /** 只有评论有：所属文章 id */
    noteId: number | null
    createTime: string
}

export type AggregateTarget = Pick<AggregateHit, 'type' | 'key' | 'noteId'>

export interface AggregateResult {
    total: number
    page?: number
    pageSize?: number
    hasMore?: boolean
    terms?: string[]
    counts: Record<SearchType, number>
    notes: AggregateHit[]
    talks: AggregateHit[]
    board: AggregateHit[]
    comments: AggregateHit[]
}

/** 固定顺序：标题栏上四枚计数的顺序，也是"全部"时结果的分组顺序。
 *  与后端返回体的字段序一致，**不按命中数排**——计数栏的位置每次搜索都换地方的话，
 *  用户就没法"闭着眼点第二枚"了。 */
export const TYPE_ORDER: SearchType[] = ['note', 'talk', 'board', 'comment']

export const TYPE_LABEL: Record<SearchType, string> = {
    note: '文章',
    talk: '说说',
    board: '留言',
    comment: '评论',
}

/** 某一类的结果。字段名不统一（`board` / `comments` 是复数），映射只留在这里一处。 */
export function hitsOf(r: AggregateResult, t: SearchType): AggregateHit[] {
    switch (t) {
        case 'note': return r.notes || []
        case 'talk': return r.talks || []
        case 'board': return r.board || []
        case 'comment': return r.comments || []
    }
}

/** 四类全要，按 `TYPE_ORDER` 的顺序拼成一条列表（同类相邻）。 */
export function allHits(r: AggregateResult): AggregateHit[] {
    return TYPE_ORDER.flatMap((t) => hitsOf(r, t))
}

/** 各类型映射到文章、说说或留言板深链；使用绝对路径，避免依赖当前页面层级。 */
export function hitTarget(h: AggregateTarget): string {
    switch (h.type) {
        case 'note': return `/article/${h.key}`
        case 'talk': return `/talk?tk=${h.key}`
        case 'board': return `/guestbook?lid=${h.key}`
        case 'comment':
            // 评论自己没有页面：落到**它挂的那篇文章**上，用 `?cid=` 让评论区定位到这一条。
            // `noteId` 理论上必有（后端给了），但真要是漏了，宁可回首页也不要拼出
            // `/article/null?cid=41` 这种必 404 的地址。
            return h.noteId ? `/article/${h.noteId}?cid=${h.key}` : '/'
    }
}

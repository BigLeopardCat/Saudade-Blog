/** 站内聚合搜索结果的**纯模型**（20261006）：类型、标签、筛选、跳转目标。
 *
 *  为什么单开一个模块而不是写在 `Head/index.tsx` 里：这几条规则里最要紧的一条是
 *  `hitTarget`——它是"点了一条结果能不能到那一条上"的**唯一出处**，四类各行一条路径，
 *  写错一条就是一类内容点了没反应（或者跳到别的地方去）。抽成纯模块才能被测试直接打包
 *  跑一遍（同 `wordgraph` 那类做法），而不是靠读源码字符串猜。
 *
 *  本模块**不依赖 React**，也不碰网络。
 */

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

export interface AggregateResult {
    total: number
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

/** 一条结果该跳到哪去。**四类四条路径**，每条都对应一个真实存在的落地页：
 *
 *  | type    | 目标                              | 落地 |
 *  |---------|-----------------------------------|------|
 *  | note    | `/article/<id>`                   | 文章详情 |
 *  | talk    | `/talk?tk=<id>`                   | 说说列表定位到那一条 |
 *  | board   | `/guestbook?lid=<id>`             | 留言板定位到那盏灯 |
 *  | comment | `/article/<noteId>?cid=<评论 id>` | 文章详情 + 评论区定位到那条 |
 *
 *  ⚠️ **一律绝对路径**（以 `/` 开头）：`navigate('article/5')` 这种相对写法在
 *  `/article/3` 这类页面上会拼成 `/article/article/5`——首页搜索框在每一页都在，
 *  不能假定当前路径只有一段。
 */
export function hitTarget(h: AggregateHit): string {
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

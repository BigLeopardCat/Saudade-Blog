/**
 * 「这篇文章在站上公开可见吗」的**唯一判据**（20261006）。
 *
 * 现场（用户原话）：「博客 dashboard/notes 的全部文章页标签前加个公开文章。」
 * 后台「全部文章」这个页签里公开/私密/草稿混在一起，而判"公开"的字段一直没在前端露过面
 * （`work_info`/`NoteType` 里都没有它），于是一眼看不出哪几篇是线上真能读到的。
 *
 * ## 判据为什么是 `is_public && status != 'draft'`，而不是 `status === 'public'`
 *
 * 两条独立的字段，历史上是两套东西：`status` 是编辑器的"发布/私密/草稿"三态，
 * `is_public` 是另一列布尔。全站的公开可见口径是**两个都要看**，而且这句话在 Rust 侧
 * 已经写了四遍（逐字同源）：
 *   · `src/routes/profile.rs`   `visible_note`：`n.is_public && n.status.as_deref() != Some("draft")`
 *   · `src/routes/tags.rs`      公开标签口径注释："与 `list_public_notes` 逐字一致"
 *   · `src/routes/comments.rs`  公开讨论区口径
 *   · `src/routes/note_stats.rs`（卡片上四个数的口径）
 *
 * 反过来只认 `status === 'public'` 会**漏标**：`status` 列可空，老数据是 NULL，
 * 后端 `map_note` 把它兜成 `'published'`（`src/routes/notes.rs`）——那正是后台
 * 「文章状态」列对老数据显示"未知状态"的同一个成因。而"未知状态"的文章在站上
 * 大概率是公开可读的（它们比 `status` 这个字段更老），按 status 判就是把它们全漏掉。
 *
 * ## 为什么抽成纯函数
 *
 * 消费方现在只有后台列表一处，但它判的是**跨语言契约**：前端说"公开"、站上却说"看不到"
 * （或反过来）是这类判据最典型的漂移。抽出来之后 `frontend/tests/note-visibility.test.mjs`
 * 能在纯函数层钉住真值表，并顺带读一遍 `profile.rs`——Rust 那句判据被改写时套件立刻红，
 * 而不是等到某篇文章在卡片上公开、在后台被标成私密。
 *
 * 缺键一律算**不公开**（`is_public` 缺席 = 这一路没带这个字段，不是"没有就不是私密"）：
 * 少标一颗绿标是可见的、可追问的；把一篇私密文章标成公开则是把错信息递给管理员。
 */
export interface NoteVisibilityFields {
    /** 后端 `NoteDto.is_public`（**唯一一个没有 serde rename 的字段**，JSON 键就是下划线形态） */
    is_public?: boolean | number | null
    /** 后端 `NoteDto.status`：`public`/`private`/`draft`，老数据是兜底出来的 `published` */
    status?: string | null
}

/**
 * 这篇文章在站上公开可见吗（= 后台列表里该不该带「公开文章」那颗标）。
 *
 * 接口原始行与 `NoteType` 都能直接传（两者的键名一致，见上面 `NoteVisibilityFields`）。
 */
export function isPubliclyVisible(note?: NoteVisibilityFields | null): boolean {
    // `true` 与 `1` 都算：后端是 bool，但同一个字段走过 `search_all_notes` 那条
    // 原始行路径时也可能拿到 1（与 `isTop` 同款的历史形态），两种都认。
    const published = note?.is_public === true || note?.is_public === 1
    return published && note?.status !== 'draft'
}

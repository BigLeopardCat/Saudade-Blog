/**
 * 文章讨论区（20261002）。挂在 `frontHome/Content/ReadArticle` 的正文之后。
 *
 * ## 两件事必须先读
 *
 * **① XSS：渲染只走 `renderBlogMarkdown`，没有第二份 sanitizer。**
 * 评论正文在库里是**不转义存储**的（服务端只校验形状：trim、长度、剥控制字符，
 * 见 `src/routes/comments.rs::clean_content`）。防线在渲染侧，就是文章页 bytemd
 * `<Viewer>`、看板娘对话框共用的那一条 unified 管线：
 * `remark-parse → gfm/breaks/gemoji/math → remarkStickers → rehype-raw →
 * rehype-sanitize(默认 schema + className)`。于是 `<script>` / `<img onerror>`
 * 在这一步被剥掉，而表情包、换行、代码块、gemoji 全部免费拿到。
 *
 * 由此两条硬纪律：
 *   · `dangerouslySetInnerHTML` 的 `__html` **只允许**是 `renderBlogMarkdown()` 的产物
 *     （本文件里唯一一处，见 `CommentBody`）。**输入框下方那个预览（`.commentPreview`）
 *     复用的也正是 `CommentBody`**——预览必须与已发布逐字相同，另写一份就是第二份真相；
 *   · **任何地方都不许对评论原文直接 `innerHTML`**，也不许在这里另写一份 escapeHtml。
 *     自己拼一份"安全 HTML"就是把同一条链路的第二个实现引进来——两处必然会漂。
 *
 * **② 两层结构：回复的回复挂在同一个顶层下，服务端已经保证，前端不"假装缩进"。**
 * 一条评论的 `rootId` 为 null 即顶层；其余的 `rootId` 指向它所属的顶层——
 * 这是服务端从父行派生的（客户端只传 `parentId`，见 `create_comment`），
 * 所以对一条回复的回复，`rootId` 仍是那条顶层。这里只按 `rootId` 分组，
 * 缩进层级天然只有两层，与数据一致（不是靠 CSS 假装出来的）。
 *
 * **③ 昵称后面跟的是作者的 `UID`，不是评论 id**（主人 20261003 点名）。原先那里写的是
 * `#C<评论 id>`，主人要的是"这条是谁发的"——即 `userId`（留言板 `talk.id` 与评论 `id`
 * 是两个命名空间，拿评论 id 出来对人没有任何用）。评论 id 仍然在 `data-cid` 上，
 * 深链 `?cid=` 与定位高亮照旧按它走。
 *
 * **④ 回复框就地展开，顶层那个输入框只发顶层评论**（用户 20261003 第 3 条）。
 * 原话：「讨论区回复的时候，如果评论很靠下，每次回复都要滚到顶部输入框才能回复好麻烦」。
 * 根因不是"没滚动"，而是**回复框根本只有顶部那一个**：点某行的「回复」只是把 `replyTo`
 * 设上，框还在页面顶端——于是他要么往回滚，要么压根没发现自己点中了（症状 = "点了没反应"）。
 *
 * 现在的形态：点「回复」→ **那一行自己的 `.commentMain` 里**展开一个输入框（`.isInline`
 * 修饰符），焦点落进去、`scrollIntoView({block:'nearest'})` 只在需要时滚最小距离。
 * 读到哪里就在哪里回，视线不离开那行。
 *
 * 由此两条纪律：
 *   · **顶层框不再有"正在回复 @xx"那条**（`.commentReplyBar` 现在只出现在行内框里）。
 *     留一条通往顶部的回复路径 = 那个坑原样还在，只是多了一个更好的入口；
 *   · **行内框按「哪一行」而不是「哪一条」开**：`openFor` 存的是评论 id，同时最多一个
 *     展开（换一行就把上一个收起），所以行内那份 state 是**单份**的，不是一行的副本。
 *
 * **⑤ 点赞 / 踩（用户 20261003 第 4 条）**：「访客也能点，**不改排序**」是拍板过的形态——
 * 讨论区仍是时间序（按票数排会让一条新评论永远沉底，而这是讨论区不是热榜）。
 * 三条纪律：
 *   · **高亮看 `myVote`，数字看 `up`/`down`**。把高亮挂在"票多的那一侧"上，
 *     读者会以为是自己投的（同族错法：首页点赞的心形）；
 *   · **乐观更新，失败回滚**。等一个来回再变色，手感就是"没点上"；但乐观值只是
 *     占位，服务端回执（它才看得见别人的票）一到就**整组覆盖**；
 *   · **数字为 0 不显示**（只留图标）——一排 `👍 0  👎 0` 是噪声，而"没人投过"这件事
 *     本来就是空的。**踩在赞右边**：与多数站点一致，也让"先看总赞数"这条阅读习惯成立。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Input, Modal, message } from 'antd'
// 光标插入表情要拿到真正的 <textarea>：antd 的 TextArea 包了一层自动高度容器，
// 引用类型自带 `resizableTextArea.textArea`（不要用 as 硬转，那层结构改名后会静默失效）
import type { TextAreaRef } from 'antd/es/input/TextArea'
import type { CommentItem, CommentVote } from '../../interface/CommentType'
import { createComment, deleteMyComment, listComments, voteComment } from '../../apis/CommentMethods'
import { errMsg, ok } from '../../apis/ProfileMethods'
import { renderBlogMarkdown } from '../../utils/chatMarkdown'
import { resolveApiAssetUrl } from '../../utils/runtimeApi'
import { DEFAULT_AVATAR_URL } from '../UserCenter/identity'
import RoleBadge from '../RoleBadge'
import StickerPicker from './StickerPicker'
import getToken from '../../apis/getToken'
import { useLiveRefresh } from '../../utils/liveRefresh'
import './index.sass'

/** 与后端 `src/routes/comments.rs::MAX_COMMENT_CHARS` **必须相等**：
 *  前端拦是为了给即时反馈，服务端那道才是真的（`contract-comment.test.mjs` 锁住两者一致）。
 *  计数用 `value.length`（UTF-16 单元）：它与 `maxLength` 同一口径，
 *  且对 emoji 只会**更严**（一个 emoji 算 2）——永远不会放行一条服务端要拒的。 */
const MAX_COMMENT_CHARS = 300

/** 一条评论的正文。**整个文件里唯一一处 `dangerouslySetInnerHTML`**（见文件头注 ①）。 */
const CommentBody = ({ content }: { content: string }) => {
    const html = useMemo(() => renderBlogMarkdown(content), [content])
    return (
        <div
            className="commentBody markdown-body"
            dangerouslySetInnerHTML={{ __html: html }}
        />
    )
}

/** 乐观推进一条评论的票：给定"现在这三个数"与"这次要投成什么"，算出点完之后的三个数。
 *
 *  **纯函数**（不碰 state），因为这里的顺序最容易写反：**先撤旧票、再落新票**。
 *  反过来（先落新票再撤旧）在"赞→踩"时会多出一个 down，而且**只在改主意那一种点击上错**
 *  ——随手连点两下赞是看不出来的，等有人截图说"我只踩了一下显示 2"时才开始查。
 *  撤的时候各自减自己那一侧（不可能减成负数：撤的正是自己上次加的那一票）。 */
const optimisticVote = (v: CommentVote, next: -1 | 0 | 1): CommentVote => {
    let up = v.up
    let down = v.down
    if (v.myVote === 1) up -= 1
    else if (v.myVote === -1) down -= 1
    if (next === 1) up += 1
    else if (next === -1) down += 1
    return { up, down, myVote: next }
}

interface CommentSectionProps {
    /** 文章 id（路由参数，未解析出来时别发请求） */
    noteId?: string | number
}

const CommentSection = ({ noteId }: CommentSectionProps) => {
    const [items, setItems] = useState<CommentItem[] | null>(null)
    const [failed, setFailed] = useState(false)
    const [content, setContent] = useState('')
    const [busy, setBusy] = useState(false)
    /** 行内回复框：**开在哪一行**（评论 id；null = 没开）。同时最多一个。
     *  与 `content` 分开存，是为了收起再展开时**顶层草稿不被冲掉**（见文件头注 ④）。 */
    const [openFor, setOpenFor] = useState<number | null>(null)
    const [replyContent, setReplyContent] = useState('')
    const [replyBusy, setReplyBusy] = useState(false)
    /** 「预览」开关（20261003）。**不是可选项**：评论区整段按 markdown 渲染，而站上多数人
     *  并不认识 markdown——`_下划线_` 会被吃成斜体、`2*3*4` 会变成 `2<em>3</em>4`、行首
     *  `#`/`>`/`- ` 会变成标题/引用/列表。写的人看不见这件事，读的人才看得见（那时已经发出去了）。
     *  预览就是把"读的人看到的样子"提前搬到写的人眼前，**用的是同一条渲染路径**（`CommentBody`）。 */
    const [preview, setPreview] = useState(false)
    const [pendingDelete, setPendingDelete] = useState<CommentItem | null>(null)
    const [deleting, setDeleting] = useState(false)
    const taRef = useRef<TextAreaRef>(null)
    const replyTaRef = useRef<TextAreaRef>(null)
    /** 已经定位过的 cid（**记的是值不是布尔**：同页再点另一条通知时要能重新定位） */
    const locatedRef = useRef<number | null>(null)
    const [searchParams] = useSearchParams()
    /** 通知深链 `/article/<id>?cid=<评论 id>` 里的那条评论 id。0 = 没有 */
    const cid = Number(searchParams.get('cid')) || 0

    const loggedIn = !!getToken()
    const key = noteId === undefined || noteId === null || noteId === '' ? '' : String(noteId)

    /** 拉公开列表。**读失败不清空**（沿用 `favorites.ts` 那条纪律：读不到 ≠ 没有）——
     *  一次网络抖动把整个讨论区变成"还没有人评论"是更坏的结果。 */
    const load = useCallback(async () => {
        if (!key) return
        try {
            const res = await listComments(key)
            if (!ok(res)) { setFailed(true); return }
            setItems(res.data.data || [])
            setFailed(false)
        } catch (e) {
            console.error('读取评论失败', e)
            setFailed(true)
        }
    }, [key])

    useEffect(() => { setItems(null); setFailed(false); void load() }, [load])

    // 别人/另一个端写的新评论：聚焦或看板娘写完一轮时补一次。
    // **poll: false**——这是访客页面，不为我自己的编辑给访客加轮询流量（见 liveRefresh 头注）。
    useLiveRefresh(load, { poll: false })

    const { tops, repliesByRoot } = useMemo(() => {
        const byRoot = new Map<number, CommentItem[]>()
        const rootList: CommentItem[] = []
        for (const c of items || []) {
            if (c.rootId === null) { rootList.push(c); continue }
            const arr = byRoot.get(c.rootId)
            if (arr) arr.push(c)
            else byRoot.set(c.rootId, [c])
        }
        return { tops: rootList, repliesByRoot: byRoot }
    }, [items])

    /* 深链定位（`?cid=`）：评论列表到位后滚到那一条并加高亮类。
     *
     * · **必须等 `items` 到位**——那一行是渲染出来的，DOM 里还没有就 `getElementById` 不到。
     *   指向的评论**必然已公开**（通知只在评论已放行时发，见后端 `notify_comment_reply`），
     *   所以"列表里没有它"只可能是它已经被删/被驳回，此时**安静兜底**：页面本身已经打开在
     *   这篇文章上，再弹一句"没找到这条评论"只会添乱（同 RiverBoard「定不到就安静兜底回页面」）。
     * · **瞬时滚动 + double-rAF 重放**，不用 `behavior: 'smooth'`：本页挂载时会
     *   `scrollToTop()`，而那是**平滑**滚动（`utils/scrollToTop.tsx`）——评论列表回来时它
     *   可能还在动画里，随后的平滑定位会被顶掉或与之互相拉扯，症状就是"点通知进来停在
     *   页面顶部"。瞬时滚动会取消在途的平滑动画，double-rAF 再补一次压过同帧的其它滚动
     *   （同族取证见聊天记录命中定位那一轮）。
     * · **不写 cleanup**：摘掉高亮由那个 1.8s 定时器负责，而 `items` 每次后台刷新都会让本
     *   effect 重跑一次——若把"摘类"放进 cleanup，一次静默刷新就会把还没闪完的高亮掐掉。
     */
    useEffect(() => {
        if (!cid || !items || locatedRef.current === cid) return
        const el = document.getElementById(`c-${cid}`)
        if (!el) return
        locatedRef.current = cid
        const jump = () => el.scrollIntoView({ block: 'center', behavior: 'auto' })
        requestAnimationFrame(() => {
            jump()
            requestAnimationFrame(jump)
        })
        el.classList.add('comment-hit')
        window.setTimeout(() => el.classList.remove('comment-hit'), 1800)
    }, [cid, items])

    /** 把 `:名字:` 插到光标处（不是追加到末尾——插完把光标挪到表情之后继续打字）。
     *  **顶层框与行内回复框共用这一份**：草稿值由调用方给，函数只负责切/插/回光标。 */
    const insertSticker = (
        el: HTMLTextAreaElement | null | undefined,
        value: string,
        setValue: (v: string) => void,
        name: string,
    ) => {
        const token = `:${name}:`
        if (!el) { setValue(value + token); return }
        const start = el.selectionStart ?? value.length
        const end = el.selectionEnd ?? start
        setValue(value.slice(0, start) + token + value.slice(end))
        requestAnimationFrame(() => {
            el.focus()
            const at = start + token.length
            el.setSelectionRange(at, at)
        })
    }

    const pickSticker = (name: string) =>
        insertSticker(taRef.current?.resizableTextArea?.textArea, content, setContent, name)
    const pickReplySticker = (name: string) =>
        insertSticker(replyTaRef.current?.resizableTextArea?.textArea, replyContent, setReplyContent, name)

    /** 发表之后那一段：**审核三态文案只有这一处实现**（顶层框与行内回复共用）。
     *  返回是否成功，由调用方决定清不清草稿。三种审核结果说三种话——
     *  **不把"待审"说成"已发布"**（这也正是接口要回 `approved` 的原因）。 */
    const postComment = async (text: string, parentId: number | null) => {
        const res = await createComment(key, text, parentId)
        if (!ok(res)) { message.error(errMsg(res)); return false }
        const { approved } = res.data.data
        await load()
        if (approved === 1) message.success('评论已发布')
        else if (approved === 0) message.info('评论已提交，通过人工复核后才会公开显示')
        else message.warning('评论未通过审核，不会公开展示')
        return true
    }

    const submit = async () => {
        const text = content.trim()
        if (!loggedIn) { message.warning('请先登录后再参与讨论'); return }
        if (!text) { message.warning('评论不能为空'); return }
        if (content.length > MAX_COMMENT_CHARS) {
            message.warning(`评论过长（最多 ${MAX_COMMENT_CHARS} 字）`)
            return
        }
        setBusy(true)
        try {
            // 顶层框只发顶层评论——回复一律走行内那个框（见文件头注 ④）
            if (await postComment(text, null)) setContent('')
        } catch (e) {
            console.error('发表评论失败', e)
            message.error('发表失败，请稍后再试')
        } finally {
            setBusy(false)
        }
    }

    /** 展开某一行的回复框，并把焦点与视线都留在那一行（用户 20261003 第 3 条）。 */
    const openReply = (comment: CommentItem) => {
        setOpenFor(comment.id)
        setReplyContent('')
        // 焦点必须等下一帧：这一帧行内框还没渲染出来，ref 还是 null。
        requestAnimationFrame(() => {
            const el = replyTaRef.current?.resizableTextArea?.textArea
            if (!el) return
            el.focus()
            // `block:'nearest'`：**只在真的看不见时才滚，且只滚最小距离**。
            // 这条是整件事的要点——回复靠下的评论时，视线不该被甩回页面顶部。
            el.closest('.commentRow')?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
        })
    }

    const closeReply = () => { setOpenFor(null); setReplyContent('') }

    const submitReply = async () => {
        const parentId = openFor
        if (parentId === null) return
        const text = replyContent.trim()
        if (!loggedIn) { message.warning('请先登录后再参与讨论'); return }
        if (!text) { message.warning('回复不能为空'); return }
        if (replyContent.length > MAX_COMMENT_CHARS) {
            message.warning(`回复过长（最多 ${MAX_COMMENT_CHARS} 字）`)
            return
        }
        setReplyBusy(true)
        try {
            if (await postComment(text, parentId)) closeReply()
        } catch (e) {
            console.error('发表回复失败', e)
            message.error('回复失败，请稍后再试')
        } finally {
            setReplyBusy(false)
        }
    }

    const doDelete = async () => {
        if (!pendingDelete) return
        setDeleting(true)
        try {
            const res = await deleteMyComment(pendingDelete.id)
            if (!ok(res)) { message.error(errMsg(res)); return }
            message.success('评论已删除')
            setPendingDelete(null)
            await load()
        } catch (e) {
            console.error('删除评论失败', e)
            message.error('删除失败，请稍后再试')
        } finally {
            setDeleting(false)
        }
    }

    /** 正在投票的评论 id。**用 Set 而不是单个 id**：他可能连着点不同评论的票，
     *  为一条 in-flight 就把整个讨论区锁住没必要。它只用来挡住**同一条**的重复提交
     *  （连点两下不该发出两个相反方向的请求，那会让结果取决于谁先回来）。 */
    const [votingIds, setVotingIds] = useState<Set<number>>(new Set())

    /** 就地改掉某一条的三个数。**乐观更新与回滚共用这一处**——
     *  写两份"怎么改"就是给回滚留了一条与更新不一致的路。 */
    const applyVote = (id: number, v: CommentVote) =>
        setItems((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, ...v } : c)) : prev))

    /** 点「赞」/「踩」。**再点自己已经点亮的那一侧 = 撤回**（`value: 0`，
     *  与后端同一语义，见 `apis/CommentMethods.tsx::voteComment`）。 */
    const vote = async (c: CommentItem, dir: 1 | -1) => {
        if (votingIds.has(c.id)) return
        const next: -1 | 0 | 1 = c.myVote === dir ? 0 : dir
        // 回滚用的快照。**取的是这次渲染看到的那一份**：若后台恰好在这几十毫秒里
        // 刷新了列表，回滚会写回一个略旧的数——这比"失败后什么都不回滚、留着一个
        // 假的乐观值"好得多，下一次 `useLiveRefresh` 也会把它拉回真值。
        const before: CommentVote = { up: c.up, down: c.down, myVote: c.myVote }
        setVotingIds((s) => new Set(s).add(c.id))
        applyVote(c.id, optimisticVote(before, next))
        try {
            const res = await voteComment(c.id, next)
            if (!ok(res)) {
                applyVote(c.id, before)
                message.error(errMsg(res))
                return
            }
            // 服务端回执是**事实**（别人这一秒投的票也在里面）⇒ 覆盖掉本地那笔乐观账。
            // 别在这里"只改我这一票"：本地算出来的数与服务端可能差着别人的票。
            applyVote(c.id, res.data.data)
        } catch (e) {
            console.error('评论投票失败', e)
            applyVote(c.id, before)
            message.error('操作失败，请稍后再试')
        } finally {
            setVotingIds((s) => {
                const n = new Set(s)
                n.delete(c.id)
                return n
            })
        }
    }

    const renderRow = (c: CommentItem, isReply: boolean) => (
        <div
            key={c.id}
            id={`c-${c.id}`}
            data-cid={c.id}
            className={`commentRow${isReply ? ' isReply' : ''}${c.mine ? ' isMine' : ''}`}
        >
            <img
                className="commentAvatar"
                src={resolveApiAssetUrl(c.avatar || '') || DEFAULT_AVATAR_URL}
                alt=""
            />
            <div className="commentMain">
                <div className="commentMeta">
                    {/* 身份行：昵称 + 徽章 + UID + 时间。**顺序 = 阅读顺序**，别往这行里
                        塞别的东西 —— 20261003 用户第 3 条报的正是「回复 @xx 直接把头像和
                        昵称隔断了」：当年「回复 @某人」挂在这一行的**行首**，它左边就是
                        头像 ⇒ 头像与昵称之间插着一句「回复 @…」。它现在另起一行，见下。 */}
                    <span className="commentName">{c.nickname}</span>
                    <RoleBadge role={c.role} size={20} />
                    {/* 作者 uid：极小一号、淡一档——它是"这条是谁发的"的身份锚，
                        不该抢昵称的视线。**别再退回评论 id**：那是另一个命名空间，
                        对人没有意义（深链定位仍走本行外层那个 data-cid）。 */}
                    <span className="commentUid">UID:{c.userId}</span>
                    <span className="commentTime">{c.createdAt}</span>
                </div>
                {/* 「回复 @某人」**另起一行**，紧贴正文（20261003 用户第 3 条：「另起一行
                    回复 @xxx」）。只有回复才有（顶层的 replyToUid 恒 null）。
                    它是块级元素、住在 `.commentMeta` 与 `<CommentBody>` 之间 ⇒ 读法是
                    「谁 → 回复谁 → 正文」，头像一个都不隔断。 */}
                {isReply && (
                    <div className="commentReplyTo">
                        回复 @{c.replyToNickname || '已注销用户'}
                    </div>
                )}
                <CommentBody content={c.content} />
                <div className="commentActions">
                    <button type="button" onClick={() => openReply(c)}>回复</button>
                    {/* 赞 / 踩（文件头注 ⑤）。位置：**「回复」之后、「删除」之前**——
                        回复是讨论区的主要动作（行内回复框就开在它底下），删除是破坏性的、
                        照旧排最后。`aria-pressed` 读的是 `myVote`（我投的），不是票多的那一侧。 */}
                    {([1, -1] as const).map((dir) => {
                        const on = c.myVote === dir
                        const n = dir === 1 ? c.up : c.down
                        return (
                            <button
                                key={dir}
                                type="button"
                                className={`commentVote${on ? ' isOn' : ''}`}
                                aria-pressed={on}
                                aria-label={dir === 1 ? '赞' : '踩'}
                                disabled={votingIds.has(c.id)}
                                onClick={() => void vote(c, dir)}
                            >
                                <span className="commentVoteIcon" aria-hidden="true">
                                    {dir === 1 ? '👍' : '👎'}
                                </span>
                                {/* 0 不显示（文件头注 ⑤）：一排 `👍 0 👎 0` 只是噪声。
                                    为 0 时按钮宽度靠图标撑着，位置不跳（见 index.sass 的 padding 抵消）。 */}
                                {n > 0 && <span className="commentVoteNum">{n}</span>}
                            </button>
                        )
                    })}
                    {c.mine && (
                        <button type="button" className="isDanger" onClick={() => setPendingDelete(c)}>
                            删除
                        </button>
                    )}
                </div>
                {/* 行内回复框：**住在这行的 `.commentMain` 里**，就在刚点的那颗「回复」
                    底下（见文件头注 ④）。样式整个复用 `.commentComposer`（`.isInline`
                    只是几条覆盖），所以计数按进框内、按钮字号那几条修复它一并吃到。
                    **不带预览按钮**：这里回的是别人已经写出来的一句话，写的人不用先
                    猜 markdown 会把它吃成什么样。 */}
                {openFor === c.id && (
                    <div className="commentComposer isInline">
                        <div className="commentReplyBar">
                            <span>正在回复 @{c.nickname}</span>
                            <button type="button" onClick={closeReply}>取消</button>
                        </div>
                        <Input.TextArea
                            ref={replyTaRef}
                            value={replyContent}
                            onChange={(e) => setReplyContent(e.target.value)}
                            placeholder={`回复 @${c.nickname}…`}
                            autoSize={{ minRows: 2, maxRows: 6 }}
                            maxLength={MAX_COMMENT_CHARS}
                            showCount
                            // Esc 收起（与表情面板同一个键意）
                            onKeyDown={(e) => { if (e.key === 'Escape') closeReply() }}
                        />
                        <div className="commentComposerFoot">
                            <div className="commentComposerTools">
                                <StickerPicker onPick={pickReplySticker} disabled={replyBusy} />
                            </div>
                            <button
                                type="button"
                                className="commentSubmit"
                                disabled={replyBusy || !replyContent.trim()}
                                onClick={submitReply}
                            >
                                {replyBusy ? '发送中…' : '回复'}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )

    return (
        <div className="commentSection" id="comments">
            <h3 className="commentTitle">
                讨论区
                {items && <span className="commentCount">{items.length} 条</span>}
            </h3>

            {!loggedIn ? (
                <p className="commentLoginTip">
                    <a href="/login">登录</a> 后即可参与讨论
                </p>
            ) : (
                <div className="commentComposer">
                    {/* **这里没有"正在回复 @xx"那条**：回复一律在那一行就地展开
                        （文件头注 ④）。留一条通往顶部的回复路径 = 那个坑原样还在。 */}
                    {/* **计数已搬进输入框内**（20261003 用户第 3 条），所以这里不再挂全站的
                        `counter-room`（那 22px 是给"计数吊在框下方"腾的地方，也正是
                        「按钮离输入框太远」的来源）。计数元素是 `span.ant-input-data-count`
                        （rc-textarea 渲染的真实元素，**不是** `[data-count]` 那个属性），
                        现在由 `index.sass` 的 `.commentComposer .ant-input-textarea-show-count`
                        把它按在框内的右下角，并给最后一行让出宽度。 */}
                    <Input.TextArea
                        ref={taRef}
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder="说点什么吧…（支持 markdown 与站内表情）"
                        autoSize={{ minRows: 3, maxRows: 8 }}
                        maxLength={MAX_COMMENT_CHARS}
                        showCount
                    />
                    <div className="commentComposerFoot">
                        <div className="commentComposerTools">
                            <StickerPicker onPick={pickSticker} disabled={busy} />
                            {/* 预览开关。**始终可点**（空草稿也点得开）——空着的时候那一栏
                                会写明"这里就是发出去之后的样子"，这本身就是给不认识 markdown
                                的人的一句提示，比把按钮置灰更有用。 */}
                            <button
                                type="button"
                                className={`commentPreviewBtn${preview ? ' isOpen' : ''}`}
                                aria-expanded={preview}
                                aria-controls="comment-preview"
                                onClick={() => setPreview((v) => !v)}
                            >
                                {preview ? '收起预览' : '预览'}
                            </button>
                        </div>
                        <button
                            type="button"
                            className="commentSubmit"
                            disabled={busy || !content.trim()}
                            onClick={submit}
                        >
                            {busy ? '发送中…' : '发表评论'}
                        </button>
                    </div>
                    {preview && (
                        <div className="commentPreview" id="comment-preview">
                            <div className="commentPreviewLabel">预览 · 发出去之后就是这个样子</div>
                            {/* **复用 `CommentBody`**：预览与已发布评论走的是同一条
                                `renderBlogMarkdown` 管线，不是第二份渲染器。所以表情在预览里
                                就已经是图了（`:头疼:` → `img.sticker`），而且预览里看到的
                                排版与发出去之后**逐字相同**——预览要是有自己的一套样式，
                                它就只是在骗人。 */}
                            {content.trim() ? (
                                <CommentBody content={content} />
                            ) : (
                                <p className="commentPreviewEmpty">
                                    还没有内容。上面写什么，这里就显示成什么样。
                                </p>
                            )}
                        </div>
                    )}
                </div>
            )}

            {items === null ? (
                <p className="commentEmpty">{failed ? '讨论区读取失败' : '正在读取讨论…'}</p>
            ) : failed ? (
                <p className="commentEmpty">
                    讨论区读取失败，<button type="button" className="commentRetry" onClick={() => void load()}>点此重试</button>
                </p>
            ) : tops.length === 0 ? (
                <p className="commentEmpty">还没有人讨论，来说第一句吧</p>
            ) : (
                <div className="commentList">
                    {tops.map((t) => (
                        <div className="commentThread" key={t.id}>
                            {renderRow(t, false)}
                            {(repliesByRoot.get(t.id) || []).map((r) => renderRow(r, true))}
                        </div>
                    ))}
                </div>
            )}

            {/* 删除确认：**受控 Modal**，按钮写动作词（不是"确定/取消"） */}
            <Modal
                open={!!pendingDelete}
                title="删除这条评论？"
                okText="删除评论"
                cancelText="再想想"
                okButtonProps={{ danger: true, loading: deleting }}
                cancelButtonProps={{ disabled: deleting }}
                onOk={doDelete}
                onCancel={() => { if (!deleting) setPendingDelete(null) }}
                destroyOnClose
            >
                <p>删除后这条评论不再公开显示（它下面的回复也会一起隐藏）。</p>
            </Modal>
        </div>
    )
}

export default CommentSection

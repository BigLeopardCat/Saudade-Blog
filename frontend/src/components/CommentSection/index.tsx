import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Input, Modal, message } from 'antd'
// 光标插入表情要拿到真正的 <textarea>：antd 的 TextArea 包了一层自动高度容器，
// 引用类型自带 `resizableTextArea.textArea`（不要用 as 硬转，那层结构改名后会静默失效）
import type { TextAreaRef } from 'antd/es/input/TextArea'
import type { CommentItem, CommentSort, CommentVote } from '../../interface/CommentType'
import { createComment, deleteMyComment, listComments, voteComment } from '../../apis/CommentMethods'
import { errMsg, ok } from '../../apis/ProfileMethods'
import { renderBlogMarkdown } from '../../utils/chatMarkdown'
import { resolveApiAssetUrl } from '../../utils/runtimeApi'
import { DEFAULT_AVATAR_URL } from '../UserCenter/identity'
import RoleBadge from '../RoleBadge'
import { ThumbUpIcon, ThumbDownIcon } from '../NoteStatIcons'
import StickerPicker from './StickerPicker'
import getToken from '../../apis/getToken'
import { useLiveRefresh } from '../../utils/liveRefresh'
import './index.sass'

/** 与后端 `src/routes/comments.rs::MAX_COMMENT_CHARS` **必须相等**：
 *  前端拦是为了给即时反馈，服务端那道才是真的（`contract-comment.test.mjs` 锁住两者一致）。
 *  计数用 `value.length`（UTF-16 单元）：它与 `maxLength` 同一口径，
 *  且对 emoji 只会**更严**（一个 emoji 算 2）——永远不会放行一条服务端要拒的。 */
const MAX_COMMENT_CHARS = 300

/** 仅将 renderBlogMarkdown 清洗后的 HTML 写入评论正文。 */
const CommentBody = ({ content }: { content: string }) => {
    const html = useMemo(() => renderBlogMarkdown(content), [content])
    return (
        <div
            className="commentBody markdown-body"
            dangerouslySetInnerHTML={{ __html: html }}
        />
    )
}

/** 先撤旧票，再应用新票，计算乐观票数。 */
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
    /** 每次进入页面默认按热度排序，不跨页面持久化。 */
    const [sort, setSort] = useState<CommentSort>('hot')
    const [content, setContent] = useState('')
    const [busy, setBusy] = useState(false)
    /** 行内回复与顶层草稿分开保存，同一时刻只展开一个回复框。 */
    const [openFor, setOpenFor] = useState<number | null>(null)
    const [replyContent, setReplyContent] = useState('')
    const [replyBusy, setReplyBusy] = useState(false)
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
            const res = await listComments(key, sort)
            if (!ok(res)) { setFailed(true); return }
            setItems(res.data.data || [])
            setFailed(false)
        } catch (e) {
            console.error('读取评论失败', e)
            setFailed(true)
        }
    }, [key, sort])

    // **两个 effect，不是一个**（文件头注 ⑥）。`setItems(null)` 是"这一页还没读到东西"，
    // 只有**换文章**才成立；把清空和重拉写在一起的话，点一下「最新」也会先把列表清掉，
    // 于是整个讨论区闪回"正在读取讨论…"再重新长出来。
    useEffect(() => { setItems(null); setFailed(false) }, [key])
    useEffect(() => { void load() }, [load])

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

    /* 列表就绪后定位 ?cid= 并高亮；瞬时滚动和 double-rAF 避免与页面初始滚动冲突。
 * 高亮由定时器结束，后台刷新不提前移除；目标不可见时保留文章页面。 */
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

    /** 等待 DOM 更新后定位评论；未公开或不可见的目标不滚动。 */
    const flashComment = (id: number) => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const el = document.getElementById(`c-${id}`)
                if (!el) return
                el.scrollIntoView({ block: 'center', behavior: 'auto' })
                el.classList.add('comment-hit')
                window.setTimeout(() => el.classList.remove('comment-hit'), 1800)
            })
        })
    }

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
        const { approved, id } = res.data.data
        await load()
        flashComment(id)
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
            // 顶层评论和行内回复使用独立输入。
            if (await postComment(text, null)) setContent('')
        } catch (e) {
            console.error('发表评论失败', e)
            message.error('发表失败，请稍后再试')
        } finally {
            setBusy(false)
        }
    }

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
        // 保留渲染时快照用于失败回滚，后续刷新再核对服务端状态。
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
                    <span className="commentName">{c.nickname}</span>
                    <RoleBadge role={c.role} size={20} />
                    <span className="commentUid">UID:{c.userId}</span>
                    <span className="commentTime">{c.createdAt}</span>
                </div>
                {isReply && (
                    <div className="commentReplyTo">
                        回复 @{c.replyToNickname || '已注销用户'}
                    </div>
                )}
                <CommentBody content={c.content} />
                <div className="commentActions">
                    <button type="button" onClick={() => openReply(c)}>回复</button>
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
                                {dir === 1 ? <ThumbUpIcon /> : <ThumbDownIcon />}
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

            {tops.length > 1 && (
                <div className="commentSort" role="group" aria-label="讨论区排序">
                    {([['hot', '最热'], ['new', '最新']] as const).map(([v, label]) => (
                        <button
                            key={v}
                            type="button"
                            className={sort === v ? 'isOn' : ''}
                            aria-pressed={sort === v}
                            onClick={() => setSort(v)}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            )}

            {!loggedIn ? (
                <p className="commentLoginTip">
                    <a href="/login">登录</a> 后即可参与讨论
                </p>
            ) : (
                <div className="commentComposer">
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

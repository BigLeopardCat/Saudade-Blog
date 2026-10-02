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
 *     （本文件里唯一一处，见 `CommentBody`）；
 *   · **任何地方都不许对评论原文直接 `innerHTML`**，也不许在这里另写一份 escapeHtml。
 *     自己拼一份"安全 HTML"就是把同一条链路的第二个实现引进来——两处必然会漂。
 *
 * **② 两层结构：回复的回复挂在同一个顶层下，服务端已经保证，前端不"假装缩进"。**
 * 一条评论的 `rootId` 为 null 即顶层；其余的 `rootId` 指向它所属的顶层——
 * 这是服务端从父行派生的（客户端只传 `parentId`，见 `create_comment`），
 * 所以对一条回复的回复，`rootId` 仍是那条顶层。这里只按 `rootId` 分组，
 * 缩进层级天然只有两层，与数据一致（不是靠 CSS 假装出来的）。
 *
 * 评论 id 与留言板 `talk.id` 是**两个命名空间**，所以显示带 `#C` 前缀。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Input, Modal, message } from 'antd'
// 光标插入表情要拿到真正的 <textarea>：antd 的 TextArea 包了一层自动高度容器，
// 引用类型自带 `resizableTextArea.textArea`（不要用 as 硬转，那层结构改名后会静默失效）
import type { TextAreaRef } from 'antd/es/input/TextArea'
import type { CommentItem } from '../../interface/CommentType'
import { createComment, deleteMyComment, listComments } from '../../apis/CommentMethods'
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

interface CommentSectionProps {
    /** 文章 id（路由参数，未解析出来时别发请求） */
    noteId?: string | number
}

const CommentSection = ({ noteId }: CommentSectionProps) => {
    const [items, setItems] = useState<CommentItem[] | null>(null)
    const [failed, setFailed] = useState(false)
    const [content, setContent] = useState('')
    const [replyTo, setReplyTo] = useState<CommentItem | null>(null)
    const [busy, setBusy] = useState(false)
    const [pendingDelete, setPendingDelete] = useState<CommentItem | null>(null)
    const [deleting, setDeleting] = useState(false)
    const taRef = useRef<TextAreaRef>(null)
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

    /** 把 `:名字:` 插到光标处（不是追加到末尾——插完把光标挪到表情之后继续打字） */
    const pickSticker = (name: string) => {
        const token = `:${name}:`
        const el = taRef.current?.resizableTextArea?.textArea
        if (!el) { setContent((v) => v + token); return }
        const start = el.selectionStart ?? content.length
        const end = el.selectionEnd ?? start
        const next = content.slice(0, start) + token + content.slice(end)
        setContent(next)
        requestAnimationFrame(() => {
            el.focus()
            const at = start + token.length
            el.setSelectionRange(at, at)
        })
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
            const res = await createComment(key, text, replyTo?.id ?? null)
            if (!ok(res)) { message.error(errMsg(res)); return }
            const { approved } = res.data.data
            setContent('')
            setReplyTo(null)
            await load()
            // 三种审核结果说三种话：**不把"待审"说成"已发布"**。
            // 这也正是接口要回 `approved` 的原因（只给 id 的话这里只能含糊其辞）。
            if (approved === 1) message.success('评论已发布')
            else if (approved === 0) message.info('评论已提交，通过人工复核后才会公开显示')
            else message.warning('评论未通过审核，不会公开展示')
        } catch (e) {
            console.error('发表评论失败', e)
            message.error('发表失败，请稍后再试')
        } finally {
            setBusy(false)
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
                    {/* 行首「回复 @某人」：只有回复才有（顶层的 replyToUid 恒 null） */}
                    {isReply && (
                        <span className="commentReplyTo">
                            回复 @{c.replyToNickname || '已注销用户'}
                        </span>
                    )}
                    <span className="commentName">{c.nickname}</span>
                    <RoleBadge role={c.role} size={20} />
                    {/* 评论 id：小一号、淡一点——它是排障/定位用的，不该抢昵称的视线 */}
                    <span className="commentId">#C{c.id}</span>
                    <span className="commentTime">{c.createdAt}</span>
                </div>
                <CommentBody content={c.content} />
                <div className="commentActions">
                    <button type="button" onClick={() => setReplyTo(c)}>回复</button>
                    {c.mine && (
                        <button type="button" className="isDanger" onClick={() => setPendingDelete(c)}>
                            删除
                        </button>
                    )}
                </div>
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
                    {replyTo && (
                        <div className="commentReplyBar">
                            <span>正在回复 @{replyTo.nickname}</span>
                            <button type="button" onClick={() => setReplyTo(null)}>取消</button>
                        </div>
                    )}
                    <Input.TextArea
                        ref={taRef}
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder={replyTo ? `回复 @${replyTo.nickname}…` : '说点什么吧…（支持 markdown 与站内表情）'}
                        autoSize={{ minRows: 3, maxRows: 8 }}
                        maxLength={MAX_COMMENT_CHARS}
                        showCount
                    />
                    <div className="commentComposerFoot">
                        <StickerPicker onPick={pickSticker} disabled={busy} />
                        <button
                            type="button"
                            className="commentSubmit"
                            disabled={busy || !content.trim()}
                            onClick={submit}
                        >
                            {busy ? '发送中…' : replyTo ? '回复' : '发表评论'}
                        </button>
                    </div>
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

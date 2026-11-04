import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {message} from "antd";
import { useNavigate } from 'react-router-dom'
import getToken from '../../apis/getToken.tsx'
import { getRoleFromToken, getTokenClaims, isAdminToken } from '../../utils/auth.ts'

import { resolveApiAssetUrl } from '../../utils/runtimeApi'
import { useIsDarkMode } from '../../theme'

import {changePassword, deleteDraft, errMsg, getDrafts, getMailbox, getMyQuota, getMyTalks, getNotifications, getProfile, ok, readMessages, readNotifications, removeFavorite, saveDraft, sendMessage, updateNickname, uploadAvatar} from "../../apis/ProfileMethods.tsx";
import type {Mailbox, MessageDraft, MyTalk, NotificationItem, ProfileInfo, QuotaInfo} from "../../interface/ProfileType";

import { DEFAULT_AVATAR_URL } from './identity'
import { notifyUnreadChanged, useUnread } from './unread'
import { applyLocalFavorite, useFavorites } from './favorites'
import { AGENT_TURN_DONE_EVENT } from './agentTurn'
import DeleteInboxItem from './DeleteInboxItem'
import type {MessageItem, UnreadSummary} from '../../interface/ProfileType';

/** 按页签加载数据；写操作经后端确认后再更新本地状态。 */
export function useUserCenterModel({open,onClose}: {open:boolean; onClose:()=>void}) {

    const isDark = useIsDarkMode()
    const navigate = useNavigate()
    const loggedIn = !!getToken()
    const admin = isAdminToken(getToken())
    const uid = getTokenClaims(getToken())?.sub
    const { counts } = useUnread(open && loggedIn)

    const [tab, setTab] = useState('settings')
    const [profile, setProfile] = useState<ProfileInfo | null>(null)

    // 权限身份标签用的角色：优先 `profile.role`（后端**现读库**，见 ProfileDto），
    // profile 还没拉回来时回退令牌 claims。两者都不参与权限判断（真正的授权在 Rust 侧），
    // 只决定这一个标签写什么。
    const effectiveRole = profile?.role ?? getRoleFromToken(getToken())

    // 各页签数据（null = 还没加载过）。收藏**不在本组件里存**——它是共享状态（详情页那颗
    // ★ 看的是同一份），见 favorites.ts。enabled = 「这一页这一刻真的在看收藏」：窗没开、
    // 没登录、没点开收藏页签都不拉（其余三个页签同理，都是点了才拉）。
    const { list: favorites, failed: favFailed } = useFavorites(
        open && loggedIn && tab === 'favorites',
    )
    const [talks, setTalks] = useState<MyTalk[] | null>(null)
    const [notices, setNotices] = useState<NotificationItem[] | null>(null)
    const [noticeUnread, setNoticeUnread] = useState(0)
    /** 点开的那条通知（null = 在列表态）。**存 id 不存整条**——见 `openedNotice`。 */
    const [noticeOpenId, setNoticeOpenId] = useState<number | null>(null)
    const [mailbox, setMailbox] = useState<Mailbox | null>(null)
    const [quota, setQuota] = useState<QuotaInfo | null>(null)
    /** 申请弹窗（受控）。理由可空——后端把空串落 NULL，不编一句占位话。 */
    const [applyOpen, setApplyOpen] = useState(false)
    const [applyReason, setApplyReason] = useState('')
    const [applying, setApplying] = useState(false)

    const [loadingTab, setLoadingTab] = useState(false)

    // 头像裁剪与上传
    const [cropFile, setCropFile] = useState<File | null>(null)
    const [cropOpen, setCropOpen] = useState(false)
    const [uploading, setUploading] = useState(false)

    // 用户设置表单
    const [nickname, setNickname] = useState('')
    const [savingNick, setSavingNick] = useState(false)
    const [pwdOld, setPwdOld] = useState('')
    const [pwdNew, setPwdNew] = useState('')
    const [pwdNew2, setPwdNew2] = useState('')
    const [savingPwd, setSavingPwd] = useState(false)

    // 写信表单
    const [to, setTo] = useState('')
    const [mailTitle, setMailTitle] = useState('')
    const [body, setBody] = useState('')
    const [sending, setSending] = useState(false)

    const [mailTab, setMailTab] = useState<'in' | 'out' | 'drafts' | 'compose'>('in')
    /** 点开的那封信（null = 在列表上）。详情**占满整个窗口**，连二级签页一起顶掉。 */
    const [opened, setOpened] = useState<{ msg: MessageItem; outgoing: boolean } | null>(null)
    /** 草稿箱（null = 还没拉过） */
    const [drafts, setDrafts] = useState<MessageDraft[] | null>(null)
    const [savingDraft, setSavingDraft] = useState(false)
    /** 当前在编辑哪条草稿；null = 这是一封新信。
     *  ⚠️ 存草稿成功后**必须回填这个 id**：后端按"有无 id"决定新建还是更新，
     *     不回填就会在写信过程中点两次「存草稿」攒出两条一模一样的草稿。 */
    const [editingDraftId, setEditingDraftId] = useState<number | null>(null)

    const unreadOf = (s: UnreadSummary | undefined, k: 'notifications' | 'messages') => s?.[k] ?? 0

    // 打开窗口：拉一次用户信息（每次打开都刷新——别处改过昵称/头像时这里要跟上）
    useEffect(() => {
        if (!open || !loggedIn) return
        getProfile()
            .then((res) => {
                if (ok(res)) {
                    setProfile(res.data.data)
                    setNickname(res.data.data?.nickname || '')
                } else {
                    message.error(errMsg(res, '登录状态已失效，请重新登录'))
                }
            })
            .catch(() => message.error('网络异常，请稍后再试'))
    }, [open, loggedIn])

    // 关窗清掉表单敏感字段（密码输入不该留在内存里等下次打开）
    useEffect(() => {
        if (open) return
        setPwdOld('')
        setPwdNew('')
        setPwdNew2('')
        setTo('')
        setMailTitle('')
        setBody('')
        // 关窗也退出"正在写的那封"：留着 editingDraftId 而正文被清空，下次一按存草稿
        // 就拿空内容覆盖掉原来那条草稿（后端只拦"三个字段全空"，拦不住只留标题的）。
        setEditingDraftId(null)
        setOpened(null)
        setMailTab('in')
        setCropFile(null)
        setCropOpen(false)
        // 申请弹窗连同理由一起关掉：下次打开是这个弹窗的"全新一次申请"，
        // 留着上一轮没提交的那段字会让人以为已经提交过了。
        setApplyOpen(false)
        setApplyReason('')
    }, [open])

    /** 页签首次激活时加载数据。`force` = 已经加载过也重拉一次（agent 一轮收尾后用，
     *  见下面那个订阅 `agent-turn-done` 的 effect）。 */
    const loadTab = useCallback(
        async (key: string, force = false) => {
            if (!loggedIn) return
            if (key === 'favorites') return
            setLoadingTab(true)
            try {
                if (key === 'talks' && (force || talks === null)) {
                    const res = await getMyTalks()
                    if (ok(res)) setTalks(res.data.data || [])
                    else message.error(errMsg(res))
                } else if (key === 'notices' && (force || notices === null)) {
                    const res = await getNotifications()
                    if (ok(res)) {
                        setNotices(res.data.data?.items || [])
                        setNoticeUnread(res.data.data?.unread ?? 0)
                    } else {
                        message.error(errMsg(res))
                    }
                } else if (key === 'mailbox' && (force || mailbox === null)) {
                    const res = await getMailbox()
                    if (ok(res)) setMailbox(res.data.data)
                    else message.error(errMsg(res))
                } else if (key === 'quota' && (force || quota === null)) {
                    const res = await getMyQuota()
                    // 读不到就**保留上一次的读数**（与 unread.ts 同一条纪律：清成 0 是拿
                    // "读不到"冒充"没有额度了"——对额度这个数，那句话正好反着说）
                    if (ok(res)) setQuota(res.data.data)
                    else message.error(errMsg(res))
                }
            } catch {
                message.error('网络异常，请稍后再试')
            } finally {
                setLoadingTab(false)
            }
        },
        [loggedIn, talks, notices, mailbox, quota],
    )

    /** 最新一版 `loadTab`（它的身份随页签数据变，直接进 effect 依赖会自己触发自己）。 */
    const loadTabRef = useRef(loadTab)
    useEffect(() => {
        loadTabRef.current = loadTab
    }, [loadTab])

    /** 换页签只切状态：拉数据统一由下面那条 effect 负责（点开 = 重拉一次，加载过也重拉）。 */
    const onTabChange = (key: string) => setTab(key)

    /** 草稿箱的数据源（与其它页签同一条懒加载纪律：首次点开才请求）。 */
    const loadDrafts = useCallback(async () => {
        if (!loggedIn) return
        setLoadingTab(true)
        try {
            const res = await getDrafts()
            if (ok(res)) setDrafts(res.data.data || [])
            else message.error(errMsg(res))
        } catch {
            message.error('网络异常，请稍后再试')
        } finally {
            setLoadingTab(false)
        }
    }, [loggedIn])

    const onMailTabChange = (k: string) => {
        const key = k as 'in' | 'out' | 'drafts' | 'compose'
        setMailTab(key)
        // 换签页 = 离开详情（详情是盖在签页之上的那一层）
        setOpened(null)
        if (key === 'drafts' && drafts === null) loadDrafts()
    }

    useEffect(() => {
        if (!open || !loggedIn) return
        const onTurnDone = () => {
            if (talks !== null) void loadTab('talks', true)
            if (notices !== null) void loadTab('notices', true)
            if (mailbox !== null) void loadTab('mailbox', true)
            if (drafts !== null) void loadDrafts()
            if (quota !== null) void loadTab('quota', true)
        }
        window.addEventListener(AGENT_TURN_DONE_EVENT, onTurnDone)
        return () => window.removeEventListener(AGENT_TURN_DONE_EVENT, onTurnDone)
    }, [open, loggedIn, talks, notices, mailbox, drafts, quota, loadTab, loadDrafts])

    useEffect(() => {
        if (!open || !loggedIn) return
        void loadTabRef.current(tab, true)
    }, [open, loggedIn, tab])

    // ── 用户设置 ────────────────────────────────────────────────────────────

    const handlePickFile = (f: File) => {
        setCropFile(f)
        setCropOpen(true)
    }

    const handleCropConfirm = async (blob: Blob) => {
        setUploading(true)
        try {
            const file = new File([blob], 'avatar.jpg', { type: 'image/jpeg' })
            const res = await uploadAvatar(file)
            if (ok(res)) {
                const url = res.data.data?.avatar || ''
                setProfile((p) => (p ? { ...p, avatar: url } : p))
                setCropOpen(false)
                setCropFile(null)
                message.success('头像已更新')
                // 头部/留言等处的头像数据源在别处（redux 站点信息），派个事件让它知道要刷新
                window.dispatchEvent(new CustomEvent('profile-change'))
            } else {
                message.error(errMsg(res, '头像上传失败'))
            }
        } catch {
            message.error('头像上传失败，请稍后再试')
        } finally {
            setUploading(false)
        }
    }

    const saveNickname = async () => {
        const v = nickname.trim()
        if (!v) {
            message.error('昵称不能为空')
            return
        }
        if (v === (profile?.nickname || '')) {
            message.info('昵称没有变化')
            return
        }
        setSavingNick(true)
        try {
            const res = await updateNickname(v)
            if (ok(res)) {
                setProfile(res.data.data)
                setNickname(res.data.data?.nickname || v)
                message.success('昵称已保存')
                window.dispatchEvent(new CustomEvent('profile-change'))
            } else {
                message.error(errMsg(res, '保存失败'))
            }
        } catch {
            message.error('网络异常，请稍后再试')
        } finally {
            setSavingNick(false)
        }
    }

    const savePassword = async () => {
        if (!pwdOld) {
            message.error('请输入原密码')
            return
        }
        if (pwdNew.length < 8) {
            message.error('新密码至少 8 位')
            return
        }
        if (pwdNew !== pwdNew2) {
            message.error('两次输入的新密码不一致')
            return
        }
        setSavingPwd(true)
        try {
            const res = await changePassword(pwdOld, pwdNew)
            if (ok(res)) {
                const fresh = res.data.data?.token
                if (fresh) localStorage.setItem('tokenKey', fresh)
                message.success('密码已修改，其他设备上的登录状态已全部失效')
                setPwdOld('')
                setPwdNew('')
                setPwdNew2('')
            } else {
                message.error(errMsg(res, '修改失败'))
            }
        } catch {
            message.error('网络异常，请稍后再试')
        } finally {
            setSavingPwd(false)
        }
    }

    // ── 收藏 ────────────────────────────────────────────────────────────────

    const dropFavorite = async (noteId: number) => {
        try {
            const res = await removeFavorite(noteId)
            if (ok(res)) {
                // 写入成功 ⇒ 交给共享状态（列表当场摘掉那一行 + 详情页那颗★同时变）
                applyLocalFavorite(noteId, false)
                message.success('已取消收藏')
            } else {
                message.error(errMsg(res))
            }
        } catch {
            message.error('网络异常，请稍后再试')
        }
    }

    const openArticle = (id: number) => {
        onClose()
        navigate(`/article/${id}`)
    }

    // ── 通知 ────────────────────────────────────────────────────────────────

    const removeNoticeButton = (id: number) => <DeleteInboxItem item={{ kind: 'notification', id }}
        onRemoved={counts => {
            setNotices(list => (list || []).filter(item => item.id !== id))
            setNoticeUnread(counts.notifications)
            setNoticeOpenId(current => current === id ? null : current)
        }} />

    const removeMailButton = (id: number, outgoing: boolean) => <DeleteInboxItem
        item={{ kind: 'message', id, folder: outgoing ? 'outbox' : 'inbox' }}
        onRemoved={counts => {
            setMailbox(current => current ? { ...current, unread: counts.messages,
                [outgoing ? 'outbox' : 'inbox']: current[outgoing ? 'outbox' : 'inbox']
                    .filter(item => item.id !== id) } : current)
            setOpened(current => current?.msg.id === id && current.outgoing === outgoing
                ? null : current)
        }} />

    const markNoticesRead = async (ids?: number[]) => {
        try {
            const res = await readNotifications(ids && ids.length ? { ids } : { all: true })
            if (ok(res)) {
                const left = res.data.data?.notifications ?? 0
                setNoticeUnread(left)
                setNotices((list) =>
                    (list || []).map((n) => (!ids || ids.includes(n.id) ? { ...n, isRead: true } : n)),
                )
                notifyUnreadChanged()
            } else {
                message.error(errMsg(res))
            }
        } catch {
            message.error('网络异常，请稍后再试')
        }
    }

    const openNotice = async (n: NotificationItem) => {
        const link = (n.link || '').trim()
        if (!link.startsWith('/') || link.startsWith('//')) return
        if (!n.isRead) await markNoticesRead([n.id])
        onClose()
        navigate(link)
    }

    // ── 信箱 ────────────────────────────────────────────────────────────────

    const doSend = async () => {
        if (!to.trim()) {
            message.error('请填写收件人账号或 UID')
            return
        }
        if (!body.trim()) {
            message.error('内容不能为空')
            return
        }
        setSending(true)
        try {
            const res = await sendMessage(to.trim(), mailTitle.trim(), body.trim())
            if (ok(res)) {
                message.success('已发送')
                setMailTitle('')
                setBody('')
                // 发件箱立刻追一条（回包就是那条消息，不必重拉整个信箱）
                const sent = res.data.data
                if (sent) setMailbox((m) => (m ? { ...m, outbox: [sent, ...(m.outbox || [])] } : m))
                // 这封信是从草稿发出去的 ⇒ 草稿立刻删掉：留着就成了"明明发出去了、
                // 却还躺在草稿箱里"的幽灵。删失败只影响草稿箱列表，不否定"已发送"这个事实。
                if (editingDraftId != null) {
                    const id = editingDraftId
                    setEditingDraftId(null)
                    try {
                        const del = await deleteDraft(id)
                        if (ok(del)) setDrafts((list) => (list || []).filter((d) => d.id !== id))
                    } catch {
                        /* 保留草稿，用户可在草稿箱里手动删 */
                    }
                }
            } else {
                message.error(errMsg(res, '发送失败'))
            }
        } catch {
            message.error('网络异常，请稍后再试')
        } finally {
            setSending(false)
        }
    }

    const openMail = async (m: MessageItem, outgoing: boolean) => {
        setOpened({ msg: m, outgoing })
        if (outgoing || m.isRead) return
        try {
            const res = await readMessages({ ids: [m.id] })
            if (ok(res)) {
                setMailbox(res.data.data)
                notifyUnreadChanged()
            }
        } catch {
            /* 标记已读失败不妨碍看信：详情已经打开了 */
        }
    }

    // ── 草稿箱 ──────────────────────────────────────────────────────────────

    const doSaveDraft = async () => {
        if (!to.trim() && !mailTitle.trim() && !body.trim()) {
            message.error('草稿是空的，先写点什么再存')
            return
        }
        setSavingDraft(true)
        try {
            // 正文不 trim：草稿是"接着写"的东西，用户敲的换行原样留着（发送时才 trim）
            const res = await saveDraft({
                id: editingDraftId ?? undefined,
                toUsername: to.trim(),
                title: mailTitle.trim(),
                content: body,
            })
            if (ok(res)) {
                setEditingDraftId(res.data.data?.id ?? null)
                message.success('草稿已保存')
                // 草稿箱可能与写信页同时开着，存完立刻对齐（也把新草稿拉进列表）
                loadDrafts()
            } else {
                message.error(errMsg(res, '保存失败'))
            }
        } catch {
            message.error('网络异常，请稍后再试')
        } finally {
            setSavingDraft(false)
        }
    }

    /** 「继续写」：把草稿灌回写信表单，并记下 id —— 之后每次存都更新**这一条**。 */
    const continueDraft = (d: MessageDraft) => {
        setTo(d.toUsername || '')
        setMailTitle(d.title || '')
        setBody(d.content || '')
        setEditingDraftId(d.id)
        setOpened(null)
        setMailTab('compose')
    }

    const newMail = () => {
        setTo('')
        setMailTitle('')
        setBody('')
        setEditingDraftId(null)
        setOpened(null)
        setMailTab('compose')
    }

    const dropDraft = async (id: number) => {
        try {
            const res = await deleteDraft(id)
            if (ok(res)) {
                setDrafts((list) => (list || []).filter((d) => d.id !== id))
                if (editingDraftId === id) setEditingDraftId(null)
                message.success('草稿已删除')
            } else {
                message.error(errMsg(res))
            }
        } catch {
            message.error('网络异常，请稍后再试')
        }
    }

    const markMailRead = async () => {
        try {
            const res = await readMessages({ all: true })
            if (ok(res)) {
                setMailbox(res.data.data)
                notifyUnreadChanged()
            } else {
                message.error(errMsg(res))
            }
        } catch {
            message.error('网络异常，请稍后再试')
        }
    }

    /** 「留言记录」只列河灯留言（`src='board'`）。
     *  权威过滤在后端（`list_my_talks` 的 `src='board'`）——**这里是显示侧的兜底**：
     *  这条缺陷的形态是"后端把两类一起回、前端照单全收"，只要前端永远只认 board，
     *  后端哪天再把说说混回来也不会重新长成用户看得见的样子（无头测试锁在这一层）。 */
    const boardTalks = useMemo(() => (talks || []).filter((t) => t.src !== 'talk'), [talks])

    const myAvatar = useMemo(
        () => resolveApiAssetUrl(profile?.avatar || '') || DEFAULT_AVATAR_URL,
        [profile?.avatar],
    )


    return {
        isDark, navigate, loggedIn, admin,
        uid, counts, tab, profile,
        effectiveRole, favorites, favFailed, talks,
        notices, noticeUnread, noticeOpenId, setNoticeOpenId,
        mailbox, quota, setQuota, applyOpen,
        setApplyOpen, applyReason, setApplyReason, applying,
        setApplying, loadingTab, cropFile, setCropFile,
        cropOpen, setCropOpen, uploading, nickname,
        setNickname, savingNick, pwdOld, setPwdOld,
        pwdNew, setPwdNew, pwdNew2, setPwdNew2,
        savingPwd, to, setTo, mailTitle,
        setMailTitle, body, setBody, sending,
        mailTab, opened, setOpened, drafts,
        savingDraft, editingDraftId, unreadOf, onTabChange,
        onMailTabChange, handlePickFile, handleCropConfirm, saveNickname,
        savePassword, dropFavorite, openArticle, removeNoticeButton,
        removeMailButton, markNoticesRead, openNotice, doSend,
        openMail, doSaveDraft, continueDraft, newMail,
        dropDraft, markMailRead, boardTalks, myAvatar,
    };
}

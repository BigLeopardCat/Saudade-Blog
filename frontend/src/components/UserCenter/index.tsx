/**
 * 个人中心（20260922 一期）：点头部登录卡里的「设置」打开的大窗口（按钮 20260922 晚改名）。
 *
 * 五个页签（用户原话的顺序）：用户设置 / 收藏的文章 / 留言记录 / 公告和通知 / 站内信箱。
 * 「站内信箱」自己还有四个二级签页（20260923 用户要求）：收件箱 / 发件箱 / 草稿箱 / 写站内信——
 * 写信表单不再是常驻在信箱顶部的一块，而是其中一个签页；点开某封信则**占满整个窗口**显示详情。
 *
 * 几个刻意的设计决定（改动前先读这几条）：
 *   · **数据按页签懒加载**：打开窗口只拉"用户设置"，其余页签首次点开才请求。个人中心是
 *     低频入口，一次点开发五个请求不好——但**通知/私信的红点不受影响**，它由
 *     useUnread 独立轮询（见 unread.ts）。
 *   · **不做乐观更新**：收藏/已读/发信都等后端回包再改界面。这族接口在"没做成"时返回的
 *     是 HTTP 200 + code=500 + 中文原因（见 apis/ProfileMethods.tsx 头注），乐观更新会
 *     出现"界面说成了、其实没成"的假象——比慢一点糟得多。
 *   · **时间一律字符串截断展示**（后端已是 +08:00 本地钟面）：不构造 Date，就不可能出现
 *     浏览器时区二次偏移（AnnouncementModal 上踩过：多 8 小时）。
 *   · **管理员多一个「后台管理」入口**：个人中心对所有人开（普通用户过去点那个旧钮会被
 *     AuthRouter 弹回首页），后台入口改由窗口头部提供，管理员的路径没有丢。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Avatar, Badge, Button, ConfigProvider, Empty, Input, List, Modal, Tabs, Tag, message, theme as antdTheme } from 'antd'
import { useNavigate } from 'react-router-dom'
import getToken from '../../apis/getToken.tsx'
import { getTokenClaims, isAdminToken } from '../../utils/auth.ts'
import { resolveApiAssetUrl } from '../../utils/runtimeApi'
import { useIsDarkMode } from '../../theme'
import {
    changePassword,
    deleteDraft,
    errMsg,
    getDrafts,
    getFavorites,
    getMailbox,
    getMyTalks,
    getNotifications,
    getProfile,
    ok,
    readMessages,
    readNotifications,
    removeFavorite,
    saveDraft,
    sendMessage,
    updateNickname,
    uploadAvatar,
} from '../../apis/ProfileMethods.tsx'
import type {
    FavoriteItem,
    Mailbox,
    MessageDraft,
    MessageItem,
    MyTalk,
    NotificationItem,
    ProfileInfo,
    UnreadSummary,
} from '../../interface/ProfileType'
import AvatarCropModal from '../AvatarCropModal'
import { DEFAULT_AVATAR_URL } from './identity'
import { notifyUnreadChanged, useUnread } from './unread'
import './index.sass'

/** 后端时间是 "YYYY-MM-DD HH:MM:SS"（已是 +08:00 钟面）——截到分钟，不做任何换算 */
const fmtMinute = (s?: string): string => (s ? s.slice(0, 16) : '')

/** talk.approved：1=通过 / 0=待审 / 2=未通过（后端如实回传，这里也如实显示） */
const TALK_STATUS: Record<number, { text: string; color: string }> = {
    1: { text: '已通过', color: 'green' },
    0: { text: '待审核', color: 'gold' },
    2: { text: '未通过', color: 'red' },
}

/** 信件列表第三行（正文预览）的截断长度。 */
const MAIL_SNIPPET_CHARS = 40

/**
 * 列表里那"一行正文"（20260923 用户要求：「再换行显示一行正文并以...结尾」）。
 *
 * **确定性地**截断并补省略号，不靠 CSS 的 `text-overflow`——那样短正文没有省略号、
 * 长正文的省略号位置又随窗口宽度漂移。这里固定字数 + 固定结尾，长度与形态都稳定。
 * 换行/连续空格先压成单个空格：预览行是"一行"，正文里的换行不能把它撑成两行。
 */
const snippet = (s?: string): string => {
    const t = (s || '').replace(/\s+/g, ' ').trim()
    if (!t) return '（无正文）'
    const cut = t.length > MAIL_SNIPPET_CHARS ? `${t.slice(0, MAIL_SNIPPET_CHARS)}…` : t
    // 正文自己就以「…」收尾时（很多人写信就这么断句）不再补第二个，免得出现「………」
    return cut.endsWith('…') ? cut : `${cut}…`
}

interface UserCenterProps {
    open: boolean
    onClose: () => void
}

const UserCenter = ({ open, onClose }: UserCenterProps) => {
    const isDark = useIsDarkMode()
    const navigate = useNavigate()
    const loggedIn = !!getToken()
    const admin = isAdminToken(getToken())
    // 自己的 UID：个人资料接口不回 id，而令牌的 sub 就是后端 auth_uid / 站内信
    // 「UID 通道」认的那个 id ⇒ 为一行显示去改后端 DTO 不划算（20260923 用户要求显示）
    const uid = getTokenClaims(getToken())?.sub
    const { counts } = useUnread(open && loggedIn)

    const [tab, setTab] = useState('settings')
    const [profile, setProfile] = useState<ProfileInfo | null>(null)

    // 各页签数据（null = 还没加载过）
    const [favorites, setFavorites] = useState<FavoriteItem[] | null>(null)
    const [talks, setTalks] = useState<MyTalk[] | null>(null)
    const [notices, setNotices] = useState<NotificationItem[] | null>(null)
    const [noticeUnread, setNoticeUnread] = useState(0)
    const [mailbox, setMailbox] = useState<Mailbox | null>(null)

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
    /** 信件标题（20260922 用户要求补）：**选填**——历史上发出的信都没有标题，
     *  强制必填会让"就回一句"变得啰嗦。空标题在收件箱里按"（无标题）"显示。 */
    const [mailTitle, setMailTitle] = useState('')
    const [body, setBody] = useState('')
    const [sending, setSending] = useState(false)

    // 站内信箱的二级签页（20260923 用户要求）：收件箱 / 发件箱 / 草稿箱 / 写站内信，
    // 四个排在原来「写站内信」表单那一行的位置（表单自己降级成其中一个签页）。
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
    }, [open])

    /** 页签首次激活时加载数据 */
    const loadTab = useCallback(
        async (key: string) => {
            if (!loggedIn) return
            setLoadingTab(true)
            try {
                if (key === 'favorites' && favorites === null) {
                    const res = await getFavorites()
                    if (ok(res)) setFavorites(res.data.data || [])
                    else message.error(errMsg(res))
                } else if (key === 'talks' && talks === null) {
                    const res = await getMyTalks()
                    if (ok(res)) setTalks(res.data.data || [])
                    else message.error(errMsg(res))
                } else if (key === 'notices' && notices === null) {
                    const res = await getNotifications()
                    if (ok(res)) {
                        setNotices(res.data.data?.items || [])
                        setNoticeUnread(res.data.data?.unread ?? 0)
                    } else {
                        message.error(errMsg(res))
                    }
                } else if (key === 'mailbox' && mailbox === null) {
                    const res = await getMailbox()
                    if (ok(res)) setMailbox(res.data.data)
                    else message.error(errMsg(res))
                }
            } catch (e) {
                message.error('网络异常，请稍后再试')
            } finally {
                setLoadingTab(false)
            }
        },
        [loggedIn, favorites, talks, notices, mailbox],
    )

    const onTabChange = (key: string) => {
        setTab(key)
        loadTab(key)
    }

    /** 草稿箱的数据源（与其它页签同一条懒加载纪律：首次点开才请求）。 */
    const loadDrafts = useCallback(async () => {
        if (!loggedIn) return
        setLoadingTab(true)
        try {
            const res = await getDrafts()
            if (ok(res)) setDrafts(res.data.data || [])
            else message.error(errMsg(res))
        } catch (e) {
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
        } catch (e) {
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
        } catch (e) {
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
                message.success('密码已修改（其他设备上的登录状态仍有效，直到令牌过期）')
                setPwdOld('')
                setPwdNew('')
                setPwdNew2('')
            } else {
                message.error(errMsg(res, '修改失败'))
            }
        } catch (e) {
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
                setFavorites((list) => (list || []).filter((f) => f.noteId !== noteId))
                message.success('已取消收藏')
            } else {
                message.error(errMsg(res))
            }
        } catch (e) {
            message.error('网络异常，请稍后再试')
        }
    }

    const openArticle = (id: number) => {
        onClose()
        navigate(`/article/${id}`)
    }

    // ── 通知 ────────────────────────────────────────────────────────────────

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
        } catch (e) {
            message.error('网络异常，请稍后再试')
        }
    }

    /** 点通知里的站内链接（20260923）。
     *
     *  留言审核结果通知带 `/guestbook?lid=<id>`（跳过去定位到那盏灯），此前通知只有
     *  纯文本、`link` 字段渲染都没渲染——用户要求"和对应链接"，这里把它接上。
     *  跳转即视为看过：顺手标一条已读（与点「标记已读」同义），红点不必等下一轮轮询。
     *
     *  链接**只认站内路径**（`/` 开头且不是 `//`）：通知内容来自后端，但"拼接的内容不可信"
     *  这条纪律不该有例外——不校验就等于给自己留一个把 `navigate` 当外链跳板的口子。
     */
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
                    } catch (e) {
                        /* 保留草稿，用户可在草稿箱里手动删 */
                    }
                }
            } else {
                message.error(errMsg(res, '发送失败'))
            }
        } catch (e) {
            message.error('网络异常，请稍后再试')
        } finally {
            setSending(false)
        }
    }

    /** 点开一封信 = 看**占满整个窗口的详情**（20260923 用户要求）。
     *  收件箱里未读的顺手标已读——点开了就是读了，不该逼人回去再点一次「全部已读」。 */
    const openMail = async (m: MessageItem, outgoing: boolean) => {
        setOpened({ msg: m, outgoing })
        if (outgoing || m.isRead) return
        try {
            const res = await readMessages({ ids: [m.id] })
            if (ok(res)) {
                setMailbox(res.data.data)
                notifyUnreadChanged()
            }
        } catch (e) {
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
        } catch (e) {
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
        } catch (e) {
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
        } catch (e) {
            message.error('网络异常，请稍后再试')
        }
    }

    /** 「留言记录」只列河灯留言（`src='board'`）。
     *  权威过滤在后端（`list_my_talks` 的 `src='board'`）——**这里是显示侧的兜底**：
     *  这条缺陷的形态是"后端把两类一起回、前端照单全收"，只要前端永远只认 board，
     *  后端哪天再把说说混回来也不会重新长成用户看得见的样子（无头测试锁在这一层）。 */
    const boardTalks = useMemo(() => (talks || []).filter((t) => t.src !== 'talk'), [talks])

    /** 本人头像：没上传过就用默认头像（20260922 用户要求）——**不再退回站点主人那张**
     *  （`fallbackAvatar` 这个入参因此整体删掉了）。 */
    const myAvatar = useMemo(
        () => resolveApiAssetUrl(profile?.avatar || '') || DEFAULT_AVATAR_URL,
        [profile?.avatar],
    )

    const title = (
        <div className="ucTitle">
            <span className="ucTitleText">个人中心</span>
            {admin && (
                <Button
                    size="small"
                    type="link"
                    onClick={() => {
                        onClose()
                        navigate('/dashboard')
                    }}
                >
                    后台管理
                </Button>
            )}
        </div>
    )

    const settingsPane = (
        <div className="ucPane ucSettings">
            <div className="ucAvatarRow">
                <Avatar size={96} src={myAvatar} className="ucAvatar" />
                <div className="ucAvatarMeta">
                    <div className="ucAvatarName">{profile?.nickname || profile?.username || ''}</div>
                    {/* UID 行（20260923 用户要求：加在账号栏上方）。与「账号」同一套样式，
                        令牌解析不出时给「—」，不猜、不编 */}
                    <div className="ucAvatarAccount">UID：{uid ?? '—'}</div>
                    <div className="ucAvatarAccount">账号：{profile?.username || ''}（账号不可修改）</div>
                    <label className="ucUploadBtn">
                        更换头像
                        <input
                            type="file"
                            accept="image/*"
                            onChange={(e) => {
                                const f = e.target.files?.[0]
                                e.target.value = ''
                                if (!f) return
                                if (!f.type.startsWith('image/')) {
                                    message.error('请选择图片文件')
                                    return
                                }
                                handlePickFile(f)
                            }}
                        />
                    </label>
                </div>
            </div>

            <div className="ucField">
                <span className="ucLabel">昵称</span>
                <Input
                    value={nickname}
                    maxLength={20}
                    showCount
                    placeholder="展示用昵称（留言、说说、信箱里显示这个）"
                    onChange={(e) => setNickname(e.target.value)}
                />
                <Button className="ucGoldBtn" type="primary" loading={savingNick} onClick={saveNickname}>
                    保存
                </Button>
            </div>

            <div className="ucField ucFieldStack">
                <span className="ucLabel">修改密码</span>
                <Input.Password
                    value={pwdOld}
                    placeholder="原密码"
                    autoComplete="current-password"
                    onChange={(e) => setPwdOld(e.target.value)}
                />
                <Input.Password
                    value={pwdNew}
                    placeholder="新密码（至少 8 位）"
                    autoComplete="new-password"
                    onChange={(e) => setPwdNew(e.target.value)}
                />
                <Input.Password
                    value={pwdNew2}
                    placeholder="再输一次新密码"
                    autoComplete="new-password"
                    onChange={(e) => setPwdNew2(e.target.value)}
                />
                <div className="ucFieldFoot">
                    <span className="ucHint">改密码不会让其他设备立刻掉线（令牌到期前仍有效）</span>
                    <Button className="ucGoldBtn" type="primary" loading={savingPwd} onClick={savePassword}>
                        修改密码
                    </Button>
                </div>
            </div>
        </div>
    )

    const favoritesPane = (
        <div className="ucPane">
            <List
                loading={loadingTab && favorites === null}
                dataSource={favorites || []}
                locale={{ emptyText: <Empty description="还没有收藏的文章（文章页点「收藏」）" /> }}
                renderItem={(item) => (
                    <List.Item
                        actions={[
                            <Button type="link" key="open" onClick={() => openArticle(item.noteId)}>
                                阅读
                            </Button>,
                            <Button type="link" danger key="del" onClick={() => dropFavorite(item.noteId)}>
                                取消收藏
                            </Button>,
                        ]}
                    >
                        <List.Item.Meta
                            title={
                                <a onClick={() => openArticle(item.noteId)} className="ucItemTitle">
                                    {item.title}
                                </a>
                            }
                            description={`收藏于 ${fmtMinute(item.createdAt)}`}
                        />
                    </List.Item>
                )}
            />
        </div>
    )

    const talksPane = (
        <div className="ucPane">
            <div className="ucPaneBar">
                <span className="ucHint">这里只列河灯留言（说说在「说说」页）</span>
            </div>
            <List
                loading={loadingTab && talks === null}
                dataSource={boardTalks}
                locale={{ emptyText: <Empty description="还没有留言记录" /> }}
                renderItem={(t) => {
                    const st = TALK_STATUS[t.approved] || { text: '未知', color: 'default' }
                    return (
                        <List.Item>
                            <List.Item.Meta
                                title={
                                    <span className="ucItemTitle">
                                        {/* 印章 = **留言的类型**（诉/寄/愿/忆），与灯影集 `.rz-seal`
                                            同款同色（红底暖金字 + 衬线体，见 index.sass `.ucSeal`）。
                                            20260922 用户两轮纠正：① 印章不是留言板的红 → 改成这个红；
                                            ② 印章里该放**类型**、不是"留言板/说说"这种来源标。
                                            审核状态仍是独立的彩色 Tag——通过/待审/未通过是**状态**，
                                            塞进印章里就和类型分不出来了。 */}
                                        {t.cat && <span className="ucSeal" title="河灯留言的类型">{t.cat}</span>}
                                        {/* 20260923：这里原来还渲染 `t.title`，但河灯留言的 title 列
                                            被后端写成了 cat（talks.rs 建行时 title = cat、前端发布传空串）
                                            ⇒ 与印章重复显示了一遍「诉/寄/愿/忆」。印章已是类型，
                                            这行只留正文节选 */}
                                        {t.content ? t.content.slice(0, 24) : '（无标题）'}
                                        <Tag color={st.color}>{st.text}</Tag>
                                    </span>
                                }
                                description={
                                    <div className="ucBody">
                                        <div className="ucBodyText">{t.content}</div>
                                        {/* 驳回理由（20260923）：与灯影集「我的河灯」同源
                                            （都读 talk.reject_reason）。只有未通过才有，
                                            没写理由时如实说「未填写」，不编一句替代 */}
                                        {t.approved === 2 && (
                                            <div className="ucReject">
                                                驳回理由：{t.rejectReason || '未填写'}
                                            </div>
                                        )}
                                        <div className="ucBodyTime">{fmtMinute(t.createdAt)}</div>
                                    </div>
                                }
                            />
                        </List.Item>
                    )
                }}
            />
        </div>
    )

    const noticesPane = (
        <div className="ucPane">
            <div className="ucPaneBar">
                <span className="ucHint">
                    公告在发布时会给你留一条通知；留言审核出结果（通过/驳回）也会发一条，带「去看看」直达那盏灯。
                </span>
                <Button size="small" disabled={!noticeUnread} onClick={() => markNoticesRead()}>
                    全部已读{noticeUnread ? `（${noticeUnread}）` : ''}
                </Button>
            </div>
            <List
                loading={loadingTab && notices === null}
                dataSource={notices || []}
                locale={{ emptyText: <Empty description="暂无公告和通知" /> }}
                renderItem={(n) => (
                    <List.Item
                        actions={[
                            // 有 link 的通知给一颗直达按钮（20260923 起：留言审核结果通知）
                            ...(n.link
                                ? [
                                      <Button className="ucGoBtn" type="link" key="go" onClick={() => openNotice(n)}>
                                          去看看
                                      </Button>,
                                  ]
                                : []),
                            ...(n.isRead
                                ? []
                                : [
                                      <Button type="link" key="read" onClick={() => markNoticesRead([n.id])}>
                                          标记已读
                                      </Button>,
                                  ]),
                        ]}
                    >
                        <List.Item.Meta
                            title={
                                <span className="ucItemTitle">
                                    {!n.isRead && <Badge status="processing" />}
                                    <Tag color={n.type === 'announcement' ? 'geekblue' : 'cyan'}>
                                        {n.type === 'announcement' ? '公告' : '通知'}
                                    </Tag>
                                    {n.title}
                                </span>
                            }
                            description={
                                <div className="ucBody">
                                    <div className="ucBodyText">{n.content}</div>
                                    <div className="ucBodyTime">{fmtMinute(n.createdAt)}</div>
                                </div>
                            }
                        />
                    </List.Item>
                )}
            />
        </div>
    )

    /** 列表行（20260923 用户要求的三行式）：① 「来自 xxx」+ **最右侧是对方发件时间**；
     *  ② 标题；③ 一行正文（以「…」结尾）。整行可点 → 打开占满窗口的详情。 */
    const mailRow = (m: MessageItem, outgoing: boolean) => (
        <List.Item className="ucMailRow" onClick={() => openMail(m, outgoing)}>
            <div className="ucMailRowBox">
                <div className="ucMailHead">
                    <span className="ucMailPeer">
                        {!outgoing && !m.isRead && <Badge status="processing" />}
                        {outgoing ? `发给 ${m.peerName}` : `来自 ${m.peerName}`}
                    </span>
                    <span className="ucMailWhen">{fmtMinute(m.createdAt)}</span>
                </div>
                {/* 老信没有标题这一列（值为 null）⇒ 如实标"（无标题）"，不拿正文首行冒充 */}
                <div className={`ucMailSubject${m.title ? '' : ' isNone'}`}>{m.title || '（无标题）'}</div>
                <div className="ucMailSnippet">{snippet(m.content)}</div>
            </div>
        </List.Item>
    )

    /** 点开的那封信：**占满整个窗口**（用户要求「点开后显示在整个窗口详情」）。
     *  它顶掉整个 .ucPane 的内容（连二级签页一起），所以上方必须留一个返回条。 */
    const mailDetail = (m: MessageItem, outgoing: boolean) => (
        <div className="ucMailDetail">
            <div className="ucMailDetailBar">
                <Button size="small" onClick={() => setOpened(null)}>
                    ← 返回{outgoing ? '发件箱' : '收件箱'}
                </Button>
            </div>
            <div className="ucMailDetailHead">
                <Avatar size={40} src={resolveApiAssetUrl(m.peerAvatar || '')} />
                <div>
                    <div className="ucMailPeer">{outgoing ? `发给 ${m.peerName}` : `来自 ${m.peerName}`}</div>
                    <div className="ucMailWhen">{fmtMinute(m.createdAt)}</div>
                </div>
            </div>
            <div className={`ucMailDetailTitle${m.title ? '' : ' isNone'}`}>{m.title || '（无标题）'}</div>
            <div className="ucMailDetailBody">{m.content}</div>
        </div>
    )

    const composePane = (
        <div className="ucField ucFieldStack ucCompose">
            <span className="ucLabel">写站内信</span>
            <Input
                value={to}
                placeholder="收件人账号或 UID"
                onChange={(e) => setTo(e.target.value)}
            />
            <Input
                value={mailTitle}
                maxLength={60}
                placeholder="信件标题（选填，例如：关于那篇架构文档）"
                onChange={(e) => setMailTitle(e.target.value)}
            />
            {/* ucMsgBody 这层壳只为给计数让位：antd 的 showCount 把「0 / 500」绝对定位在
                输入框**下方约 22px** 处，而 .ucField 的行距只有 12px ⇒ 计数整条被下一行
                （.ucFieldFoot）压住，用户 20260922 反馈的"字数限制文本被遮挡"就是这个。
                壳本身不加任何视觉，只吃一个 margin-bottom（见 index.sass 同名规则）。 */}
            <div className="ucMsgBody">
                <Input.TextArea
                    value={body}
                    rows={3}
                    maxLength={500}
                    showCount
                    placeholder="正文（最多 500 字）"
                    onChange={(e) => setBody(e.target.value)}
                />
            </div>
            <div className="ucFieldFoot">
                <span className="ucHint">
                    {editingDraftId != null
                        ? '正在编辑草稿：发送后这条草稿会自动删除'
                        : '本站不提供用户名录，收件人请填对方的账号或 UID'}
                </span>
                <span className="ucComposeBtns">
                    <Button loading={savingDraft} disabled={sending} onClick={doSaveDraft}>
                        存草稿
                    </Button>
                    <Button className="ucSendBtn ucGoldBtn" type="primary" loading={sending} onClick={doSend}>
                        发送
                    </Button>
                </span>
            </div>
        </div>
    )

    /** 收件箱未读：信箱数据到货就用它，否则先用轮询来的那个数（红点同源） */
    const inboxUnread = mailbox ? mailbox.unread : unreadOf(counts, 'messages')

    const mailboxPane = opened ? (
        <div className="ucPane">{mailDetail(opened.msg, opened.outgoing)}</div>
    ) : (
        <div className="ucPane ucMailPane">
            {/* 四个二级签页（用户要求的顺序）：收件箱 / 发件箱 / 草稿箱 / 写站内信 */}
            <Tabs
                size="small"
                activeKey={mailTab}
                onChange={onMailTabChange}
                items={[
                    {
                        key: 'in',
                        label: `收件箱${inboxUnread ? `（未读 ${inboxUnread}）` : ''}`,
                        children: (
                            <>
                                <div className="ucPaneBar">
                                    <span className="ucHint">
                                        {mailbox?.unread ? `未读 ${mailbox.unread} 封` : '没有未读'}
                                    </span>
                                    <Button size="small" disabled={!mailbox?.unread} onClick={markMailRead}>
                                        全部已读
                                    </Button>
                                </div>
                                <List
                                    loading={loadingTab && mailbox === null}
                                    dataSource={mailbox?.inbox || []}
                                    locale={{ emptyText: <Empty description="收件箱是空的" /> }}
                                    renderItem={(m) => mailRow(m, false)}
                                />
                            </>
                        ),
                    },
                    {
                        key: 'out',
                        label: '发件箱',
                        children: (
                            <List
                                loading={loadingTab && mailbox === null}
                                dataSource={mailbox?.outbox || []}
                                locale={{ emptyText: <Empty description="还没发过站内信" /> }}
                                renderItem={(m) => mailRow(m, true)}
                            />
                        ),
                    },
                    {
                        key: 'drafts',
                        label: `草稿箱${drafts?.length ? `（${drafts.length}）` : ''}`,
                        children: (
                            <>
                                <div className="ucPaneBar">
                                    <span className="ucHint">草稿只有你自己看得到；发送后会自动删除</span>
                                    <Button size="small" onClick={newMail}>
                                        写新信
                                    </Button>
                                </div>
                                <List
                                    loading={loadingTab && drafts === null}
                                    dataSource={drafts || []}
                                    locale={{ emptyText: <Empty description="没有草稿" /> }}
                                    renderItem={(d) => (
                                        <List.Item
                                            // 草稿行**不是**可点开的信（没有详情），单独一个类名
                                            // 既是排版钩子也是测试钩子（别复用 .ucMailRow 的 pointer）
                                            className="ucDraftRow"
                                            actions={[
                                                <Button type="link" key="edit" onClick={() => continueDraft(d)}>
                                                    继续写
                                                </Button>,
                                                <Button type="link" danger key="del" onClick={() => dropDraft(d.id)}>
                                                    删除
                                                </Button>,
                                            ]}
                                        >
                                            <div className="ucMailRowBox">
                                                <div className="ucMailHead">
                                                    <span className="ucMailPeer">
                                                        {d.toUsername ? `发给 ${d.toUsername}` : '（还没填收件人）'}
                                                    </span>
                                                    <span className="ucMailWhen">{fmtMinute(d.updatedAt)}</span>
                                                </div>
                                                <div className={`ucMailSubject${d.title ? '' : ' isNone'}`}>
                                                    {d.title || '（无标题）'}
                                                </div>
                                                <div className="ucMailSnippet">{snippet(d.content)}</div>
                                            </div>
                                        </List.Item>
                                    )}
                                />
                            </>
                        ),
                    },
                    { key: 'compose', label: '写站内信', children: composePane },
                ]}
            />
        </div>
    )

    return (
        <ConfigProvider
            theme={{
                algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
                token: { colorPrimary: isDark ? '#aec8c8' : '#1677ff' },
            }}
        >
            <Modal
                open={open}
                onCancel={onClose}
                footer={null}
                width={860}
                centered
                title={title}
                // 弹窗挂在 body 下，拿不到 .frontDark 祖先 ⇒ 由 rootClassName 自带主题类
                rootClassName={`ucRoot${isDark ? ' ucDark' : ''}`}
                // 标题栏底下现在有一条分割线（见 index.sass），正文别再贴着它
                styles={{ body: { paddingTop: 12 } }}
                // 关窗后**保留**挂载状态：五个页签的数据缓存还在，再打开不必重拉
                // （数据陈旧由"每次打开重拉 profile"+ 各页签的显式刷新兜底）
                destroyOnClose={false}
            >
                {!loggedIn ? (
                    <Empty description="请先登录" />
                ) : (
                    <Tabs
                        activeKey={tab}
                        onChange={onTabChange}
                        items={[
                            { key: 'settings', label: '用户设置', children: settingsPane },
                            {
                                key: 'favorites',
                                label: `收藏的文章${favorites ? `（${favorites.length}）` : ''}`,
                                children: favoritesPane,
                            },
                            {
                                key: 'talks',
                                label: '留言记录',
                                children: talksPane,
                            },
                            {
                                key: 'notices',
                                label: (
                                    <Badge count={unreadOf(counts, 'notifications')} size="small" offset={[8, -2]}>
                                        公告和通知
                                    </Badge>
                                ),
                                children: noticesPane,
                            },
                            {
                                key: 'mailbox',
                                label: (
                                    <Badge count={unreadOf(counts, 'messages')} size="small" offset={[8, -2]}>
                                        站内信箱
                                    </Badge>
                                ),
                                children: mailboxPane,
                            },
                        ]}
                    />
                )}
            </Modal>

            <AvatarCropModal
                open={cropOpen}
                file={cropFile}
                uploading={uploading}
                dark={isDark}
                onPickFile={handlePickFile}
                onConfirm={handleCropConfirm}
                onCancel={() => {
                    setCropOpen(false)
                    setCropFile(null)
                }}
            />
        </ConfigProvider>
    )
}

export default UserCenter

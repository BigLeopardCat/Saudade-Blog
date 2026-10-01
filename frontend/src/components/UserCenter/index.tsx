/**
 * 个人中心（20260922 一期）：点头部登录卡里的「设置」打开的大窗口（按钮 20260922 晚改名）。
 *
 * 五个页签（用户原话的顺序）：用户设置 / 收藏的文章 / 留言记录 / 公告和通知 / 站内信箱。
 * 「站内信箱」自己还有四个二级签页（20260923 用户要求）：收件箱 / 发件箱 / 草稿箱 / 写站内信——
 * 写信表单不再是常驻在信箱顶部的一块，而是其中一个签页；点开某封信则**占满整个窗口**显示详情。
 *
 * 几个刻意的设计决定（改动前先读这几条）：
 *   · **数据按页签懒加载**：打开窗口只拉"用户设置"，其余页签首次点开才请求。个人中心是
 *     低频入口，一次点开发五个请求不好——但**通知/私信的红点不受影响**，它由 unread.ts
 *     那个模块级 store 负责（与头部头像上的红点共用同一份读数与同一个轮询，见 unread.ts）。
 *   · **不做乐观更新**：收藏/已读/发信都等后端回包再改界面。这族接口在"没做成"时返回的
 *     是 HTTP 200 + code=500 + 中文原因（见 apis/ProfileMethods.tsx 头注），乐观更新会
 *     出现"界面说成了、其实没成"的假象——比慢一点糟得多。
 *   · **时间一律字符串截断展示**（后端已是 +08:00 本地钟面）：不构造 Date，就不可能出现
 *     浏览器时区二次偏移（AnnouncementModal 上踩过：多 8 小时）。
 *   · **管理员多一个「后台管理」入口**：个人中心对所有人开（普通用户过去点那个旧钮会被
 *     AuthRouter 弹回首页），后台入口改由窗口头部提供，管理员的路径没有丢。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Avatar, Badge, Button, ConfigProvider, Empty, Input, List, Modal, Tabs, Tag, message, theme as antdTheme } from 'antd'
import { useNavigate } from 'react-router-dom'
import getToken from '../../apis/getToken.tsx'
import { getRoleFromToken, getTokenClaims, isAdminToken, roleLabel, roleTagColor } from '../../utils/auth.ts'
import { quotaBalanceText, quotaLevel, quotaPct, quotaUsedHint } from '../../utils/quota.ts'
import { resolveApiAssetUrl } from '../../utils/runtimeApi'
import { useIsDarkMode } from '../../theme'
// 层级走全站阶梯（src/index.css 的 :root 定义、src/zIndex.ts 是它的 TS 镜像）。
// antd 只认 `zIndex` prop，CSS 变量递不进去，所以这里必须用 TS 那份。
import { Z } from '../../zIndex'
import {
    applyQuotaReset,
    changePassword,
    deleteDraft,
    errMsg,
    getDrafts,
    getMailbox,
    getMyQuota,
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
    Mailbox,
    MessageDraft,
    MessageItem,
    MyTalk,
    NotificationItem,
    ProfileInfo,
    QuotaInfo,
    UnreadSummary,
} from '../../interface/ProfileType'
import AvatarCropModal from '../AvatarCropModal'
import { DEFAULT_AVATAR_URL } from './identity'
import { notifyUnreadChanged, useUnread } from './unread'
import { applyLocalFavorite, useFavorites } from './favorites'
import { AGENT_TURN_DONE_EVENT } from './agentTurn'
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
    const [mailbox, setMailbox] = useState<Mailbox | null>(null)
    /** 对话额度（20260929）：null = 还没拉过。**这个数每一轮对话都在变**，所以
     *  `agent-turn-done` 那条 effect 必须带上它（见下面那段注释）。 */
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
            // 收藏**不在这里拉**：它是共享状态（详情页那颗★看的是同一份），由 useFavorites
            // 按「这一刻真的在看收藏」自己拉并订阅变化。这里再拉一次就是两份状态——
            // 正是 20260923 这轮修掉的洞（favorites.ts 头注）。
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
            } catch (e) {
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

    /* 看板娘一轮对话收尾（chat-stream.js 派发，见 agentTurn.ts）：agent 可能刚把通知/站内信
       标成已读、或改过别的账 ⇒ **已经加载过的**页签当场重拉一次。
       只重拉加载过的（`null` = 用户还没点开过，别替他拉——同懒加载纪律）；没加载过的下次
       点开时自然拿到最新的。收藏页签不在这里管（共享状态自己订阅了同一个事件）。
       20260924：此前**只有收藏**订阅了这个事件 ⇒ 通知/信箱/说说/草稿都得刷新网页才更新
       （用户实测反馈：让 agent 标已读，列表与红点都纹丝不动）。
       20260929 额度页签也要进来：**额度是这里唯一每轮都在动的数据**（每问一句 used+1），
       不重拉就会出现"刚问完一句，额度页还写着用完之前的数"——而且它正是决定"还能不能问"
       的那个数，显示陈旧比显示齐全更要紧。
       ⚠️ 打开着的那封信（`opened`）是快照，不跟着重拉——它不在"列表该不该新"这个问题里。 */
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

    /* 开窗与换页签：**当前页签重拉一次**（20260925 用户实测反馈——agent 发了公告，个人中心与
       头像都提示有新消息，但公告列表不刷新，要整页刷新才看得到）。根因是列表数据只在两个时刻
       拉：首次点开（`x === null` 那道门）与**窗开着时**收到 agent-turn-done —— agent 多半是在
       窗关着的时候发的公告，那时上面那个订阅根本没挂上；而本组件是常驻挂载的（`open` 只控
       显示），重开窗口也不会重新加载 ⇒ 事件与懒加载两道门一起把这次更新漏掉。
       只重拉当前页签：其余页签保持懒加载纪律（没点开过的不替主人拉，点开它们时仍走这里）。
       ⚠️ 依赖里**不能放 `loadTab`**：它随 talks/notices/mailbox 换身份，放进去就是
       「重拉 → 数据变 → 身份变 → 再重拉」的自激环，故经 `loadTabRef` 取最新一版。 */
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
                // 换掉本机的令牌（20260926）：改密码已经让**所有**旧令牌失效了，
                // 包括本机手里这枚。不写回的话，本机的下一个请求就会带着一枚
                // 刚被自己作废的令牌出去 ⇒ 立刻被登出。
                const fresh = res.data.data?.token
                if (fresh) localStorage.setItem('tokenKey', fresh)
                message.success('密码已修改，其他设备上的登录状态已全部失效')
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
                // 写入成功 ⇒ 交给共享状态（列表当场摘掉那一行 + 详情页那颗★同时变）
                applyLocalFavorite(noteId, false)
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
                    <div className="ucAvatarName">
                        {/* 昵称自己一层 `.ucNickName`（20260926 加身份标签时顺手包的）：
                            标签进来之后 `.ucAvatarName` 的 inner_text 变成「昵称 标签」两段，
                            按这个容器取昵称的断言（前端沙箱里那几条"保存后昵称跟着变"）
                            会一起把标签读进去。容器仍是行盒，样式不变。 */}
                        <span className="ucNickName">{profile?.nickname || profile?.username || ''}</span>
                        {/* 权限身份标签（20260926 用户点名：「用户昵称后面显示权限身份标签」）。
                            角色取 **profile** 而不是令牌 claims：令牌里的 role 是签发那一刻的
                            快照，被人改过角色之后旧令牌会一直自称旧角色（前端标签会骗人）。
                            profile 拉不到时（老后端/请求失败）回退令牌——比不显示强，
                            且它只影响这一个标签，不参与任何权限判断。 */}
                        <Tag
                            className="ucRoleTag"
                            color={roleTagColor(effectiveRole)}
                            style={{ marginLeft: 8 }}
                        >
                            {roleLabel(effectiveRole)}
                        </Tag>
                    </div>
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
                <Button className="ucPrimaryBtn" type="primary" loading={savingNick} onClick={saveNickname}>
                    保存
                </Button>
            </div>

            {/* 关窗即从 DOM 摘掉这三个密码框（20260924）。
                为什么非摘不可：Chrome 的密码管理器对**判定为凭据**的字段忽略
                `autocomplete="off"`，而**页面里没有任何 `<form>` 时，它会把整页散落的
                输入框当成一个合成表单**——于是"页面上还有个密码框"就等于"本页是登录页"，
                它便去回填页面上最"裸"的文本框。实测（20260924）：看板娘对话框的会话
                检索框、展示柜的向量检索框都被填上了账号；给那些框补 `name` 和四个厂商
                `data-*-ignore` 标记一律无效（20260923 已在 `wg-input` 上试过，照样被填）。
                本弹窗刻意 `destroyOnClose={false}`（保住五个页签的数据缓存），所以设置
                页签一旦打开过，这三个框就永久留在首页 DOM 里 ⇒ 摘挂只能由这里按开合状态做。
                只影响这三个框：关窗时它们的输入值（pwd*）本来就该作废，页签缓存不受影响。 */}
            {open && (
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
                        <span className="ucHint">改密码会让其他设备立刻下线（本机保持登录）</span>
                        <Button className="ucPrimaryBtn" type="primary" loading={savingPwd} onClick={savePassword}>
                            修改密码
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )

    const favoritesPane = (
        <div className="ucPane">
            <List
                loading={favorites === null && !favFailed}
                dataSource={favorites || []}
                locale={{
                    emptyText: favFailed && favorites === null
                        // 读不到 ≠ 没有收藏（同一族谎，见 favorites.ts 的 failed）
                        ? <Empty description="收藏列表没读到（网络或登录状态问题），过一会儿再打开看看" />
                        : <Empty description="还没有收藏的文章（文章页点「收藏」）" />,
                }}
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

    // ── 对话额度（20260929）─────────────────────────────────────────────────

    /** 提交重置申请。**回包只有一句中文**（新申请的行 id 不在响应里，也不该在前端
     *  自己编一条 pending 状态出来）：成功后**重读一次额度**，界面上的"待处理"那一块
     *  是从后端读来的事实，不是本地推断。 */
    const doApplyQuota = async () => {
        if (applying) return
        setApplying(true)
        try {
            const res = await applyQuotaReset(applyReason.trim())
            if (!ok(res)) {
                message.error(errMsg(res))
                return
            }
            // **`data` 而不是 `message`**：`ApiResponse::success` 的 `message` 恒为字面量
            // "ok"（见 src/utils.rs），照抄它弹出来的就是那个 "ok"（后台账号页踩过同一坑）。
            message.success(res.data.data || '已提交对话额度重置申请')
            setApplyOpen(false)
            setApplyReason('')
            // 写后重读：拿不到就保留旧读数（不本地拼一条"已提交"）
            const after = await getMyQuota()
            if (ok(after)) setQuota(after.data.data)
        } catch (e) {
            message.error('网络异常，请稍后再试')
        } finally {
            setApplying(false)
        }
    }

    /** 额度进度：**只作视觉**（真正的两个数是旁边那几个字）。不限档不画条——
     *  `limit` 是 0，画出来是一条"0% 的空条"，看着像额度用光了。
     *
     *  20260929 第二批改口径：**画的是余额**（剩多少占上限多少），不是"用掉多少占上限
     *  多少"。此前画的是 `used/limit`，于是新账号开局就是一条空条、用到一半是半条
     *  ——读起来像"进度条卡住了"，而它其实是**反着的**（条越长=用得越多=越该着急）。
     *  减法与阈值都在 `utils/quota.ts` 一处（四处显示共用），这里只取宽度与档位。 */
    const quotaBarPct = quotaPct(quota?.remaining, quota?.limit)
    /** 档位 → 类名后缀。`null`（读不到）与 `unlimited` 都不上色（条本身也不画）。 */
    const quotaLv = quotaLevel(quota?.remaining, quota?.limit)

    const quotaPane = (
        <div className="ucPane">
            <div className="ucPaneBar">
                <span className="ucHint">
                    每轮对话算 1 轮（含检索）；用完就答不了了。这里提交的重置申请要管理员批准，
                    批准后会通过站内通知告诉你。
                </span>
                {/* 与其余页签 `.ucPaneBar` 里那颗同级（`size="small"` 默认按钮）——
                    `.ucPrimaryBtn` 只对 `type="primary"` 生效（见 index.sass），挂上去是个空类 */}
                <Button
                    size="small"
                    disabled={quota === null || !!quota?.pendingRequest}
                    onClick={() => setApplyOpen(true)}
                >
                    {quota?.pendingRequest ? '已提交申请' : '申请重置'}
                </Button>
            </div>
            {quota === null ? (
                <Empty description={loadingTab ? '读取中…' : '额度读不出来'} />
            ) : (
                <div className="ucQuota">
                    <div className="ucQuotaHead">
                        {/* **主角是余额**（20260929 用户要求："500 开始减少，而不是 0 开始计数"）。
                            不限档显示「不限额」而不是「0/0」：那是内部表示，不是给人看的话。
                            三个数各自说各自的事实：余额（大数）/ 已用（副提示）/ 上限（明写在余额里）。 */}
                        <span className="ucQuotaNums">
                            {quotaBalanceText(quota.remaining, quota.limit)}
                        </span>
                        <span className="ucQuotaHint">
                            {quota.unlimited ? '管理员账号不限额' : quotaUsedHint(quota.used, quota.limit)}
                        </span>
                    </div>
                    {!quota.unlimited && (
                        <div className="ucQuotaBar">
                            <div
                                className={`ucQuotaBarIn${quotaLv ? ` is-${quotaLv}` : ''}`}
                                style={{ width: `${quotaBarPct}%` }}
                            />
                        </div>
                    )}
                    <div className="ucQuotaReq">
                        {quota.pendingRequest ? (
                            <>
                                <div className="ucQuotaReqTitle">已提交重置申请，等管理员处理</div>
                                <div className="ucBodyText">
                                    理由：{quota.pendingRequest.reason || '（没填）'}
                                </div>
                                <div className="ucBodyTime">{fmtMinute(quota.pendingRequest.createdAt)}</div>
                            </>
                        ) : (
                            <div className="ucQuotaHint">没有待处理的申请</div>
                        )}
                    </div>
                </div>
            )}
        </div>
    )

    /** 对方的头像：**没上传过就落到站点默认头像**。两个要点：
     *  ① 用 `|| DEFAULT_AVATAR_URL` 而不是 `??`——Rust 侧 `peer_avatar` 的真形状是
     *     `Option<String>`，没设过头像时给的是**空串**；`resolveApiAssetUrl('')` 也返回 ''
     *     （falsy 直通），于是 antd 的 Avatar 拿到 `src=""` 会渲染一个坏 `<img>`：
     *     既不显示默认头像、也不会退回文字兜底 —— 用户看到的就是"显示的不是默认头像"。
     *  ② 传的是**根相对路径**（/default-avatar.png），线上/沙箱都由 HTTP 取到该文件。 */
    const peerAvatar = (m: MessageItem) =>
        <Avatar className="ucMailAvatar" size={40}
                src={resolveApiAssetUrl(m.peerAvatar || '') || DEFAULT_AVATAR_URL} />

    /** 列表行（20260923 用户要求的三行式）：① 「来自 xxx」+ **最右侧是对方发件时间**；
     *  ② 标题；③ 一行正文（以「…」结尾）。整行可点 → 打开占满窗口的详情。
     *  20260927 起行首补对方头像（发件箱是收件人的头像）——一列信扫下来先认脸。 */
    const mailRow = (m: MessageItem, outgoing: boolean) => (
        <List.Item className="ucMailRow" onClick={() => openMail(m, outgoing)}>
            {peerAvatar(m)}
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
                {/* 文案里不带「←」：按钮本身就是那个形状，前面再顶一个箭头是同一件事
                    说两遍（与后台按钮去「+」同一条约定，20260927 用户要求）。 */}
                <Button size="small" onClick={() => setOpened(null)}>
                    返回{outgoing ? '发件箱' : '收件箱'}
                </Button>
            </div>
            <div className="ucMailDetailHead">
                {peerAvatar(m)}
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
            {/* 这层壳只为给计数让位：antd 的 showCount 把「0 / 500」绝对定位在
                输入框**下方约 22px** 处（不占布局空间），而 .ucField 的行距只有 12px
                ⇒ 计数整条被下一行（.ucFieldFoot）压住，用户 20260922 反馈的"字数限制
                文本被遮挡"就是这个。壳本身不加任何视觉。
                20260929 起这 22px 收到全局的 `.counter-room` 一处（src/index.css），
                额度申请那个 Modal 与 compose 共用它——各写一份就是"改一处必须同步
                另一处"的形状。 */}
            <div className="counter-room">
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
                    <Button className="ucSendBtn ucPrimaryBtn" type="primary" loading={sending} onClick={doSend}>
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
                // 主色跟着手账皮走（= --washi-pink-deep 的深浅两档）。此前夜间那档是
                // `#aec8c8` 灰绿——它本是给浅色主题挑的，当主色的结果是页签墨条、
                // 输入框聚焦环、链接全都灰扑扑的。antd 的派生色（hover/active）是
                // JS 算出来的，**不能**写成 var(--washi-*)，只能照抄这两个字面量。
                token: { colorPrimary: isDark ? '#ff8ec7' : '#d94f9a' },
            }}
        >
            <Modal
                open={open}
                onCancel={onClose}
                footer={null}
                width={860}
                centered
                title={title}
                // 个人中心要盖住看板娘面板（agent 仓 widget.css 的 #waifu，同阶梯的
                // `--z-agent`），但要在公告弹窗之下。antd 默认的 zIndexPopupBase 是 1000，
                // 与看板娘同值、胜负由 DOM 顺序决定 —— 那是巧合不是设计。
                zIndex={Z.panel}
                // 弹窗挂在 body 下，拿不到 .frontDark 祖先 ⇒ 由 rootClassName 自带主题类。
                // 两个深色类名分工不同、都要挂：`.ucDark` 是本组件自己的夜间补偿
                // （见 index.sass 尾段），`.washiDark` 是那套手账令牌的名字
                // （值在 src/index.css，只是深色档多认这一个类名）。
                rootClassName={`ucRoot${isDark ? ' ucDark washiDark' : ''}`}
                // 标题栏底下现在有一条分割线（见 index.sass），正文别再贴着它
                styles={{ body: { paddingTop: 12 } }}
                // 关窗后**保留**挂载状态：五个页签的数据缓存还在，再打开不必重拉
                // （数据陈旧由"每次打开重拉 profile"+ 各页签的显式刷新兜底）
                destroyOnClose={false}
                // forceRender 是上面那条"关窗摘密码框"能生效的**前提**，不是性能选项：
                // rc-dialog 的 children 被 MemoChildren 包着，判据是
                // `shouldUpdate = visible || forceRender` —— 关窗时 shouldUpdate=false，
                // **整棵 children 会冻结成"最后一次可见时"的快照**，于是任何 `{open && …}`
                // 在关窗那一刻都不会被应用。实测（20260924 user-center 沙箱）：wrap 已经
                // display:none、三个密码框却照样留在 DOM 里。加它之后 children 在关窗态
                // 也保持可更新；代价只是弹窗内容在页面加载时先渲染一次（隐藏态，各页签的
                // 请求仍由 open 门控，不发请求）。
                forceRender
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
                            // 第六个页签（20260929）。**不带角标**：额度不是"有事没看"
                            // （红点只属于通知与私信，见 unread.ts），页签里那个数每分钟都在动，
                            // 拿它当角标等于把一个恒亮的灯挂在页签上。
                            { key: 'quota', label: '对话额度', children: quotaPane },
                        ]}
                    />
                )}
            </Modal>

            {/* 申请重置的弹窗。**受控 `open`、不用 `{applyOpen && …}` 条件渲染**——
                上面那个 Modal 的 `forceRender` 是为了让关窗态下 children 仍可更新
                （见那段注释），而条件渲染出来的是一个"只能在可见时存在"的子树，
                两者放一起会让关窗那一刻的状态与所见不一致。理由可空：后端把空串落 NULL，
                这里不替主人编一句理由（与站内信"标题（选填）"同一条）。 */}
            <Modal
                open={applyOpen}
                title="申请重置对话额度"
                okText="提交申请"
                cancelText="再想想"
                confirmLoading={applying}
                onOk={doApplyQuota}
                onCancel={() => setApplyOpen(false)}
                // 叠在个人中心**之上**一档。理由与下面那个头像裁剪弹窗完全一样：本 Modal
                // 是个人中心那个 Modal 的**兄弟节点**，antd 的 `useZIndex` 只在同一 React
                // 子树里继承父级 ⇒ 不给值就落回默认的 1000、被 1200 的父亲压住。
                // 顺带也解决了遮罩打架（同值的话后一块只是把前一块再压暗一层，像"页面变黑"）。
                zIndex={Z.panel + 1}
                // 同上：`ucDark` 管本组件的夜间补偿、`washiDark` 管手账令牌
                rootClassName={`ucRoot${isDark ? ' ucDark washiDark' : ''}`}
                width={520}
            >
                <div className="ucField ucFieldStack">
                    <span className="ucLabel">申请理由（选填）</span>
                    <div className="counter-room">
                        <Input.TextArea
                            value={applyReason}
                            rows={3}
                            // 上限与后端 REASON_MAX 一致。后端超限是**拒绝**而不是截断
                            // （截断会让主人核对的是这一句、库里存的是另一句），
                            // 这里的 maxLength 只是不让主人撞上那句拒绝。
                            maxLength={500}
                            showCount
                            placeholder="例如：想接着问那篇架构文档的问题"
                            onChange={(e) => setApplyReason(e.target.value)}
                        />
                    </div>
                    {/* 措辞是「额度恢复到上限」而不是「额度清零」（20260929 用户指出）：
                        主人看到的是**递减的余额**，他的心智模型是"额度用光了"；"计数器清零"
                        描述的是库里的实现（`chat_quota_used = 0`），不是他看到的那个东西。
                        同一说法在通知、后台确认卡、agent 侧一并统一（跨语言契约）。 */}
                    <span className="ucHint">
                        管理员批准后额度恢复到上限，你立刻可以继续问；驳回的话额度不变，还能再申请。
                    </span>
                </div>
            </Modal>

            <AvatarCropModal
                open={cropOpen}
                file={cropFile}
                uploading={uploading}
                dark={isDark}
                // 与上面申请额度那个弹窗同一档：都是从个人中心窗口里开出来的第二层。
                // **本组件是那个 Modal 的兄弟节点，不是它的子节点** ⇒ antd 的 zIndex
                // 继承链够不着它（`useZIndex` 只认同一 React 子树里的 `zIndexContext`），
                // 不写这一行它就落回默认的 1000、被 1200 的父亲压在下面（看着在、点不动）。
                zIndex={Z.panel + 1}
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

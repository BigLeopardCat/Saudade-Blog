/**
 * 个人中心（20260922 一期）：点头部登录卡里的「设置」打开的大窗口（按钮 20260922 晚改名）。
 *
 * 五个页签（用户原话的顺序）：用户设置 / 收藏的文章 / 留言记录 / 公告和通知 / 站内信箱。
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
import { isAdminToken } from '../../utils/auth.ts'
import { resolveApiAssetUrl } from '../../utils/runtimeApi'
import { useIsDarkMode } from '../../theme'
import {
    changePassword,
    errMsg,
    getFavorites,
    getMailbox,
    getMyTalks,
    getNotifications,
    getProfile,
    ok,
    readMessages,
    readNotifications,
    removeFavorite,
    sendMessage,
    updateNickname,
    uploadAvatar,
} from '../../apis/ProfileMethods.tsx'
import type {
    FavoriteItem,
    Mailbox,
    MyTalk,
    NotificationItem,
    ProfileInfo,
    UnreadSummary,
} from '../../interface/ProfileType'
import AvatarCropModal from '../AvatarCropModal'
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

interface UserCenterProps {
    open: boolean
    onClose: () => void
    /** 站点主人头像：自己没设头像时的展示回退（与头部/文章页一致） */
    fallbackAvatar?: string
}

const UserCenter = ({ open, onClose, fallbackAvatar }: UserCenterProps) => {
    const isDark = useIsDarkMode()
    const navigate = useNavigate()
    const loggedIn = !!getToken()
    const admin = isAdminToken(getToken())
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

    // ── 信箱 ────────────────────────────────────────────────────────────────

    const doSend = async () => {
        if (!to.trim()) {
            message.error('请填写收件人账号')
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
            } else {
                message.error(errMsg(res, '发送失败'))
            }
        } catch (e) {
            message.error('网络异常，请稍后再试')
        } finally {
            setSending(false)
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

    const myAvatar = useMemo(
        () => resolveApiAssetUrl(profile?.avatar || '') || fallbackAvatar || '',
        [profile?.avatar, fallbackAvatar],
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
                <Button type="primary" loading={savingNick} onClick={saveNickname}>
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
                    <Button type="primary" loading={savingPwd} onClick={savePassword}>
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
                                        {t.title || (t.content ? t.content.slice(0, 24) : '（无标题）')}
                                        <Tag color={st.color}>{st.text}</Tag>
                                    </span>
                                }
                                description={
                                    <div className="ucBody">
                                        <div className="ucBodyText">{t.content}</div>
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
                    公告在发布时会给你留一条通知；站内通知（回复提醒等）后续开放，接口已就位。
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
                        actions={
                            n.isRead
                                ? []
                                : [
                                      <Button type="link" key="read" onClick={() => markNoticesRead([n.id])}>
                                          标记已读
                                      </Button>,
                                  ]
                        }
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

    const mailboxPane = (
        <div className="ucPane">
            <div className="ucField ucFieldStack ucCompose">
                <span className="ucLabel">写站内信</span>
                <Input
                    value={to}
                    placeholder="收件人账号（或唯一昵称）"
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
                    <span className="ucHint">本站不提供用户名录，收件人请直接填对方账号</span>
                    <Button className="ucSendBtn" type="primary" loading={sending} onClick={doSend}>
                        发送
                    </Button>
                </div>
            </div>
            <Tabs
                size="small"
                items={[
                    {
                        key: 'in',
                        label: `收件箱${unreadOf(counts, 'messages') ? `（未读 ${counts.messages}）` : ''}`,
                        children: (
                            <>
                                <div className="ucPaneBar">
                                    <span className="ucHint">{mailbox?.unread ? `未读 ${mailbox.unread} 封` : '没有未读'}</span>
                                    <Button size="small" disabled={!mailbox?.unread} onClick={markMailRead}>
                                        全部已读
                                    </Button>
                                </div>
                                <MailList items={mailbox?.inbox || []} loading={loadingTab && mailbox === null} />
                            </>
                        ),
                    },
                    {
                        key: 'out',
                        label: '发件箱',
                        children: (
                            <MailList
                                items={mailbox?.outbox || []}
                                loading={loadingTab && mailbox === null}
                                outgoing
                            />
                        ),
                    },
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

/** 信箱列表（收/发件箱共用；outgoing 只影响"未读"是否展示） */
const MailList = ({
    items,
    loading,
    outgoing,
}: {
    items: Mailbox['inbox']
    loading?: boolean
    outgoing?: boolean
}) => (
    <List
        loading={loading}
        dataSource={items}
        locale={{ emptyText: <Empty description={outgoing ? '还没发过站内信' : '收件箱是空的'} /> }}
        renderItem={(m) => (
            <List.Item>
                <List.Item.Meta
                    avatar={<Avatar src={resolveApiAssetUrl(m.peerAvatar || '')} />}
                    title={
                        <span className="ucItemTitle">
                            {!outgoing && !m.isRead && <Badge status="processing" />}
                            {outgoing ? `发给 ${m.peerName}` : `来自 ${m.peerName}`}
                            {/* 信件标题（20260922 起）：老信没有这一列 ⇒ 值为 null，
                                如实标"（无标题）"，不拿正文首行冒充标题 */}
                            <span className={`ucMailSubject${m.title ? '' : ' isNone'}`}>
                                {m.title || '（无标题）'}
                            </span>
                        </span>
                    }
                    description={
                        <div className="ucBody">
                            <div className="ucBodyText">{m.content}</div>
                            <div className="ucBodyTime">{fmtMinute(m.createdAt)}</div>
                        </div>
                    }
                />
            </List.Item>
        )}
    />
)

export default UserCenter

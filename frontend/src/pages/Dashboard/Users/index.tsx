import './index.sass'
import { Button, Dropdown, Input, message, Modal, Radio, Tabs, Tag, Tooltip } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { TabsProps } from 'antd';
import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import BoardManage from '../BoardManage';
import CommentManage from '../CommentManage';
import QuotaManage from '../QuotaManage';
import http from "../../../apis/axios.tsx";
import { useLiveRefresh } from "../../../utils/liveRefresh.ts";
import { invalidateTempUsers, refreshTempUsers, useTempUsers, type TempUser } from "./tempUsers.ts";
import { quotaChipText, quotaLevel, type QuotaLevel } from "../../../utils/quota.ts";
import { ROLE_LABEL, roleLabel, getRoleFromToken, getUidFromToken, canManageCredentials } from "../../../utils/auth.ts";
import {useAuthToken, getLiveAuthToken} from "../../../utils/useAuthToken";
import { RoleBadge } from "../../../components/RoleBadge";

// The initial tab accepts review/comment/quota deep links; account filters stay above the scroll area.

/** 账号是否已冻结。判据与后端 `crate::authz::is_frozen` **同一条**：
 *  `user.status` 里不是 0 的一律算冻结（未登记的取值也按冻结处理，不默认放行）。
 *  `undefined`（字段缺失）按 0 算——缺失只可能出现在"前端已上线、后端还没"这种
 *  部署顺序里，而这两半是同一次部署、迁移先跑，所以它不该发生；
 *  真发生了也宁可少标一个"冻结"（后端照样会拒它），而不是把整页账号标成冻结。
 *  这里刻意不做「=== 1 才算冻结」：那会与后端对不上，后端认的是 != 0。 */
const isFrozen = (u: any) => Number(u.status ?? 0) !== 0

const isMuted = (u: any) => !!u.muted

const MUTE_FOREVER = '9999-12-31 23:59:59'
const muteUntilText = (v?: string | null) => {
    if (!v) return ''
    if (v >= MUTE_FOREVER) return '永久'
    return v.slice(0, 16) // 去掉秒：列表里到分钟足够
}

/** 禁言时长选项（小时）。**`0` = 永久**（后端认 `null` / `<=0` 为永久，
 *  见 `SetMuteReq`）——列表里放一个"永久"选项比让管理员自己算小时数清楚得多。
 *  默认选 24 小时：最常见的处置是"先关一天看看"，而最不该成为默认的是永久。 */
const MUTE_DURATIONS: { hours: number; label: string }[] = [
    { hours: 1, label: '1 小时' },
    { hours: 24, label: '24 小时' },
    { hours: 24 * 7, label: '7 天' },
    { hours: 0, label: '永久' },
]

const ACC_FILTERS: { key: string; label: string; match: (u: any) => boolean }[] = [
    { key: 'all', label: '全部', match: () => true },
    { key: 'admin', label: '管理员账号', match: (u) => u.role === 'admin' },
    { key: 'user', label: '普通用户账号', match: (u) => u.role !== 'admin' },
    { key: 'frozen', label: '冻结账号', match: (u) => isFrozen(u) },
]

const ASSIGNABLE_ROLES: { role: string; rank: number }[] = [
    { role: 'zako', rank: -2 },
    { role: 'user', rank: 0 },
    { role: 'admin', rank: 2 },
]
const roleRank = (role?: string | null) =>
    ASSIGNABLE_ROLES.find((r) => r.role === role)?.rank ?? -1

const ADMIN_ROLE_TIERS: string[] = ['user', 'zako']

const quotaChip = (u: any): { text: string; level: QuotaLevel | null } => {
    const lim = u?.chatQuotaLimit
    const used = u?.chatQuotaUsed
    if (typeof lim !== 'number' || typeof used !== 'number') {
        return { text: '额度 —', level: null }
    }
    return { text: quotaChipText(used, lim), level: quotaLevel(lim - used, lim) }
}

/** 缓存还没到手时的占位**空数组常量**。必须是模块级同一个引用：写成 `?? []`
 *  会在每次渲染造一个新数组，把下面 `filteredUsers` 的 memo 每次都打穿。 */
const NO_USERS: TempUser[] = []

const Users = () => {
    const [searchParams] = useSearchParams()
    const [tab, setTab] = useState(() => {
        const t = searchParams.get('tab')
        return t === 'review' || t === 'comment' || t === 'quota' ? t : 'accounts'
    })

    const { users: cachedUsers, failed: usersFailed } = useTempUsers(tab === 'accounts')
    /** 给下面那几处渲染用的数组形态。`null`（还没成功读到过）不能塌成 `[]`——
     *  "读不到"与"读到了、确实是空的"是两件事，塌掉之后占位文案就只剩"暂无账号"
     *  一种说法了（本仓已经栽过这个谎）。空态的三分法见列表那一段。 */
    const tempUsers = cachedUsers ?? NO_USERS
    const [tempUsername, setTempUsername] = useState('')
    const [tempPassword, setTempPassword] = useState('')
    const [pwModalOpen, setPwModalOpen] = useState(false)
    const [pwTarget, setPwTarget] = useState<any>(null)
    const [pwNewPassword, setPwNewPassword] = useState('')
    const [recoveryModalOpen, setRecoveryModalOpen] = useState(false)
    const [recoveryTarget, setRecoveryTarget] = useState<any>(null)
    const [recoveryCode, setRecoveryCode] = useState('')
    const [accFilter, setAccFilter] = useState('all')
    const [accQuery, setAccQuery] = useState('')

    const filteredUsers = useMemo(() => {
        const f = ACC_FILTERS.find((x) => x.key === accFilter) ?? ACC_FILTERS[0]
        const q = accQuery.trim().toLowerCase()
        return tempUsers.filter((u) => f.match(u)
            && (q === ''
                || String(u.username ?? '').toLowerCase().includes(q)
                || String(u.id ?? '').includes(q)))
    }, [tempUsers, accFilter, accQuery])

    const handleCreateTempUser = async () => {
        // 前端这两条只是**不让请求白跑一趟**，判据的权威在后端（`utils::username_reject` /
        // `password_reject`）。口径与后端逐字对齐：账号名先 trim 再判、按**字符**数算
        // （`[...s].length` 数的是码点，`s.length` 数的是 UTF-16 单元 —— 汉字两者都是 1，
        // 只有 emoji 这类代理对才会差，用码点更贴近后端 `chars().count()`）。
        const name = tempUsername.trim()
        if (!name) { message.warning('请输入用户名'); return }
        if ([...name].length > 32) { message.warning('用户名最多 32 个字符'); return }
        if ([...tempPassword].length < 8) { message.warning('密码至少 8 位'); return }
        if ([...tempPassword].length > 128) { message.warning('密码最多 128 位'); return }
        try {
            const res = await http.post('/api/temp-users',
                { username: name, password: tempPassword })
            if (res.data?.code === 200) {
                message.success('创建成功')
                setTempUsername('')
                setTempPassword('')
                invalidateTempUsers()
            } else {
                message.error(res.data?.message)
            }
        } catch { message.error('请求失败') }
    }

    const [delTarget, setDelTarget] = useState<any>(null)
    const askDeleteTempUser = (user: any) => setDelTarget(user)
    const confirmDeleteTempUser = async () => {
        const t = delTarget
        setDelTarget(null)      // 先关窗再发请求（同 confirmSetStatus）
        if (t) await handleDeleteTempUser(t.id)
    }

    const handleDeleteTempUser = async (id: number) => {
        try {
            const res = await http.delete('/api/temp-users/' + id)
            if (res.data?.code === 200) {
                message.success(res.data.data || '已删除')
                invalidateTempUsers()
            }
            else { message.error(res.data?.message) }
        } catch { message.error('请求失败') }
    }

    const handleSetStatus = async (user: any, frozen: boolean) => {
        try {
            // 传**目标状态**而不是"切换一下"：服务端不猜意图，重试/双击都安全
            const res = await http.post('/api/temp-users/' + user.id + '/status', { frozen })
            if (res.data?.code === 200) {
                message.success(res.data.data || '操作完成')
                invalidateTempUsers()
            }
            else { message.error(res.data?.message) }
        } catch { message.error('请求失败') }
    }

    /** 冻结/解冻的确认弹窗。`statusNext` = 点确定之后那一行的目标状态：
     *  true 冻结 / false 解冻。用**目标状态**而不是 `isFrozen(statusTarget)` 现算——
     *  弹窗开着的这段时间里列表可能被重新拉过（看板娘刚改过 / 切回可见 / 20 秒轮询，
     *  见下面 `useLiveRefresh` 那段），现算会让"我点的是冻结、确定下去却解冻了"。 */
    const [statusTarget, setStatusTarget] = useState<any>(null)
    const [statusNext, setStatusNext] = useState(false)
    const askSetStatus = (user: any, frozen: boolean) => {
        setStatusTarget(user)
        setStatusNext(frozen)
    }
    const confirmSetStatus = async () => {
        const t = statusTarget
        const frozen = statusNext
        setStatusTarget(null)   // 先关窗再发请求：失败走 message 提示，不留一个"卡住的确认框"
        if (t) await handleSetStatus(t, frozen)
    }

    const handleSetMute = async (user: any, muted: boolean, hours: number) => {
        try {
            const res = await http.post('/api/temp-users/' + user.id + '/mute',
                { muted, hours: muted ? hours : null })
            if (res.data?.code === 200) {
                // 人话在 **`data`** 里、不在 `message` 里——同 `handleSetStatus` 那条注
                // （`ApiResponse::success` 的 `message` 恒为字面量 `"ok"`）。
                message.success(res.data.data || '操作完成')
                invalidateTempUsers()
            }
            else { message.error(res.data?.message) }
        } catch { message.error('请求失败') }
    }

    /** 禁言确认弹窗。`muteTarget` + `muteHours` 都是**开窗那一刻的快照**——同
     *  `statusTarget`/`statusNext` 那条注：窗口开着的这段时间列表可能被重拉，
     *  现算会让"我选的 24 小时、确定下去变成永久了"。 */
    const [muteTarget, setMuteTarget] = useState<any>(null)
    const [muteHours, setMuteHours] = useState(24)
    const askSetMute = (user: any) => {
        setMuteTarget(user)
        setMuteHours(24)    // 每次开窗回到默认档，不沿用上一次的选择
    }
    const confirmSetMute = async () => {
        const t = muteTarget
        const hours = muteHours
        setMuteTarget(null)
        if (t) await handleSetMute(t, true, hours)
    }
    /** 解禁确认：**单独一个窗口**，不与禁言共用一个（禁言要选时长、解禁没有这一维，
     *  硬塞进同一个弹窗就得让半个窗口在两种方向下长得不一样）。 */
    const [unmuteTarget, setUnmuteTarget] = useState<any>(null)
    const confirmUnmute = async () => {
        const t = unmuteTarget
        setUnmuteTarget(null)
        if (t) await handleSetMute(t, false, 0)
    }

    // 登录态变化和到期立即更新入口；提交时再读取当前令牌，后端最终授权。
    const authToken = useAuthToken()
    const myRole = getRoleFromToken(authToken)
    /** 我自己的 uid：判"这一行是我自己"（后端不许冻自己），同一次解析里一起取。 */
    const myUid = getUidFromToken(authToken)
    const [credentialOwner, setCredentialOwner] = useState<string | null>(null)
    const credentialsBusy = useRef(false)
    const [credentialPending, setCredentialPending] = useState(false)
    const canManage = (user: TempUser) => canManageCredentials(getLiveAuthToken(), user)

    const [roleTarget, setRoleTarget] = useState<any>(null)
    const [roleNext, setRoleNext] = useState('')
    const askSetRole = (user: any, role: string) => {
        setRoleTarget(user)
        setRoleNext(role)
    }
    const roleMenuRoles = myRole === 'superadmin'
        ? ASSIGNABLE_ROLES
        : ASSIGNABLE_ROLES.filter((r) => ADMIN_ROLE_TIERS.includes(r.role))
    const canChangeRoleOf = (role?: string | null) =>
        myRole === 'superadmin' || (myRole === 'admin' && ADMIN_ROLE_TIERS.includes(role || ''))
    const confirmSetRole = async () => {
        const t = roleTarget
        const r = roleNext
        setRoleTarget(null)     // 先关窗再发请求（同 confirmSetStatus）
        if (!t || !r) return
        try {
            const res = await http.post('/api/temp-users/' + t.id + '/role', { role: r })
            if (res.data?.code === 200) {
                message.success(res.data.data || '操作完成')
                invalidateTempUsers()
            } else { message.error(res.data?.message) }
        } catch { message.error('请求失败') }
    }

    const [notifyTarget, setNotifyTarget] = useState<any>(null)
    const [notifyTitle, setNotifyTitle] = useState('')
    const [notifyContent, setNotifyContent] = useState('')

    const openNotifyModal = (user: any) => {
        setNotifyTarget(user)
        setNotifyTitle('')
        setNotifyContent('')
    }

    const handleSendNotice = async () => {
        const t = notifyTarget
        const content = notifyContent.trim()
        if (!t) return
        if (!content) { message.warning('请输入通知内容'); return }
        // 先关窗再发请求（同 confirmSetStatus / confirmSetRole）：失败走 message
        // 提示，不留一个"卡住的确认框"
        setNotifyTarget(null)
        try {
            // 标题留空时**原样传空串**，由后端取默认标题——不在前端另写一份默认值
            // （"系统自己写的字"该只有一处来源，否则两边迟早不一样）
            const res = await http.post('/api/temp-users/' + t.id + '/notice',
                { title: notifyTitle.trim(), content })
            if (res.data?.code === 200) message.success(res.data.data || '已发送')
            else message.error(res.data?.message)
        } catch { message.error('请求失败') }
    }

    const [quotaTarget, setQuotaTarget] = useState<any>(null)
    const confirmResetQuota = async () => {
        const t = quotaTarget
        setQuotaTarget(null)
        if (!t) return
        try {
            const res = await http.post('/api/temp-users/' + t.id + '/quota-reset')
            if (res.data?.code === 200) {
                message.success(res.data.data || '操作完成')
                invalidateTempUsers()
            } else { message.error(res.data?.message) }
        } catch { message.error('请求失败') }
    }

    const openPwModal = (user: TempUser) => {
        if (!canManage(user)) return
        setCredentialOwner(getLiveAuthToken())
        setPwTarget(user)
        setPwNewPassword('')
        setPwModalOpen(true)
    }

    const handleChangePassword = async () => {
        if (credentialOwner !== getLiveAuthToken() || !pwTarget || !canManage(pwTarget)) { message.error('当前无权修改该账号凭证'); return }
        if (credentialsBusy.current) return
        if ([...pwNewPassword].length < 8) { message.warning('密码至少 8 位'); return }
        if ([...pwNewPassword].length > 128) { message.warning('密码最多 128 位'); return }
        credentialsBusy.current = true
        setCredentialPending(true)
        try {
            const res = await http.post('/api/temp-users/' + pwTarget.id + '/password',
                { password: pwNewPassword })
            if (res.data?.code === 200) { message.success('密码已修改'); setPwModalOpen(false) }
            else { message.error(res.data?.message) }
        } catch { message.error('请求失败') }
        finally { credentialsBusy.current = false; setCredentialPending(false) }
    }

    const handleCreateRecoveryCode = async (user: TempUser) => {
        if (!canManage(user)) { message.error('当前无权修改该账号凭证'); return }
        if (credentialsBusy.current) return
        const requestOwner = getLiveAuthToken()
        credentialsBusy.current = true
        setCredentialPending(true)
        try {
            // 这个接口**没有请求体**（恢复码由后端生成，handler 只有 State + Path
            // 两个提取器，没有 Json）——所以 post 的第二参省略，别顺手补个 `{}`。
            const res = await http.post('/api/temp-users/' + user.id + '/password-reset-token')
            if (requestOwner !== getLiveAuthToken()) return
            if (res.data?.code === 200) {
                setCredentialOwner(requestOwner)
                setRecoveryTarget(user)
                setRecoveryCode(res.data.data)
                setRecoveryModalOpen(true)
            } else {
                message.error(res.data?.message || '恢复码生成失败')
            }
        } catch { message.error('请求失败') }
        finally { credentialsBusy.current = false; setCredentialPending(false) }
    }

    useLiveRefresh(() => refreshTempUsers(), {
        skip: () => tab !== 'accounts'
            || !!statusTarget || !!roleTarget || !!notifyTarget || !!quotaTarget
            || !!muteTarget || !!unmuteTarget
            || pwModalOpen || recoveryModalOpen,
    });

    const items: TabsProps['items'] = [
        {
            key: 'accounts',
            label: '账号管理',
            children: (
                <>
                    <div className="tu-section">
                        <div className="tu-head">
                            <div className="tu-create">
                                <Input
                                    name="new-account-name"
                                    autoComplete="off"
                                    placeholder="用户名"
                                    value={tempUsername}
                                    onChange={e => setTempUsername(e.target.value)}
                                    maxLength={32}
                                    style={{ flex: 1 }}
                                />
                                <Input.Password
                                    name="new-account-password"
                                    autoComplete="new-password"
                                    placeholder="密码（至少 8 位）"
                                    value={tempPassword}
                                    onChange={e => setTempPassword(e.target.value)}
                                    maxLength={128}
                                    style={{ flex: 1 }}
                                />
                                <Button type="primary" onClick={handleCreateTempUser}>新建临时用户</Button>
                            </div>
                            <p className="tu-hint">
                                临时用户可登录前台发布说说、放河灯留言（供访客开账号用）
                            </p>
                            <div className="tu-filter">
                                <div className="tu-tabs" role="tablist">
                                    {ACC_FILTERS.map((f) => (
                                        <button
                                            key={f.key}
                                            type="button"
                                            className={accFilter === f.key ? 'sel' : ''}
                                            onClick={() => setAccFilter(f.key)}
                                        >
                                            {f.label}
                                        </button>
                                    ))}
                                </div>
                                <Input.Search
                                    placeholder="检索用户名 / ID…"
                                    allowClear
                                    onChange={e => setAccQuery(e.target.value)}
                                    style={{ width: 240 }}
                                />
                                <Button
                                    icon={<ReloadOutlined />}
                                    onClick={() => invalidateTempUsers()}
                                >
                                    刷新
                                </Button>
                                <span className="tu-count">
                                    {cachedUsers === null ? '正在读取账号…' : `共 ${filteredUsers.length} 个账号`}
                                </span>
                            </div>
                        </div>
                        <div className="tu-list-wrap">
                            {filteredUsers.length === 0 ? (
                                <div className="tu-empty">
                                    {cachedUsers === null ? (
                                        usersFailed
                                            ? <>读取失败 <Button type="link" size="small" onClick={() => invalidateTempUsers()}>点此重试</Button></>
                                            : '正在读取…'
                                    ) : (
                                        tempUsers.length === 0 ? '暂无账号' : '没有匹配的账号'
                                    )}
                                </div>
                            ) : (
                                <div className="tu-list">
                                    {filteredUsers.map((u: any) => {
                                      /** 这一行的冻结按钮该不该亮。两种情况下后端会拒，
                                       *  这里说到做到（**只决定按钮亮不亮**，真正的闸在
                                       *  服务端 `authz::check_freeze`）：
                                       *  · 目标就是我自己（uid 从令牌的 `sub` 里读，不用
                                       *    再拉一次 /profile）——冻了自己就再也解不开了；
                                       *  · 我是管理员、对方也是管理员（同级）——但**超管
                                       *    不受这条限制**（超管冻管理员是放行的），所以
                                       *    判据必须是"我是 admin"而不是"对方是 admin"。
                                       *  文案与后端那两句是同一句话（见
                                       *  `routes/temp_user.rs::freeze_denial_message`）：
                                       *  同一件事不该在界面上和在接口里说成两句。 */
                                      const freezeBlocked =
                                          (myUid !== null && u.id === myUid) ? '不能冻结自己的账号'
                                              : (myRole === 'admin' && u.role === 'admin')
                                                  ? '管理员之间不可互相冻结' : ''
                                      // 额度那一截（文案 + 档位）。与另外三处同源，见 `quotaChip`。
                                      const qc = quotaChip(u)
                                      // 冻结/解冻：一个按钮、两种含义，按当前状态取反。
                                      // danger 只给"冻结"那一侧——红按钮按下去会让对方下线，
                                      // "解冻"是恢复性操作，用红的不合适。
                                      const freezeBtn = (
                                          <Button
                                              size="small"
                                              className="tu-freeze-btn"
                                              danger={!isFrozen(u)}
                                              disabled={!!freezeBlocked}
                                              onClick={() => askSetStatus(u, !isFrozen(u))}
                                          >
                                              {isFrozen(u) ? '解冻' : '冻结'}
                                          </Button>
                                      )
                                      /** 这一行的禁言按钮该不该亮。条件与冻结**逐字相同**
                                       *  （后端 `authz::check_mute` 与 `check_freeze` 共用一张
                                       *  规则表，只有动词不同），所以两个 `Blocked` 只看动作词
                                       *  是否一致一眼就能核对——**这不是重复，是同一张规则表
                                       *  在两处的投影**；真出分歧的地方是后端那一处。
                                       *  ⚠️ 两句文案是跨语言契约，与 `routes/temp_user.rs::
                                       *  mute_denial_message` 逐字同源，agent 转述的就是它们。 */
                                      const muteBlocked =
                                          (myUid !== null && u.id === myUid) ? '不能禁言自己的账号'
                                              : (myRole === 'admin' && u.role === 'admin')
                                                  ? '管理员之间不可互相禁言' : ''
                                      const muted = isMuted(u)
                                      /** 禁言/解禁：一个按钮两种含义，按当前状态取反。
                                       *  **两侧都不给 danger**——禁言不踢人下线，红按钮留给冻结。 */
                                      const muteBtn = (
                                          <Button
                                              size="small"
                                              className="tu-mute-btn"
                                              disabled={!!muteBlocked}
                                              onClick={() => (muted ? setUnmuteTarget(u) : askSetMute(u))}
                                          >
                                              {muted ? '解除禁言' : '禁言'}
                                          </Button>
                                      )
                                      return (
                                        <div key={u.id} className="tu-row">
                                            <div className="tu-info">
                                                <strong className={isFrozen(u) ? 'tu-frozen-name' : ''}>{u.username}</strong>
                                                {u.role !== 'user' && (
                                                    <RoleBadge role={u.role} size={22} style={{ marginLeft: 8 }} />
                                                )}
                                                {isFrozen(u) && (
                                                    <Tag color="red" style={{ marginLeft: 8 }}>已冻结</Tag>
                                                )}
                                                {muted && (
                                                    <Tag color="orange" style={{ marginLeft: 8 }}>
                                                        已禁言{u.mutedUntil ? ` · ${muteUntilText(u.mutedUntil)}` : ''}
                                                    </Tag>
                                                )}
                                                <span className="tu-id">ID: {u.id}</span>
                                                <span className={`tu-quota${qc.level ? ` is-${qc.level}` : ''}`}>
                                                    {qc.text}
                                                </span>
                                            </div>
                                            <div className="tu-actions">
                                                {canManageCredentials(authToken, u) && <>
                                                    <Button size="small" disabled={credentialPending} onClick={() => openPwModal(u)}>修改密码</Button>
                                                    <Button size="small" disabled={credentialPending} onClick={() => handleCreateRecoveryCode(u)}>生成恢复码</Button>
                                                </>}
                                                <Button size="small" className="tu-notify-btn"
                                                        onClick={() => openNotifyModal(u)}>发通知</Button>
                                                <Button size="small" className="tu-quota-btn"
                                                        disabled={u.chatQuotaLimit === 0}
                                                        onClick={() => setQuotaTarget(u)}>重置额度</Button>
                                                {freezeBlocked
                                                    ? <Tooltip title={freezeBlocked}>{freezeBtn}</Tooltip>
                                                    : freezeBtn}
                                                {muteBlocked
                                                    ? <Tooltip title={muteBlocked}>{muteBtn}</Tooltip>
                                                    : muteBtn}
                                                {canChangeRoleOf(u.role) && (
                                                    <Dropdown
                                                        trigger={['click']}
                                                        menu={{
                                                            items: roleMenuRoles
                                                                .filter((r) => r.role !== u.role)
                                                                .map((r) => ({ key: r.role, label: ROLE_LABEL[r.role] })),
                                                            onClick: ({ key }) => askSetRole(u, key),
                                                        }}
                                                    >
                                                        <Button size="small" className="tu-role-btn">变更身份</Button>
                                                    </Dropdown>
                                                )}
                                                {u.role === 'user' && (
                                                    <Button size="small" className="tu-del-btn" danger onClick={() => askDeleteTempUser(u)}>删除</Button>
                                                )}
                                            </div>
                                        </div>
                                      )
                                    })}
                                </div>
                            )}
                        </div>
                    </div>

                    <Modal
                        title={'重置额度 - ' + (quotaTarget?.username || '')}
                        open={!!quotaTarget}
                        onOk={confirmResetQuota}
                        onCancel={() => setQuotaTarget(null)}
                        okText="重置额度"
                        cancelText="取消"
                        okButtonProps={{ className: 'tu-quota-ok' }}
                        width={420}
                    >
                        <div style={{ marginTop: 12, lineHeight: 1.7 }}>
                            <div>
                                确定要把<strong>{quotaTarget?.username}</strong> 的对话额度恢复到上限吗？
                            </div>
                            <div style={{ marginTop: 8, color: 'var(--washi-ink-2, #7c6584)' }}>
                                恢复后：他的额度立刻回到满额、可以继续对话，并会收到一条站内通知。
                                这一下在界面上撤不回来——原值不会被记下来，唯一能再变的是下一次重置。
                            </div>
                        </div>
                    </Modal>

                    <Modal
                        title={'删除账号 - ' + (delTarget?.username || '')}
                        open={!!delTarget}
                        onOk={confirmDeleteTempUser}
                        onCancel={() => setDelTarget(null)}
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true, className: 'tu-del-ok' }}
                        cancelButtonProps={{ className: 'tu-del-cancel' }}
                        width={420}
                    >
                        <div style={{ marginTop: 12, lineHeight: 1.7 }}>
                            <div>
                                确定要删除账号<strong>{delTarget?.username}</strong> 吗？
                            </div>
                            <div style={{ marginTop: 8, color: 'var(--washi-ink-2, #7c6584)' }}>
                                删除后：该账号无法再登录，它在站内的全部对话记录
                                （历史消息、会话摘要、会话列表）会一并清除。
                                <strong>这一步不可恢复</strong>，站内没有回收站，也查不回这个人。
                                只是想让他暂时登不进来，请改用「冻结」。
                            </div>
                        </div>
                    </Modal>

                    <Modal
                        title={statusNext ? '冻结账号' : '解冻账号'}
                        open={!!statusTarget}
                        onOk={confirmSetStatus}
                        onCancel={() => setStatusTarget(null)}
                        okText={statusNext ? '冻结' : '解冻'}
                        cancelText="取消"
                        okButtonProps={{ danger: statusNext, className: 'tu-status-ok' }}
                        cancelButtonProps={{ className: 'tu-status-cancel' }}
                        width={420}
                    >
                        <div style={{ marginTop: 12, lineHeight: 1.7 }}>
                            <div>
                                确定要{statusNext ? '冻结' : '解冻'}
                                <strong>{statusTarget?.username}</strong> 吗？
                            </div>
                            <div style={{ marginTop: 8, color: 'var(--washi-ink-2, #7c6584)' }}>
                                {statusNext
                                    ? '冻结后：该账号无法再登录，已登录的网页会话立即失效；解冻后需要重新登录，冻结前的登录状态不会恢复。'
                                    : '解冻后：该账号可以重新登录；它冻结前的登录状态不会恢复。'}
                            </div>
                        </div>
                    </Modal>

                    <Modal
                        title={'禁言账号 - ' + (muteTarget?.username || '')}
                        open={!!muteTarget}
                        onOk={confirmSetMute}
                        onCancel={() => setMuteTarget(null)}
                        okText="禁言"
                        cancelText="取消"
                        okButtonProps={{ className: 'tu-mute-ok' }}
                        cancelButtonProps={{ className: 'tu-mute-cancel' }}
                        width={440}
                    >
                        <div style={{ marginTop: 12, lineHeight: 1.7 }}>
                            <div>
                                确定要禁言 <strong>{muteTarget?.username}</strong> 吗？
                            </div>
                            <div style={{ marginTop: 8 }}>
                                <Radio.Group
                                    className="tu-mute-duration"
                                    value={muteHours}
                                    onChange={(e) => setMuteHours(e.target.value)}
                                >
                                    {MUTE_DURATIONS.map((d) => (
                                        <Radio key={d.hours} value={d.hours}>{d.label}</Radio>
                                    ))}
                                </Radio.Group>
                            </div>
                            <div style={{ marginTop: 8, color: 'var(--washi-ink-2, #7c6584)' }}>
                                禁言期间：该账号不能发布文章评论与留言，这两处提交会被直接拒绝。
                                其余一切照常——仍可登录、浏览文章、与泠月喵对话，点赞也不受影响。
                            </div>
                        </div>
                    </Modal>

                    <Modal
                        title={'解除禁言 - ' + (unmuteTarget?.username || '')}
                        open={!!unmuteTarget}
                        onOk={confirmUnmute}
                        onCancel={() => setUnmuteTarget(null)}
                        okText="解除禁言"
                        cancelText="取消"
                        okButtonProps={{ className: 'tu-unmute-ok' }}
                        cancelButtonProps={{ className: 'tu-unmute-cancel' }}
                        width={420}
                    >
                        <div style={{ marginTop: 12, lineHeight: 1.7 }}>
                            <div>
                                确定要解除 <strong>{unmuteTarget?.username}</strong> 的禁言吗？
                            </div>
                            <div style={{ marginTop: 8, color: 'var(--washi-ink-2, #7c6584)' }}>
                                解禁后该账号可以立即发布评论与留言。这与冻结无关：期间它的登录
                                状态一直有效，不受本次操作影响。
                            </div>
                        </div>
                    </Modal>

                    <Modal
                        title={'变更身份 - ' + (roleTarget?.username || '')}
                        open={!!roleTarget}
                        onOk={confirmSetRole}
                        onCancel={() => setRoleTarget(null)}
                        okText={'改成' + (ROLE_LABEL[roleNext] || roleNext)}
                        cancelText="取消"
                        okButtonProps={{
                            danger: roleRank(roleNext) < roleRank(roleTarget?.role),
                            className: 'tu-role-ok',
                        }}
                        cancelButtonProps={{ className: 'tu-role-cancel' }}
                        width={420}
                    >
                        <div style={{ marginTop: 12, lineHeight: 1.7 }}>
                            <div>
                                把 <strong>{roleTarget?.username}</strong> 的身份从
                                「{roleLabel(roleTarget?.role)}」改为
                                「{ROLE_LABEL[roleNext] || roleNext}」
                            </div>
                            <div style={{ marginTop: 8, color: 'var(--washi-ink-2, #7c6584)' }}>
                                {roleRank(roleNext) < roleRank(roleTarget?.role)
                                    ? '这是收窄权限：改完他就没有现在这些能力了。'
                                    : '这是放宽权限：改完他能做的事比现在多。'}
                                该账号的登录状态会立即失效，需要重新登录。
                            </div>
                        </div>
                    </Modal>

                    <Modal
                        title={'修改密码 - ' + (pwTarget?.username || '')}
                        open={pwModalOpen && credentialOwner === authToken && !!pwTarget && canManageCredentials(authToken, pwTarget)}
                        confirmLoading={credentialPending}
                        onOk={handleChangePassword}
                        onCancel={() => setPwModalOpen(false)}
                        okText="确认修改"
                        cancelText="取消"
                        forceRender
                    >
                        <div style={{ marginTop: 16 }}>
                            {pwModalOpen && (
                                <Input.Password
                                    name="change-account-password"
                                    autoComplete="new-password"
                                    placeholder="输入新密码（至少 8 位）"
                                    value={pwNewPassword}
                                    onChange={e => setPwNewPassword(e.target.value)}
                                    maxLength={128}
                                />
                            )}
                        </div>
                    </Modal>

                    <Modal
                        title={'发通知 - ' + (notifyTarget?.username || '')}
                        open={!!notifyTarget}
                        onOk={handleSendNotice}
                        onCancel={() => setNotifyTarget(null)}
                        okText="发送"
                        cancelText="取消"
                        okButtonProps={{
                            disabled: !notifyContent.trim(),
                            className: 'tu-notify-ok',
                        }}
                        cancelButtonProps={{ className: 'tu-notify-cancel' }}
                        width={520}
                        forceRender
                    >
                        {notifyTarget && (
                            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                                <div style={{ color: 'var(--washi-ink-2, #7c6584)' }}>
                                    这条通知会出现在 <strong>{notifyTarget.username}</strong> 的个人中心，
                                    发出后无法撤回。标题留空则显示为「站内通知」。
                                </div>
                                <Input
                                    className="tu-notify-title"
                                    name="notice-title"
                                    autoComplete="off"
                                    placeholder="标题（可留空）"
                                    maxLength={128}
                                    value={notifyTitle}
                                    onChange={e => setNotifyTitle(e.target.value)}
                                />
                                <Input.TextArea
                                    className="tu-notify-body counter-room"
                                    name="notice-content"
                                    autoComplete="off"
                                    placeholder="通知内容（必填）"
                                    rows={5}
                                    maxLength={1000}
                                    showCount
                                    value={notifyContent}
                                    onChange={e => setNotifyContent(e.target.value)}
                                />
                            </div>
                        )}
                    </Modal>

                    <Modal
                        title={'一次性恢复码 - ' + (recoveryTarget?.username || '')}
                        open={recoveryModalOpen && credentialOwner === authToken && !!recoveryTarget && canManageCredentials(authToken, recoveryTarget)}
                        footer={null}
                        onCancel={() => setRecoveryModalOpen(false)}
                    >
                        <p>请通过安全渠道把下面恢复码交给用户。恢复码 15 分钟内有效，生成新码会立即使旧码失效。</p>
                        <Input value={recoveryCode} readOnly />
                    </Modal>
                </>
            ),
        },
        {
            key: 'review',
            label: '留言管理',
            children: <BoardManage />,
        },
        {
            key: 'comment',
            label: '评论管理',
            children: <CommentManage />,
        },
        {
            key: 'quota',
            label: '额度管理',
            children: <QuotaManage />,
        },
    ];

    return (
        <div className="users-page">
            <Tabs activeKey={tab} onChange={setTab} items={items} />
        </div>
    );
};

export default Users;

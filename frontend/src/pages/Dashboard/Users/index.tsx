import './index.sass'
import { Button, Input, message, Modal, Tabs, Tag } from 'antd';
import type { TabsProps } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import BoardManage from '../BoardManage';

/** 用户管理 = 账号管理（临时访客账号）+ 评论管理（河灯留言审核）
 *  20260905 拍板：原 Announcement 内嵌临时用户段迁入「账号管理」；
 *  原独立「留言管理」页并入「评论管理」。设置类（站点信息等）拆独立侧栏入口 UserControl。
 *
 *  `?tab=review` 直接落在评论管理（20260924 三轮）：后台首页待办卡上那行
 *  "N 条评论待人工审核"点过来就该看见那几条，而不是先看见账号列表再自己找 Tab。
 *  只在**进页那一下**当初始值——之后切 Tab 不再回写 URL（这一页没有"当前 Tab 是
 *  哪一页"的可分享语义，URL 也不是它的真源）。
 *
 *  账号筛选（20260926）：列表从"只列普通账号"扩到全部已知角色，于是要能按
 *  角色筛、按用户名检索；这一块与评论管理同款——**筛选与检索的头固定，只有
 *  下面的账号列表在窗口内滚**（原来整页滚，翻到后面想换个关键词得先滚回顶上）。
 */

/** 角色显示名（取值域见 src/authz.rs；未知角色走后端过滤，这里只做兜底展示） */
const ROLE_LABEL: Record<string, string> = {
    admin: '管理员',
    secretary: '秘书',
    user: '普通用户',
}

/** 筛选项：value 与 user.role 对应，null = 全部。
 *  写成一个数组而不是三个按钮硬编码——加"冻结账号"这类与角色正交的状态筛选时，
 *  只在这里补一项（判据随之改成 `(u) => …` 的形式）。 */
const ACC_FILTERS: { key: string; label: string; match: (u: any) => boolean }[] = [
    { key: 'all', label: '全部', match: () => true },
    { key: 'admin', label: '管理员账号', match: (u) => u.role === 'admin' },
    { key: 'user', label: '普通用户账号', match: (u) => u.role !== 'admin' },
]

const Users = () => {
    const [searchParams] = useSearchParams()
    const [tab, setTab] = useState(() =>
        searchParams.get('tab') === 'review' ? 'review' : 'accounts')

    // ── 临时用户（账号管理）──
    const token = localStorage.getItem('tokenKey')
    const [tempUsers, setTempUsers] = useState<any[]>([])
    const [tempUsername, setTempUsername] = useState('')
    const [tempPassword, setTempPassword] = useState('')
    const [pwModalOpen, setPwModalOpen] = useState(false)
    const [pwTarget, setPwTarget] = useState<any>(null)
    const [pwNewPassword, setPwNewPassword] = useState('')
    const [recoveryModalOpen, setRecoveryModalOpen] = useState(false)
    const [recoveryTarget, setRecoveryTarget] = useState<any>(null)
    const [recoveryCode, setRecoveryCode] = useState('')
    // 账号筛选/检索（20260926）
    const [accFilter, setAccFilter] = useState('all')
    const [accQuery, setAccQuery] = useState('')

    /** 筛选后的账号列表：先按角色分流，再按用户名包含匹配（大小写不敏感）。
     *  与评论管理同一条纪律——筛的是**已经有了的那份数据**，不发新请求。 */
    const filteredUsers = useMemo(() => {
        const f = ACC_FILTERS.find((x) => x.key === accFilter) ?? ACC_FILTERS[0]
        const q = accQuery.trim().toLowerCase()
        return tempUsers.filter((u) => f.match(u)
            && (q === '' || String(u.username ?? '').toLowerCase().includes(q)))
    }, [tempUsers, accFilter, accQuery])

    const loadTempUsers = async () => {
        try {
            const res = await fetch('/api/temp-users', { headers: { 'Authorization': 'Bearer ' + token } })
            const data = await res.json()
            if (Array.isArray(data)) setTempUsers(data)
        } catch { /* ignore */ }
    }

    useEffect(() => {
        setTimeout(loadTempUsers, 500)
    }, [])

    const handleCreateTempUser = async () => {
        if (!tempUsername || !tempPassword) { message.warning('请输入用户名和密码'); return }
        try {
            const res = await fetch('/api/temp-users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ username: tempUsername, password: tempPassword }),
            })
            const data = await res.json()
            if (data.code === 200) {
                message.success('创建成功')
                setTempUsername('')
                setTempPassword('')
                loadTempUsers()
            } else {
                message.error(data.message)
            }
        } catch { message.error('请求失败') }
    }

    const handleDeleteTempUser = async (id: number) => {
        try {
            const res = await fetch('/api/temp-users/' + id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } })
            const data = await res.json()
            if (data.code === 200) { message.success('已删除'); loadTempUsers() }
            else { message.error(data.message) }
        } catch { message.error('请求失败') }
    }

    const openPwModal = (user: any) => {
        setPwTarget(user)
        setPwNewPassword('')
        setPwModalOpen(true)
    }

    const handleChangePassword = async () => {
        if (!pwNewPassword || pwNewPassword.length < 3) { message.warning('密码至少3位'); return }
        try {
            const res = await fetch('/api/temp-users/' + pwTarget.id + '/password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ password: pwNewPassword }),
            })
            const data = await res.json()
            if (data.code === 200) { message.success('密码已修改'); setPwModalOpen(false) }
            else { message.error(data.message) }
        } catch { message.error('请求失败') }
    }

    const handleCreateRecoveryCode = async (user: any) => {
        try {
            const res = await fetch('/api/temp-users/' + user.id + '/password-reset-token', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token },
            })
            const data = await res.json()
            if (data.code === 200) {
                setRecoveryTarget(user)
                setRecoveryCode(data.data)
                setRecoveryModalOpen(true)
            } else {
                message.error(data.message || '恢复码生成失败')
            }
        } catch { message.error('请求失败') }
    }

    const items: TabsProps['items'] = [
        {
            key: 'accounts',
            label: <h3>账号管理</h3>,
            children: (
                <>
                    {/* 三段式（20260926）：上面这一截（新建 + 说明 + 筛选检索）固定，
                        只有下面的 .tu-list-wrap 在窗口内滚——原来整块 .tu-section
                        自己 overflow-y: auto，翻到第 30 个账号想换个关键词得先滚回顶上。 */}
                    <div className="tu-section">
                        <div className="tu-head">
                            <div className="tu-create">
                                {/* autoComplete 的两个取值是刻意的（20260926）：
                                    密码框用 new-password —— Chrome 的密码管理器对**判定为
                                    凭据**的字段忽略 `off`，`off` 只对非凭据字段有效；要退出
                                    凭据判定就得给具体 token。用户名框按规范只能是 username/off。
                                    ⚠️ 但真正让这两个框被回填的**不是这里缺属性**，而是页面里
                                    曾常驻一个密码框（见下面「修改密码」弹窗的注释）——属性只是
                                    把"这是个新建账号的表单"说清楚。 */}
                                <Input
                                    name="new-account-name"
                                    autoComplete="off"
                                    placeholder="用户名"
                                    value={tempUsername}
                                    onChange={e => setTempUsername(e.target.value)}
                                    style={{ flex: 1 }}
                                />
                                <Input.Password
                                    name="new-account-password"
                                    autoComplete="new-password"
                                    placeholder="密码"
                                    value={tempPassword}
                                    onChange={e => setTempPassword(e.target.value)}
                                    style={{ flex: 1 }}
                                />
                                <Button type="primary" onClick={handleCreateTempUser}>新建临时用户</Button>
                            </div>
                            <p className="tu-hint">
                                临时用户可登录前台发布说说、放河灯留言（供家人/访客开账号用）
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
                                    placeholder="检索用户名…"
                                    allowClear
                                    onChange={e => setAccQuery(e.target.value)}
                                    style={{ width: 240 }}
                                />
                                <span className="tu-count">共 {filteredUsers.length} 个账号</span>
                            </div>
                        </div>
                        <div className="tu-list-wrap">
                            {filteredUsers.length === 0 ? (
                                <div className="tu-empty">
                                    {tempUsers.length === 0 ? '暂无账号' : '没有匹配的账号'}
                                </div>
                            ) : (
                                <div className="tu-list">
                                    {filteredUsers.map((u: any) => (
                                        <div key={u.id} className="tu-row">
                                            <div>
                                                <strong>{u.username}</strong>
                                                {u.role !== 'user' && (
                                                    <Tag color={u.role === 'admin' ? 'gold' : 'blue'} style={{ marginLeft: 8 }}>
                                                        {ROLE_LABEL[u.role] || u.role}
                                                    </Tag>
                                                )}
                                                <span className="tu-id">ID: {u.id}</span>
                                            </div>
                                            <div style={{ display: 'flex', gap: 8 }}>
                                                <Button size="small" onClick={() => openPwModal(u)}>修改密码</Button>
                                                <Button size="small" onClick={() => handleCreateRecoveryCode(u)}>生成恢复码</Button>
                                                {/* 非普通账号不给删除按钮：后端也会拒（见 delete_temp_user），
                                                    但让按钮干脆不出现，比点了才被告知不行更清楚 */}
                                                {u.role === 'user' && (
                                                    <Button size="small" danger onClick={() => handleDeleteTempUser(u.id)}>删除</Button>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    <Modal
                        title={'修改密码 - ' + (pwTarget?.username || '')}
                        open={pwModalOpen}
                        onOk={handleChangePassword}
                        onCancel={() => setPwModalOpen(false)}
                        okText="确认修改"
                        cancelText="取消"
                        // forceRender 是下面那条"关窗摘密码框"能生效的**前提**，不是性能选项：
                        // rc-dialog 的 children 被 MemoChildren 包着，判据是
                        // `shouldUpdate = visible || forceRender`——关窗时 shouldUpdate=false，
                        // 整棵 children 冻结成"最后一次可见时"的快照，`{pwModalOpen && …}` 那一刻
                        // 根本不会被应用。同族修法见 UserCenter（20260924 实测过）。
                        forceRender
                    >
                        <div style={{ marginTop: 16 }}>
                            {/* 关窗即从 DOM 摘掉这个密码框（20260926，用户报"注册账号输入框
                                被浏览器默认填充了"）。根因不在新建表单缺属性，而是这里：
                                Chrome 对判定为凭据的字段忽略 `autocomplete="off"`，而**页面里
                                没有任何 `<form>` 时它会把整页散落的输入框当成一个合成表单**
                                ——于是"页面上常驻一个密码框"就等于"本页是登录页"，它便去回填
                                页面上最裸的那个文本框（这里就是新建账号的用户名/密码框）。
                                本弹窗是常驻挂载的（open 只切显隐），所以这个框会一直留在 DOM 里，
                                只能按开合状态摘挂。关窗时 pwNewPassword 本来就该作废。 */}
                            {pwModalOpen && (
                                <Input.Password
                                    name="change-account-password"
                                    autoComplete="new-password"
                                    placeholder="输入新密码"
                                    value={pwNewPassword}
                                    onChange={e => setPwNewPassword(e.target.value)}
                                />
                            )}
                        </div>
                    </Modal>

                    <Modal
                        title={'一次性恢复码 - ' + (recoveryTarget?.username || '')}
                        open={recoveryModalOpen}
                        footer={null}
                        onCancel={() => setRecoveryModalOpen(false)}
                    >
                        <p>请通过安全渠道把下面恢复码交给用户。恢复码 15 分钟内有效，生成新码会立即使旧码失效。</p>
                        {/* Type=text（不是 Password）：恢复码要能念给对方，且它不是凭据——
                            没必要再往"合成登录表单"里添一个密码框 */}
                        <Input value={recoveryCode} readOnly />
                    </Modal>
                </>
            ),
        },
        {
            key: 'review',
            label: <h3>评论管理</h3>,
            children: <BoardManage />,
        },
    ];

    return (
        <div className="users-page">
            <Tabs activeKey={tab} onChange={setTab} items={items} />
        </div>
    );
};

export default Users;

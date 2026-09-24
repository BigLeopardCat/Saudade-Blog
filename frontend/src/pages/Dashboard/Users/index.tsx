import './index.sass'
import { Button, Input, message, Modal, Tabs } from 'antd';
import type { TabsProps } from 'antd';
import { useEffect, useState } from 'react';
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
 */
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
                <div className="tu-section">
                    <div className="tu-create">
                        <Input
                            placeholder="用户名"
                            value={tempUsername}
                            onChange={e => setTempUsername(e.target.value)}
                            style={{ flex: 1 }}
                        />
                        <Input.Password
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
                    {tempUsers.length === 0 ? (
                        <div className="tu-empty">暂无临时用户</div>
                    ) : (
                        <div className="tu-list">
                            {tempUsers.map((u: any) => (
                                <div key={u.id} className="tu-row">
                                    <div>
                                        <strong>{u.username}</strong>
                                        <span className="tu-id">ID: {u.id}</span>
                                    </div>
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        <Button size="small" onClick={() => openPwModal(u)}>修改密码</Button>
                                        <Button size="small" onClick={() => handleCreateRecoveryCode(u)}>生成恢复码</Button>
                                        <Button size="small" danger onClick={() => handleDeleteTempUser(u.id)}>删除</Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    <Modal
                        title={'修改密码 - ' + (pwTarget?.username || '')}
                        open={pwModalOpen}
                        onOk={handleChangePassword}
                        onCancel={() => setPwModalOpen(false)}
                        okText="确认修改"
                        cancelText="取消"
                    >
                        <div style={{ marginTop: 16 }}>
                            <Input.Password
                                placeholder="输入新密码"
                                value={pwNewPassword}
                                onChange={e => setPwNewPassword(e.target.value)}
                            />
                        </div>
                    </Modal>

                    <Modal
                        title={'一次性恢复码 - ' + (recoveryTarget?.username || '')}
                        open={recoveryModalOpen}
                        footer={null}
                        onCancel={() => setRecoveryModalOpen(false)}
                    >
                        <p>请通过安全渠道把下面恢复码交给用户。恢复码 15 分钟内有效，生成新码会立即使旧码失效。</p>
                        <Input value={recoveryCode} readOnly />
                    </Modal>
                </div>
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

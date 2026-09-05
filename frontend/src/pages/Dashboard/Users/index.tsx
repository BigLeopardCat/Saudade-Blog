import './index.sass'
import { Button, Input, message, Modal, Tabs } from 'antd';
import type { TabsProps } from 'antd';
import { useEffect, useState } from 'react';
import BoardManage from '../BoardManage';

/** 用户管理 = 账号管理（临时访客账号）+ 评论管理（河灯留言审核）
 *  20260905 拍板：原 Announcement 内嵌临时用户段迁入「账号管理」；
 *  原独立「留言管理」页并入「评论管理」。设置类（站点信息等）拆独立侧栏入口 UserControl。
 */
const Users = () => {
    // ── 临时用户（账号管理）──
    const token = localStorage.getItem('tokenKey')
    const [tempUsers, setTempUsers] = useState<any[]>([])
    const [tempUsername, setTempUsername] = useState('')
    const [tempPassword, setTempPassword] = useState('')
    const [pwModalOpen, setPwModalOpen] = useState(false)
    const [pwTarget, setPwTarget] = useState<any>(null)
    const [pwNewPassword, setPwNewPassword] = useState('')

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
            <Tabs defaultActiveKey="accounts" items={items} />
        </div>
    );
};

export default Users;

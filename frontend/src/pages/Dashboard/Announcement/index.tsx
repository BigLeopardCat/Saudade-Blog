import { Button, Form, Input, Modal, Table, message } from 'antd'
import { useEffect, useState } from 'react'
import { getAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement } from '../../../apis/AnnouncementMethods.tsx'

const { TextArea } = Input

const AnnouncementPage = () => {
    const [data, setData] = useState<any[]>([])
    const [modalOpen, setModalOpen] = useState(false)
    const [editItem, setEditItem] = useState<any>(null)
    const [form] = Form.useForm()
    const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])

    // ── 临时用户状态 ──
    const [tempUsers, setTempUsers] = useState<any[]>([])
    const [tempUsername, setTempUsername] = useState('')
    const [tempPassword, setTempPassword] = useState('')
    const [pwModalOpen, setPwModalOpen] = useState(false)
    const [pwTarget, setPwTarget] = useState<any>(null)
    const [pwNewPassword, setPwNewPassword] = useState('')

    const load = async () => {
        const res = await getAnnouncements()
        if (res.status === 200) {
            setData(res.data.data.map((item: any) => ({ ...item, key: item.id })))
        }
    }

    useEffect(() => { load() }, [])

    const openCreate = () => { setEditItem(null); form.resetFields(); setModalOpen(true) }
    const openEdit = (record: any) => { setEditItem(record); form.setFieldsValue(record); setModalOpen(true) }

    const handleOk = async () => {
        const values = await form.validateFields()
        if (editItem) {
            await updateAnnouncement(editItem.id, values)
        } else {
            await createAnnouncement(values)
        }
        setModalOpen(false)
        message.success(editItem ? '已更新' : '已创建')
        load()
    }

    const handleDelete = async () => {
        if (selectedRowKeys.length === 0) { message.warning('请选择'); return }
        await deleteAnnouncement(selectedRowKeys as number[])
        setSelectedRowKeys([])
        message.success('已删除')
        load()
    }

    const columns = [
        { title: 'ID', dataIndex: 'id', width: 60 },
        { title: '标题', dataIndex: 'title' },
        { title: '内容', dataIndex: 'content', ellipsis: true },
        { title: '时间', dataIndex: 'createdAt', width: 180 },
        {
            title: '操作', width: 100,
            render: (_: any, record: any) => <a onClick={() => openEdit(record)}>编辑</a>
        }
    ]

    // ── 临时用户操作 ──
    const token = localStorage.getItem('tokenKey')

    const loadTempUsers = async () => {
        try {
            const res = await fetch('/api/temp-users', { headers: { 'Authorization': 'Bearer ' + token } })
            const data = await res.json()
            if (Array.isArray(data)) setTempUsers(data)
        } catch { /* ignore */ }
    }

    useEffect(() => {
        setTimeout(loadTempUsers, 1000)
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

    return (
        <div style={{ padding: 24 }}>
            <div style={{ marginBottom: 16, display: 'flex', gap: 12 }}>
                <Button type="primary" onClick={openCreate}>新增公告</Button>
                <Button danger onClick={handleDelete}>删除选中</Button>
            </div>
            <Table
                rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
                columns={columns}
                dataSource={data}
                pagination={false}
            />
            <Modal
                title={editItem ? '编辑公告' : '新增公告'}
                open={modalOpen}
                onOk={handleOk}
                onCancel={() => setModalOpen(false)}
                okText="保存"
                cancelText="取消"
            >
                <Form form={form} layout="vertical">
                    <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
                        <Input />
                    </Form.Item>
                    <Form.Item name="content" label="内容" rules={[{ required: true, message: '请输入内容' }]}>
                        <TextArea rows={4} />
                    </Form.Item>
                </Form>
            </Modal>

            {/* ── 临时用户管理 ── */}
            <div style={{ marginTop: 48, borderTop: '1px solid #eee', paddingTop: 24 }}>
                <h3>临时用户管理</h3>
                <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
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

                {/* 临时用户列表 */}
                {tempUsers.length === 0 ? (
                    <div style={{ color: '#999', padding: 8 }}>暂无临时用户</div>
                ) : (
                    <div style={{ border: '1px solid #f0f0f0', borderRadius: 6, overflow: 'hidden' }}>
                        {tempUsers.map((u: any) => (
                            <div key={u.id} style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                padding: '10px 12px', borderBottom: '1px solid #f0f0f0'
                            }}>
                                <div>
                                    <strong>{u.username}</strong>
                                    <span style={{ color: '#999', marginLeft: 12 }}>ID: {u.id}</span>
                                </div>
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <Button size="small" onClick={() => openPwModal(u)}>修改密码</Button>
                                    <Button size="small" danger onClick={() => handleDeleteTempUser(u.id)}>删除</Button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* 修改密码 Modal */}
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
    )
}

export default AnnouncementPage

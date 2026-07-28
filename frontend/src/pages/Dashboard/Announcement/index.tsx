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
                    <input
                        id="temp-username"
                        placeholder="用户名"
                        style={{ flex: 1, padding: '4px 8px', borderRadius: 4, border: '1px solid #d9d9d9' }}
                    />
                    <input
                        id="temp-password"
                        type="password"
                        placeholder="密码"
                        style={{ flex: 1, padding: '4px 8px', borderRadius: 4, border: '1px solid #d9d9d9' }}
                    />
                    <Button type="primary" onClick={async () => {
                        const username = (document.getElementById('temp-username') as HTMLInputElement)?.value;
                        const password = (document.getElementById('temp-password') as HTMLInputElement)?.value;
                        if (!username || !password) { message.warning('请输入用户名和密码'); return; }
                        try {
                            const token = localStorage.getItem('tokenKey');
                            const res = await fetch('/api/temp-users', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                                body: JSON.stringify({ username, password }),
                            });
                            const data = await res.json();
                            if (data.code === 200) { message.success('创建成功'); loadTempUsers(); }
                            else { message.error(data.message); }
                        } catch { message.error('请求失败'); }
                    }}>新建临时用户</Button>
                </div>
                <div id="temp-user-list" />
            </div>
        </div>
    )
}

// 加载临时用户列表
const loadTempUsers = async () => {
    try {
        const token = localStorage.getItem('tokenKey');
        const res = await fetch('/api/temp-users', { headers: { 'Authorization': 'Bearer ' + token } });
        const data = await res.json();
        const container = document.getElementById('temp-user-list');
        if (!container) return;
        container.innerHTML = '';
        if (!data || data.length === 0) { container.innerHTML = '<div style=\"color: #999; padding: 8px;\">暂无临时用户</div>'; return; }
        data.forEach((u: any) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0f0f0';
            row.innerHTML = '<span>' + u.username.slice(0, 8) + '... (ID: ' + u.id + ')</span>' +
                '<button style=\"background:#ff4d4f;color:#fff;border:none;border-radius:4px;padding:2px 10px;cursor:pointer\"' +
                ' onclick=\"fetch(\'/api/temp-users/' + u.id + '\',{method:\'DELETE\',headers:{\'Authorization\':\'Bearer ' + token + '\'}}).then(r=>r.json()).then(d=>{if(d.code===200){loadTempUsers();message.success(\'已删除\')}})\">删除</button>';
            container.appendChild(row);
        });
    } catch {}
};

// 页面加载后自动加载临时用户列表
const origOnload = window.onload;
window.onload = (e) => { if (origOnload) origOnload(e); setTimeout(loadTempUsers, 1000); };
setTimeout(loadTempUsers, 1000);

export default AnnouncementPage

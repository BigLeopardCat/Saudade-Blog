import { Button, Form, Input, Modal, Table, message } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { getAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement } from '../../../apis/AnnouncementMethods.tsx'

const { TextArea } = Input

const AnnouncementPage = () => {
    const [data, setData] = useState<any[]>([])
    const [modalOpen, setModalOpen] = useState(false)
    const [editItem, setEditItem] = useState<any>(null)
    const [form] = Form.useForm()
    const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])
    /** 上一次拉列表的时刻，用来给"切回窗口就重拉"去抖（见下面那个 effect）。 */
    const lastLoadRef = useRef(0)

    const load = async () => {
        lastLoadRef.current = Date.now()
        const res = await getAnnouncements()
        if (res.status === 200) {
            setData(res.data.data.map((item: any) => ({ ...item, key: item.id })))
        }
    }

    /* 挂载时拉一次；**这个标签页重新可见 / 窗口重新获得焦点时再拉一次**（20260925）。
       —— 路由切进本页 = 重新挂载，所以"从别的页进来"这条已经由上面那句覆盖；漏掉的是
       **本页一直开着、agent 在别处发了公告**：名单就停在旧的那一版上。
       —— 为什么不订阅 `agent-turn-done`：后台是 `/` 的兄弟顶层路由，看板娘与对话面板只挂在
       前台那个壳里（见 `pages/Dashboard/index.tsx` 里那段注释）⇒ 这个页面**收不到**那个事件，
       能收到的是"用户切回来看"这个信号本身，那也正是想要最新列表的时刻。
       —— 两个信号切回来时会一起到（visibilitychange + focus），所以带去抖。 */
    useEffect(() => {
        void load()
        const refresh = () => {
            if (document.hidden) return
            if (Date.now() - lastLoadRef.current < 500) return
            void load()
        }
        document.addEventListener('visibilitychange', refresh)
        window.addEventListener('focus', refresh)
        return () => {
            document.removeEventListener('visibilitychange', refresh)
            window.removeEventListener('focus', refresh)
        }
    }, [])

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
        </div>
    )
}

export default AnnouncementPage

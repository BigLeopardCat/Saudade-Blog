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
        </div>
    )
}

export default AnnouncementPage

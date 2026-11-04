import { Button, Form, Input, Modal, Table, message } from 'antd'
/* 显式标注列类型：不标注的话 `responsive: ['lg']` 会被推成 `string[]`，
   而 `ColumnType.responsive` 要的是 `Breakpoint[]` —— tsc 直接在 `Table` 那行报不兼容。
   行类型照本页真实用到的四个字段写（不写 `<any>`：`no-explicit-any` 是会进 CI 的告警）。 */
import type { ColumnsType } from 'antd/es/table'

type AnnouncementRow = { id: number; title: string; content: string; createdAt: string }
import { useEffect, useRef, useState } from 'react'
import { getAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement } from '../../../apis/AnnouncementMethods.tsx'
import { notifyAnnouncementPublished } from '../../../components/AnnouncementModal/pending.ts'

import { runAdminMutation } from '../../../utils/adminMutation'

const { TextArea } = Input

const AnnouncementPage = () => {
    const [data, setData] = useState<AnnouncementRow[]>([])
    const [modalOpen, setModalOpen] = useState(false)
    const [editItem, setEditItem] = useState<AnnouncementRow | null>(null)
    const [form] = Form.useForm()
    const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])
    /** 上一次拉列表的时刻，用来给"切回窗口就重拉"去抖（见下面那个 effect）。 */
    const lastLoadRef = useRef(0)
    const mutationLock = useRef(false)
    const [busy, setBusy] = useState(false)

    const load = async () => {
        lastLoadRef.current = Date.now()
        try {
            const res = await getAnnouncements()
            if (res.status === 200 && res.data?.code === 200 && Array.isArray(res.data.data)) {
                setData(res.data.data.map((item: AnnouncementRow) => ({ ...item, key: item.id })))
            } else {
                message.error(res.data?.message || '公告加载失败，请重试')
            }
        } catch {
            message.error('公告加载失败，请检查网络后重试')
        }
    }

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
    const openEdit = (record: AnnouncementRow) => { setEditItem(record); form.setFieldsValue(record); setModalOpen(true) }

    const handleOk = () => runAdminMutation(mutationLock, setBusy, async () => {
        const values = await form.validateFields()
        return editItem
            ? updateAnnouncement(editItem.id, values)
            : createAnnouncement(values)
    }, () => {
        setModalOpen(false)
        message.success(editItem ? '已更新' : '已创建')
        notifyAnnouncementPublished()
        void load()
    }, (reason) => { message.error(reason) })

    const handleDelete = () => {
        if (selectedRowKeys.length === 0) { message.warning('请选择'); return }
        return runAdminMutation(mutationLock, setBusy,
            () => deleteAnnouncement(selectedRowKeys as number[]), () => {
                setSelectedRowKeys([])
                message.success('已删除')
                void load()
            }, (reason) => { message.error(reason) })
    }

    const columns: ColumnsType<AnnouncementRow> = [
        { title: 'ID', dataIndex: 'id', width: 60, responsive: ['lg'] },
        { title: '标题', dataIndex: 'title' },
        { title: '内容', dataIndex: 'content', ellipsis: true },
        { title: '时间', dataIndex: 'createdAt', width: 180, responsive: ['lg'] },
        {
            title: '操作', width: 100,
            render: (_: unknown, record: AnnouncementRow) => <a onClick={() => { if (!mutationLock.current) openEdit(record) }}>编辑</a>
        }
    ]

    return (
        <div style={{ padding: 24 }}>
            <div style={{ marginBottom: 16, display: 'flex', gap: 12 }}>
                <Button type="primary" disabled={busy} onClick={openCreate}>新增公告</Button>
                <Button danger disabled={busy} onClick={handleDelete}>删除选中</Button>
            </div>
            <Table
                rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys, getCheckboxProps: () => ({ disabled: busy }) }}
                columns={columns}
                dataSource={data}
                pagination={false}
            />
            <Modal
                title={editItem ? '编辑公告' : '新增公告'}
                open={modalOpen}
                onOk={handleOk}
                onCancel={() => { if (!mutationLock.current) setModalOpen(false) }}
                confirmLoading={busy}
                cancelButtonProps={{ disabled: busy }}
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

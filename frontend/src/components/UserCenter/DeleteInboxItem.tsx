import { DeleteOutlined } from '@ant-design/icons'
import { Button, message, Popconfirm } from 'antd'
import { useRef, useState } from 'react'
import { deleteMessage, deleteNotification, errMsg, ok } from '../../apis/ProfileMethods'
import type { UnreadSummary } from '../../interface/ProfileType'
import { Z } from '../../zIndex'
import { notifyUnreadChanged } from './unread'

type Item = { kind: 'notification'; id: number }
    | { kind: 'message'; id: number; folder: 'inbox' | 'outbox' }

export default function DeleteInboxItem({ item, onRemoved }: {
    item: Item
    onRemoved: (counts: UnreadSummary) => void
}) {
    const [busy, setBusy] = useState(false)
    const inFlight = useRef(false)
    const remove = async () => {
        if (inFlight.current) return
        inFlight.current = true
        setBusy(true)
        try {
            const res = item.kind === 'notification'
                ? await deleteNotification(item.id)
                : await deleteMessage(item.id, item.folder)
            if (!ok(res)) {
                message.error(errMsg(res, '删除失败，请稍后再试'))
                return
            }
            onRemoved(res.data.data)
            notifyUnreadChanged()
            message.success('已从你的列表删除')
        } catch {
            message.error('删除失败，请稍后再试')
        } finally {
            inFlight.current = false
            setBusy(false)
        }
    }
    return <span className="personalDelete" onClick={event => event.stopPropagation()}>
        <Popconfirm title="从你的列表删除？"
            description={item.kind === 'notification' ? '只移除本人的记录。' : '对方的信件会保留。'}
            okText="删除" cancelText="取消" okButtonProps={{ danger: true }}
            onConfirm={remove} zIndex={Z.modal + 10}
            getPopupContainer={trigger => trigger.parentElement ?? document.body}>
            <Button type="text" danger size="small" loading={busy} icon={<DeleteOutlined />}>
                删除
            </Button>
        </Popconfirm>
    </span>
}

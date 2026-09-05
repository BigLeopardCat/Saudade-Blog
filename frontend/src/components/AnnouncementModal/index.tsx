import { Modal } from 'antd'
import { useEffect, useState } from 'react'
import { getAnnouncements } from '../../apis/AnnouncementMethods.tsx'

/** 后端公告时间为 UTC（DB 连接 time_zone=+00:00），固定转为中国时间（UTC+8）显示。
 * 注意：不能 setHours(getHours()+8)（会叠加浏览器时区）；用时间戳 +8h 后按 UTC 字段读取，
 * 跨天（UTC 晚 8 点后 +8 到次日）自动进位。 */
const fmtCnTime = (s: string) => {
    if (!s) return ''
    const d = new Date(s.replace(' ', 'T') + 'Z')
    if (isNaN(d.getTime())) return s
    const cn = new Date(d.getTime() + 8 * 3600 * 1000)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${cn.getUTCFullYear()}-${p(cn.getUTCMonth() + 1)}-${p(cn.getUTCDate())} ${p(cn.getUTCHours())}:${p(cn.getUTCMinutes())}`
}

/**
 * 公告弹窗：antd Modal 默认白底卡片形态（20260905 去背景图回归——曾用 公告栏.png
 * 整卡背景图，图标文件已删除）。
 * 已读记忆按公告 id 对比（announcement_seen_id）：仅当存在比已看更新的公告时才弹出，
 * 避免旧实现（永久标记 announcement_seen）导致新公告永远无法触达老访客。
 */
const AnnouncementModal = () => {
    const [open, setOpen] = useState(false)
    const [announcement, setAnnouncement] = useState<any>(null)

    useEffect(() => {
        getAnnouncements().then(res => {
            if (res.status === 200 && res.data.data.length > 0) {
                const latest = res.data.data[0]
                // 已读记忆：按公告 id 对比，新公告（id 更大）才弹
                let seenId = 0
                try { seenId = parseInt(localStorage.getItem('announcement_seen_id') || '0', 10) || 0 } catch (e) { /* ignore */ }
                if (latest.id > seenId) {
                    setAnnouncement(latest)
                    setOpen(true)
                }
            }
        })
    }, [])

    const handleClose = () => {
        // 关闭（含读完）时才记录已读 id，避免弹窗出现即标记
        if (announcement) {
            try { localStorage.setItem('announcement_seen_id', String(announcement.id)) } catch (e) { /* ignore */ }
        }
        setOpen(false)
    }

    return (
        <Modal
            open={open}
            onCancel={handleClose}
            footer={null}
            width={520}
            centered
            maskClosable
            styles={{
                content: { borderRadius: 12, overflow: 'hidden' },
                close: { insetInlineEnd: 10, top: 10 },
            }}
        >
            <div style={{
                padding: '28px 32px 24px',
                maxHeight: '60vh',
                overflowY: 'auto',
                lineHeight: 1.9,
                fontSize: 15,
                color: '#333',
            }}>
                {announcement?.title && (
                    <div style={{
                        fontWeight: 700,
                        fontSize: 20,
                        marginBottom: 14,
                        color: '#222',
                        letterSpacing: 1,
                        textAlign: 'center',
                    }}>
                        {announcement.title}
                    </div>
                )}
                <div style={{ whiteSpace: 'pre-wrap', textAlign: 'justify' }}>{announcement?.content}</div>
                <div style={{ marginTop: 16, fontSize: 12, color: '#999', textAlign: 'right' }}>
                    {fmtCnTime(announcement?.updatedAt || announcement?.createdAt)}
                </div>
            </div>
        </Modal>
    )
}

export default AnnouncementModal

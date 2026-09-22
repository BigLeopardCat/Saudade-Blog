import { Modal } from 'antd'
import { useEffect, useState } from 'react'
import { getAnnouncements } from '../../apis/AnnouncementMethods.tsx'

/** 后端公告时间**已经是 +08:00 中国钟面**（DB 会话 time_zone=+08:00，见 CLAUDE.md 时区约定），
 * 原样展示即可，这里只做"去掉秒"的规范化——**不做任何时区换算**。
 * 20260922 修正：旧实现把 `s` 当 UTC（拼 'Z'）再 +8h，那是 20260827 统一时区**之前**的口径；
 * 时区统一后（main.rs `timezone(Some("+08:00"))` + 存量数据已迁移）DB 值即本地钟面，
 * 于是线上的公告时间整整多了 8 小时。刻意用字符串正则而不是 Date：只要不构造 Date，
 * 就不可能出现"浏览器时区/UTC 解释"这类二次偏移。 */
const fmtCnTime = (s: string) => {
    if (!s) return ''
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s)
    return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : s
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
            // 只给 content：rc-dialog 的 ModalStyles 只认 header/body/footer/mask/wrapper/content，
            // 写 styles.close 不会生效（关闭钮的定位在 index.sass 里）
            styles={{
                content: { borderRadius: 12, overflow: 'hidden' },
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

import { Modal } from 'antd'
import { useEffect, useState } from 'react'
import { getAnnouncements } from '../../apis/AnnouncementMethods.tsx'

const AnnouncementModal = () => {
    const [open, setOpen] = useState(false)
    const [announcement, setAnnouncement] = useState<any>(null)

    useEffect(() => {
        const hasSeen = localStorage.getItem('announcement_seen')
        if (hasSeen) return

        getAnnouncements().then(res => {
            if (res.status === 200 && res.data.data.length > 0) {
                setAnnouncement(res.data.data[0])
                setOpen(true)
                localStorage.setItem('announcement_seen', '1')
            }
        })
    }, [])

    return (
        <Modal
            title={announcement?.title || '公告'}
            open={open}
            onCancel={() => setOpen(false)}
            footer={null}
            width={520}
            centered
            styles={{
                body: {
                    padding: '20px 24px',
                    lineHeight: 1.8,
                    fontSize: 15,
                    color: 'var(--font-p-color)'
                }
            }}
        >
            <div style={{ whiteSpace: 'pre-wrap' }}>{announcement?.content}</div>
            <div style={{ marginTop: 16, fontSize: 12, color: '#999', textAlign: 'right' }}>
                {announcement?.createdAt}
            </div>
        </Modal>
    )
}

export default AnnouncementModal

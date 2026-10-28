import { Modal } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { useIsDarkMode } from '../../theme'
import { Z } from '../../zIndex'
import StickerText from '../StickerText'
import {
    fetchPendingAnnouncement,
    markAnnouncementRead,
    watchAnnouncements,
    type PendingAnnouncement,
} from './pending.ts'
import './index.sass'

// The API returns an Asia/Shanghai wall-clock value; do not apply another time-zone conversion.
const fmtCnTime = (s: string) => {
    if (!s) return ''
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s)
    return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : s
}

// Only acknowledgment marks an announcement read; closing it just dismisses this page session.
const AnnouncementModal = () => {

    const isDark = useIsDarkMode()
    const [pending, setPending] = useState<PendingAnnouncement | null>(null)
    const [open, setOpen] = useState(false)

    const checkingRef = useRef(false)

    const openRef = useRef(false)

    const closedIdsRef = useRef<Set<number>>(new Set())

    useEffect(() => {
        let alive = true
        const check = async () => {
            if (checkingRef.current || openRef.current) return
            checkingRef.current = true
            try {
                const p = await fetchPendingAnnouncement()
                if (!alive || !p || openRef.current || closedIdsRef.current.has(p.id)) return
                openRef.current = true
                setPending(p)
                setOpen(true)
            } catch {
                // A failed read is retried by the existing visibility/event watcher.
            } finally {
                checkingRef.current = false
            }
        }
        void check()
        const stop = watchAnnouncements(() => { void check() })
        return () => {
            alive = false
            stop()
        }
    }, [])

    const handleRead = () => {
        const p = pending
        openRef.current = false
        setOpen(false)
        if (!p) return
        closedIdsRef.current.add(p.id)
        void markAnnouncementRead(p)
    }

    const handleClose = () => {
        const p = pending
        openRef.current = false
        setOpen(false)
        if (p) closedIdsRef.current.add(p.id)
    }

    return (
        <Modal
            open={open}
            onCancel={handleClose}
            footer={null}
            width={520}
            centered
            maskClosable
            zIndex={Z.modal}
            rootClassName={isDark ? 'washiModal washiDark' : 'washiModal'}
            title={pending?.title ? (
                <div style={{
                    fontWeight: 700,
                    fontSize: 19,
                    lineHeight: 1.5,
                    letterSpacing: 1,
                    textAlign: 'center',
                    padding: '0 32px',
                }}>
                    {pending.title}
                </div>
            ) : null}
            styles={{
                header: {
                    padding: '8px 28px 6px',
                    marginBottom: 0,
                },
                body: { padding: '12px 28px 22px' },
            }}
        >

            <div className="washiScroll" tabIndex={0} aria-label="公告内容">

                <div className="washiText" style={{ whiteSpace: 'pre-wrap', textAlign: 'justify' }}>
                    <StickerText text={pending?.content || ''} />
                </div>
                <div className="washiTime" style={{ marginTop: 14, fontSize: 12, textAlign: 'right' }}>
                    {fmtCnTime(pending?.time || '')}
                </div>

                <div style={{ marginTop: 22, textAlign: 'center' }}>

                    <button
                        type="button"
                        className="washiOk"
                        onClick={handleRead}
                        style={{
                            minWidth: 148,
                            height: 40,
                            padding: '0 26px',
                            fontSize: 15,
                        }}
                    >
                        我知道了
                    </button>
                </div>
            </div>
        </Modal>
    )
}

export default AnnouncementModal

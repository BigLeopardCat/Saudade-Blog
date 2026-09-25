import { Button, Modal, theme } from 'antd'
import { useEffect, useRef, useState } from 'react'
import {
    fetchPendingAnnouncement,
    markAnnouncementRead,
    watchAnnouncements,
    type PendingAnnouncement,
} from './pending.ts'

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
 *
 * 判据 / 已读落点 / 复查时机全在 `pending.ts`（文件头把"为什么从 localStorage 水位
 * 搬到服务端""为什么只弹最新那条""读不到为什么不弹"讲完了）。这里只管三件事：
 *   ① 登记复查（挂载即查 + 四类事件 + 可见时 60 秒一拍）；
 *   ② 重入与"刚关掉的这条"的抑制；
 *   ③ 只负责显示，**点「我知道了」时才记已读**。
 *
 * 两个出口的分工（20260926 用户拍板，别再合并回去）：
 *   · 「我知道了」按钮 ⇒ `handleRead`：记已读（服务端那行标掉 ⇒ 红点与个人中心
 *     当场跟着掉 / 游客写本机水位）；
 *   · 点弹窗外、Esc、右上角 × ⇒ `handleClose`：**只收起卡片**。没点按钮就当没读过
 *     ⇒ 红点照旧亮、个人中心照旧未读、下次刷新照旧会弹。同一个标签页内不再反复弹
 *     同一张（会话级抑制），但那是"别打扰"，不是"算你读过"。
 *
 * 两处挂载（公共页壳 App.tsx / 后台 Dashboard 自己的壳）——**不是**挂在某个页面上，
 * 那正是"只有刷新才弹"的旧毛病：公告是站点级事件，弹窗得跟着壳走。 */
const AnnouncementModal = () => {
    const { token } = theme.useToken()
    const [pending, setPending] = useState<PendingAnnouncement | null>(null)
    const [open, setOpen] = useState(false)
    /** 正在查（防同一拍里几个触发源并发查同一件事） */
    const checkingRef = useRef(false)
    /** 已经弹着（查到了也不换正文，免得读到一半被替换） */
    const openRef = useRef(false)
    /**
     * 本次页面会话里**已经关掉过**的公告 id。它服务两种"关掉了但仍是未读"的情形：
     *   · 用户点弹窗外（遮罩/Esc/右上角 ×）收起卡片——按产品口径这**不算读过**，
     *     服务端那行照旧未读、红点照旧亮着（见 handleClose）；
     *   · 点了「我知道了」但服务端那次已读写失败。
     * 两种情形下服务端都仍判它未读，下一拍复查会再弹一次同一张卡 ⇒ 用户会遇上
     * "关不掉的弹窗"。这里是**内存里的会话级抑制**、不落盘、也不冒充已读：
     * 服务端那行照旧未读、红点照旧亮着、刷新/别的设备照旧会弹（那正是"仍是未读"
     * 的意思），只是不在同一个标签页里反复打扰。 */
    const closedIdsRef = useRef<Set<number>>(new Set())

    useEffect(() => {
        let alive = true
        const check = async () => {
            if (checkingRef.current || openRef.current) return
            checkingRef.current = true
            try {
                const p = await fetchPendingAnnouncement()
                // 读不到 ⇒ null ⇒ 什么都不做（不弹、也不清空当前状态，见 pending.ts 文件头）
                if (!alive || !p || openRef.current || closedIdsRef.current.has(p.id)) return
                openRef.current = true
                setPending(p)
                setOpen(true)
            } catch (e) {
                /* 查询本身抛了（网络/解析）：按"读不到"处理，等下一次复查 */
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

    /**
     * 点「我知道了」= 用户明确表态读过了 ⇒ 记已读（服务端那行标掉 / 游客写本机水位）。
     * 这是**唯一**会记已读的出入口（弹窗出现时不记——出现即标记等于替用户读了）。
     */
    const handleRead = () => {
        const p = pending
        openRef.current = false
        setOpen(false)
        if (!p) return
        closedIdsRef.current.add(p.id)
        void markAnnouncementRead(p)
    }

    /**
     * 从弹窗外关掉（点遮罩 / Esc / 右上角 ×）：**只是收起卡片，不记已读**。
     * 这是产品口径（20260926 用户拍板）：没点「我知道了」就当没读过——红点照旧亮、
     * 个人中心那份通知照旧是未读、下次刷新照旧会弹。
     * 只做一件事：把它压进本页会话的抑制集，免得 60 秒那一拍立刻把同一张卡又弹出来
     * （"关不掉的弹窗"）。抑制不落盘、不冒充已读，见 closedIdsRef。
     */
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
            // 只给 content：rc-dialog 的 ModalStyles 只认 header/body/footer/mask/wrapper/content，
            // 写 styles.close 不会生效（关闭钮的定位在 index.sass 里）
            styles={{
                content: { borderRadius: 12, overflow: 'hidden' },
            }}
        >
            {/* 配色一律取 antd token，不写死：同一张卡在公共页（无 ConfigProvider ⇒ 浅色）
                与后台（Dashboard 的 ConfigProvider(darkAlgorithm) ⇒ 深色）下都要能读
                ——后台那套是内联 style 的死对头（见 docs 里"内联 style 是夜间头号敌人"）。 */}
            <div style={{
                padding: '28px 32px 24px',
                maxHeight: '60vh',
                overflowY: 'auto',
                lineHeight: 1.9,
                fontSize: 15,
                color: token.colorText,
            }}>
                {pending?.title && (
                    <div style={{
                        fontWeight: 700,
                        fontSize: 20,
                        marginBottom: 14,
                        color: token.colorTextHeading,
                        letterSpacing: 1,
                        textAlign: 'center',
                    }}>
                        {pending.title}
                    </div>
                )}
                <div style={{ whiteSpace: 'pre-wrap', textAlign: 'justify' }}>{pending?.content}</div>
                <div style={{ marginTop: 16, fontSize: 12, color: token.colorTextTertiary, textAlign: 'right' }}>
                    {fmtCnTime(pending?.time || '')}
                </div>
                {/* 「我知道了」= 记已读的唯一入口（见 handleRead/handleClose 的分工）。
                    点弹窗外关掉这条**不**走这里 ⇒ 仍是未读。按钮配色取 antd token，
                    浅色（公共页）与深色（后台 ConfigProvider）下都读得清。 */}
                <div style={{ marginTop: 20, textAlign: 'center' }}>
                    <Button type="primary" onClick={handleRead} style={{ minWidth: 120 }}>
                        我知道了
                    </Button>
                </div>
            </div>
        </Modal>
    )
}

export default AnnouncementModal

/**
 * 首页顶带右栏：**公告栏**（20261004 用户第三报「置顶卡片细长太丑还占一整行，改为左半部分
 * 置顶轮播图，右半部分公告栏，公告栏UI符合博客设计语言」）。
 *
 * 职责只有一件：把公开公告列表摆成一张和纸小卡。**它不写任何已读状态** —— 站点级的
 * "未读提醒"仍归 `components/AnnouncementModal`（那个才有「我知道了」那颗按钮，也是记已读的
 * 唯一入口）。这里点开一条只是"看看"，不许顺手标已读：替用户表态是这个族最容易犯的错
 * （见 pending.ts 文件头那两条出口的分工）。
 *
 * 三条必须知道的：
 *  ① **三态必须分开**：加载中 / 读到且为空 / **读不到**。读不到时显示"读取失败 + 重试"，
 *     绝不落成空列表 —— 这是本仓的硬纪律（"读不到 ≠ 没有"，同 pending.ts 的「读不到就不弹」）。
 *     接口没有 `?limit`，前端 slice 前 5 条：接口默认全量是**别人依赖的语义**
 *     （pending.ts 吃 `list[0]`、agent 的 get_announcements 也读它），不给它加默认分页。
 *  ② 弹窗的皮直接复用 `components/AnnouncementModal/index.sass` 那身 `.washiModal`
 *     （同一份 CSS 两个引用方，Vite 去重）—— 不搬家、不抽 partial，省得动
 *     `tests/announcement-popup-mount.test.py` 的 sass 编译清单。
 *     Modal 是 Portal 到 body 的，`.frontDark` 够不着 ⇒ 深浅档由 `useIsDarkMode()` 递类名。
 *  ③ 纸条本身的配色全走 `--washi-*` 令牌（`.frontDark` 在前台 bundle 内，能自动翻转），
 *     **不写任何字面色**，也不写内联 style。
 */
import { useCallback, useEffect, useState } from 'react'
import { Modal } from 'antd'
import { getAnnouncements, type AnnouncementRow } from '../../../../apis/AnnouncementMethods'
import { ok } from '../../../../apis/ProfileMethods'
import { useIsDarkMode } from '../../../../theme'
import { fmtCnTime } from '../../../../utils/cnTime'
import { Z } from '../../../../zIndex'
// 弹窗的皮（`.washiModal`）与站点级公告弹窗共用同一份，见文件头第 ② 条
import '../../../../components/AnnouncementModal/index.sass'
import './index.sass'

/** 列表里露几条；更多时底部给「全部 N 条 ›」入口（用户 20261004 拍板） */
const LIST_PREVIEW = 5

type LoadState = 'loading' | 'ready' | 'failed'

const AnnounceBoard = () => {
    const isDark = useIsDarkMode()
    const [rows, setRows] = useState<AnnouncementRow[]>([])
    const [state, setState] = useState<LoadState>('loading')
    /** 弹窗开着没有；`detail` 非空 = 详情态，空 = 列表态（点「全部 N 条」进的那档） */
    const [open, setOpen] = useState(false)
    const [detail, setDetail] = useState<AnnouncementRow | null>(null)

    const load = useCallback(async () => {
        setState('loading')
        try {
            const res = await getAnnouncements()
            // ⚠️ 读不到 ≠ 没有（文件头第 ① 条）：只有 code=200 才认这是"公告就是这些"
            if (!ok(res)) { setState('failed'); return }
            const list = (res.data?.data ?? []) as AnnouncementRow[]
            setRows(Array.isArray(list) ? list : [])
            setState('ready')
        } catch (e) {
            setState('failed')
        }
    }, [])

    useEffect(() => { void load() }, [load])

    const openDetail = (row: AnnouncementRow) => { setDetail(row); setOpen(true) }
    const openAll = () => { setDetail(null); setOpen(true) }
    const close = () => { setOpen(false); setDetail(null) }

    const preview = rows.slice(0, LIST_PREVIEW)
    /** 详情态要不要给「返回」：只有从"全部"那一档进来才有列表可回（≤5 条时是直接点开的） */
    const canGoBack = detail !== null && rows.length > LIST_PREVIEW

    return (
        <div className="AnnounceBoard">
            <div className="abHead">
                <i className="iconfont icon-xiaoxi" aria-hidden="true"></i>
                <span className="abTitle">公告</span>
            </div>

            <div className="abBody">
                {state === 'loading' && (
                    // 骨架条：加载中**不是**空态（三态分离，见文件头）
                    <div className="abSkeleton" role="status" aria-label="公告加载中">
                        {[0, 1, 2, 3].map((i) => <div className="abSkeletonRow" key={i} />)}
                    </div>
                )}

                {state === 'failed' && (
                    <div className="abState">
                        <p>公告暂时读取失败</p>
                        <button type="button" className="abRetry" onClick={() => void load()}>重试</button>
                    </div>
                )}

                {state === 'ready' && rows.length === 0 && (
                    <div className="abState"><p>还没有公告</p></div>
                )}

                {state === 'ready' && preview.map((row) => (
                    <button
                        type="button"
                        className="abRow"
                        key={row.id}
                        onClick={() => openDetail(row)}
                        title={row.title}
                    >
                        <span className="abDate">{fmtCnTime(row.createdAt || '', { withTime: false })}</span>
                        <span className="abRowTitle">{row.title}</span>
                    </button>
                ))}
            </div>

            {state === 'ready' && rows.length > LIST_PREVIEW && (
                <button type="button" className="abMore" onClick={openAll}>
                    全部 {rows.length} 条 ›
                </button>
            )}

            <Modal
                open={open}
                onCancel={close}
                footer={null}
                width={520}
                centered
                // 与站点级公告弹窗同一档：公告要压在个人中心与看板娘面板之上（阶梯见 src/index.css）
                zIndex={Z.modal}
                rootClassName={isDark ? 'washiModal washiDark' : 'washiModal'}
                title={<div className="abModalTitle">{detail ? detail.title : `全部公告（${rows.length}）`}</div>}
                // 与 AnnouncementModal 的那套几何逐字相同（卡片顶→标题 28px、标题→正文 18px）：
                // 同一张皮，两处弹窗的顶边不该长得不一样
                styles={{
                    header: { padding: '8px 28px 6px', marginBottom: 0 },
                    body: { padding: '12px 28px 22px' },
                }}
            >
                <div className="abModalBody">
                    {detail ? (
                        <>
                            {canGoBack && (
                                <button type="button" className="abBack" onClick={() => setDetail(null)}>
                                    ‹ 返回列表
                                </button>
                            )}
                            <div className="washiText">{detail.content}</div>
                            <div className="washiTime">{fmtCnTime(detail.updatedAt || detail.createdAt || '')}</div>
                        </>
                    ) : (
                        rows.map((row) => (
                            <button
                                type="button"
                                className="abRow abRowModal"
                                key={row.id}
                                onClick={() => setDetail(row)}
                            >
                                <span className="abDate">{fmtCnTime(row.createdAt || '', { withTime: false })}</span>
                                <span className="abRowTitle">{row.title}</span>
                            </button>
                        ))
                    )}
                </div>
            </Modal>
        </div>
    )
}

export default AnnounceBoard

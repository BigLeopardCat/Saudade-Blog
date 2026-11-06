import {Line} from '@ant-design/plots';
import React, {useCallback, useEffect, useState} from "react";
import {Button, Card, Collapse, Empty, Segmented, Spin, Statistic, Table, Tag, Tabs} from "antd";
import type {TabsProps} from "antd";
import type {ColumnsType} from 'antd/es/table';
import CountUpDefault from "react-countup";
import { cjsDefault } from "../../../utils/cjsDefault";
import './index.sass'
import {errMsg, ok} from "../../../apis/ProfileMethods.tsx";
import {getNotePeriodReport, getNoteStatsReport, getUserStatsReport} from "../../../apis/NoteStatsMethods.tsx";
import type {
    DailyRow,
    NoteRankRow,
    NoteStatsReport,
    PeriodKind,
    PeriodReport,
    PeriodRow,
    UserActivityRow,
    UserStatsReport,
} from "../../../interface/NoteStatsType";
import {useIsDarkMode} from "../../../theme";

// react-countup 的 build 是 CJS，Vite 8 之后默认 import 可能拿到名字空间对象而不是组件
// （症状是 `Minified React error #130 … got: object`，判据与三种形态见 utils/cjsDefault.ts）。
// **不要改回 `import CountUp from "react-countup"`。**
const CountUp = cjsDefault(CountUpDefault)


/** 后端字段逐个过一道类型闸。`GET` 回来的是运行时数据，直接 `.map()`
 *  会在形状不对时把整棵子树炸掉（后台页面宁可少渲染一块，也不能白屏）。 */
const asRows = (v: unknown): NoteRankRow[] =>
    (Array.isArray(v) ? v : []).filter(
        (r): r is NoteRankRow => !!r && typeof r === 'object' && typeof (r as NoteRankRow).title === 'string'
    );

const asDaily = (v: unknown): DailyRow[] =>
    (Array.isArray(v) ? v : []).filter(
        (d): d is DailyRow => !!d && typeof d === 'object' && typeof (d as DailyRow).date === 'string'
    );

const asPeriods = (v: unknown): PeriodRow[] =>
    (Array.isArray(v) ? v : []).filter(
        (p): p is PeriodRow => !!p && typeof p === 'object' && typeof (p as PeriodRow).key === 'string'
    );

const asUsers = (v: unknown): UserActivityRow[] =>
    (Array.isArray(v) ? v : []).filter(
        (u): u is UserActivityRow => !!u && typeof u === 'object' && typeof (u as UserActivityRow).id === 'number'
    );

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 千分位。列表里的数字不会到百万级，但同一列宽度对齐要靠它（配 `.akRankNum` 的 tabular-nums）。 */
const fmt = (v: number): string => v.toLocaleString('en-US');

/** 粒度的可选项与默认期数。**`limit` 与后端 `Granularity::default_limit` 同值**——
 *  两边不一致时页面会"少一期"且从界面上看不出来。改一侧必须同时改另一侧。 */
const KINDS: { value: PeriodKind; label: string; limit: number; unit: string }[] = [
    {value: 'week', label: '周报', limit: 12, unit: '周'},
    {value: 'month', label: '月报', limit: 12, unit: '月'},
    {value: 'year', label: '年报', limit: 5, unit: '年'},
];

/** 排行榜一块：HTML 列表，不是图表。条宽按本块最大值归一 —— 四块各归各的，
 *  阅读量与点赞量本来就不在一个量级上，共用一把尺子会让点赞全成一条线。 */
const rankPanel = (
    title: string,
    rows: NoteRankRow[],
    metric: 'views' | 'likes' | 'favorites' | 'comments',
    accent: string,
    accentDark: string,
) => {
    const max = rows.reduce((m, r) => Math.max(m, num(r[metric])), 0)
    return (
        <div className="akPanel" style={{"--ak-accent": accent, "--ak-accent-dark": accentDark} as React.CSSProperties}>
            <h3>{title}</h3>
            {rows.length === 0 ? (
                <Empty description="还没有数据" image={Empty.PRESENTED_IMAGE_SIMPLE}/>
            ) : (
                <ol className="akRank">
                    {rows.map((r, i) => (
                        <li key={r.noteId}>
                            <span className="akRankNo">{i + 1}</span>
                            <span className="akRankBody">
                                <a className="akRankTitle" href={`/article/${r.noteId}`} target="_blank"
                                   rel="noreferrer" title={r.title}>{r.title}</a>
                                <span className="akRankBar">
                                    <span className="akRankBarFill"
                                          style={{width: max > 0 ? `${Math.max(2, (num(r[metric]) / max) * 100)}%` : '2%'}}/>
                                </span>
                            </span>
                            <span className="akRankNum">{fmt(num(r[metric]))}</span>
                        </li>
                    ))}
                </ol>
            )}
        </div>
    )
}

/* * 页签一：文章数据 */
const NoteData = () => {
    const isDarkMode = useIsDarkMode()
    const [report, setReport] = useState<NoteStatsReport | null>(null)
    const [loading, setLoading] = useState(true)
    const [err, setErr] = useState('')

    // 分期报表**单独一套状态**：切换粒度只该重拉这半边，不该把汇总卡与趋势
    // 一起带回加载屏（那是"换一个下拉框，整页闪一下"）。
    const [kind, setKind] = useState<PeriodKind>('week')
    const [periods, setPeriods] = useState<PeriodReport | null>(null)
    const [pLoading, setPLoading] = useState(true)
    const [pErr, setPErr] = useState('')
    // 失败后重试要能真的再发一次。**不能靠 `setKind(kind)`**——值没变，
    // React 会跳过重渲染，下面那个 effect 也就不会重跑（"点了没反应"）。
    const [pTick, setPTick] = useState(0)

    // `useCallback` 不是装饰：它让下面那个 effect 的依赖能**写实**
    // （`[load]` 而不是空数组 + 一条压告警的注释）。它的依赖确实是空的——
    // 里面只碰 setState（React 保证引用稳定）与模块级函数。
    const load = useCallback(() => {
        setLoading(true)
        setErr('')
        getNoteStatsReport().then((res) => {
            if (!ok(res)) {
                setErr(errMsg(res, '报表加载失败，请稍后再试'))
                return
            }
            const d = res.data.data
            setReport({
                generatedAt: typeof d?.generatedAt === 'string' ? d.generatedAt : '',
                totalViews: num(d?.totalViews),
                totalLikes: num(d?.totalLikes),
                totalFavorites: num(d?.totalFavorites),
                totalComments: num(d?.totalComments),
                topViewed: asRows(d?.topViewed),
                topLiked: asRows(d?.topLiked),
                topFavorited: asRows(d?.topFavorited),
                topCommented: asRows(d?.topCommented),
                daily: asDaily(d?.daily),
                dailyWindow: d.dailyWindow,
            })
        }).catch(() => {
            setErr('网络异常，请稍后再试')
        }).finally(() => setLoading(false))
    }, [])

    // 依赖数组是**必须的**：这个 effect 里会发起请求，写成
    // `useEffect(() => { setData(notes) })`（无依赖数组）等于每轮渲染都跑一遍，
    // 在真数据下会变成"渲染 → 请求 → setState → 渲染"的循环。
    // 依赖写 `[load]`（`load` 已被 useCallback 固定）——**不要再写成 `[]` + 一条
    // eslint-disable**：那条注释在本仓会被 `--report-unused-disable-directives`
    useEffect(() => {
        load()
    }, [load])

    useEffect(() => {
        const limit = KINDS.find((k) => k.value === kind)?.limit ?? 12
        setPLoading(true)
        setPErr('')
        getNotePeriodReport(kind, limit).then((res) => {
            if (!ok(res)) {
                setPErr(errMsg(res, '分期报表加载失败，请稍后再试'))
                return
            }
            const d = res.data.data
            setPeriods({
                generatedAt: typeof d?.generatedAt === 'string' ? d.generatedAt : '',
                kind,
                since: typeof d?.since === 'string' ? d.since : null,
                periods: asPeriods(d?.periods).map((p) => ({...p, topNotes: asRows(p.topNotes)})),
            })
        }).catch(() => {
            setPErr('网络异常，请稍后再试')
        }).finally(() => setPLoading(false))
    }, [kind, pTick])

    const trendData = (report?.daily ?? []).flatMap((d) => [
        {date: d.date, type: '阅读量', value: num(d.views)},
        {date: d.date, type: '点赞量', value: num(d.likes)},
        {date: d.date, type: '收藏量', value: num(d.favorites)},
        {date: d.date, type: '讨论量', value: num(d.comments)},
    ])
    const trendConfig = {
        data: trendData,
        xField: 'date',
        yField: 'value',
        colorField: 'type',
        theme: isDarkMode ? {type: 'classicDark'} : {type: 'classic'},
        height: 360,
        smooth: true,
        // 30 个日期横着排会糊成一片，只留「月-日」
        axis: {x: {labelFormatter: (v: string) => String(v).slice(5)}},
    }

    return (
        <div className="akPane">
            <div className="akHead">
                <div className="akHeadMeta">
                    {report?.generatedAt && <span>统计时间：{report.generatedAt}</span>}
                    <Tag color="blue">只统计当前可见文章</Tag>
                    <Button size="small" onClick={load} loading={loading}>刷新</Button>
                </div>
            </div>

            {err ? (
                <div className="akErr">
                    <p>{err}</p>
                    <Button size="small" onClick={load}>重试</Button>
                </div>
            ) : loading && !report ? (
                <div className="akLoading"><Spin/></div>
            ) : (
                <>
                    <div className="akSummary">
                        <Card className="akCard" style={{"--ak-bg": '#dbe7f5', "--ak-bg-dark": 'rgba(120, 170, 230, 0.16)'} as React.CSSProperties}>
                            <Statistic title="总阅读量" value={report?.totalViews ?? 0}
                                       formatter={(v) => <CountUp end={Number(v)} separator=","/>}/>
                        </Card>
                        <Card className="akCard" style={{"--ak-bg": '#fbcbd5', "--ak-bg-dark": 'rgba(251, 203, 213, 0.16)'} as React.CSSProperties}>
                            <Statistic title="总点赞量" value={report?.totalLikes ?? 0}
                                       formatter={(v) => <CountUp end={Number(v)} separator=","/>}/>
                        </Card>
                        <Card className="akCard" style={{"--ak-bg": '#e6e0c4', "--ak-bg-dark": 'rgba(226, 214, 160, 0.16)'} as React.CSSProperties}>
                            <Statistic title="总收藏量" value={report?.totalFavorites ?? 0}
                                       formatter={(v) => <CountUp end={Number(v)} separator=","/>}/>
                        </Card>
                        <Card className="akCard" style={{"--ak-bg": '#d9ecec', "--ak-bg-dark": 'rgba(140, 215, 215, 0.16)'} as React.CSSProperties}>
                            <Statistic title="总讨论量" value={report?.totalComments ?? 0}
                                       formatter={(v) => <CountUp end={Number(v)} separator=","/>}/>
                        </Card>
                    </div>

                    <div className="akPanels">
                        {rankPanel('阅读量 Top 10', report?.topViewed ?? [], 'views', '#4a54b8', '#a9b1f0')}
                        {rankPanel('点赞量 Top 10', report?.topLiked ?? [], 'likes', '#b03a63', '#f2a6c0')}
                        {rankPanel('收藏量 Top 10', report?.topFavorited ?? [], 'favorites', '#8a6a1f', '#e0c98a')}
                        {rankPanel('讨论量 Top 10', report?.topCommented ?? [], 'comments', '#1f7a6a', '#7fd4c4')}
                    </div>

                    <div className="akPanel akPanelWide">
                        <h3>最近 30 天趋势{report?.dailyWindow && (
                            <small>（{report.dailyWindow.start} 至 {report.dailyWindow.end}）</small>
                        )}</h3>
                        <div className="akChart">
                            {trendData.length === 0
                                ? <Empty description="还没有数据" image={Empty.PRESENTED_IMAGE_SIMPLE}/>
                                : <Line {...trendConfig} />}
                        </div>
                    </div>

                    <div className="akPanel akPanelWide akPeriods">
                        <div className="akPeriodsHead">
                            <h3>周报 / 月报 / 年报</h3>
                            <Segmented
                                size="small"
                                value={kind}
                                onChange={(v) => setKind(v as PeriodKind)}
                                options={KINDS.map((k) => ({value: k.value, label: k.label}))}
                            />
                        </div>
                        {pErr ? (
                            <div className="akErr">
                                <p>{pErr}</p>
                                <Button size="small" onClick={() => setPTick((n) => n + 1)}>重试</Button>
                            </div>
                        ) : pLoading && !periods ? (
                            <div className="akLoading"><Spin/></div>
                        ) : !periods || periods.periods.length === 0 ? (
                            // 与"本期没有数据"分开说：这里是**一行记录都还没有**
                            <Empty
                                image={Empty.PRESENTED_IMAGE_SIMPLE}
                                description={periods?.since
                                    ? `统计从 ${periods.since} 开始，还没有满一${KINDS.find((k) => k.value === kind)?.unit}`
                                    : '还没有统计数据'}
                            />
                        ) : (
                            <Collapse
                                ghost
                                className="akPeriodList"
                                items={periods.periods.map((p) => ({
                                    key: p.key,
                                    label: (
                                        <span className="akPeriodRow">
                                            <span className="akPeriodLabel">
                                                {p.label}
                                                {p.partial && <Tag color="orange" className="akPartial">部分统计</Tag>}
                                            </span>
                                            <span className="akPeriodNums">
                                                <span>阅读 {fmt(p.views)}</span>
                                                <span>点赞 {fmt(p.likes)}</span>
                                                <span>收藏 {fmt(p.favorites)}</span>
                                                <span>讨论 {fmt(p.comments)}</span>
                                            </span>
                                        </span>
                                    ),
                                    children: p.topNotes.length === 0 ? (
                                        <Empty
                                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                                            description={`这一${KINDS.find((k) => k.value === kind)?.unit}没有数据`}
                                        />
                                    ) : (
                                        <ol className="akRank">
                                            {p.topNotes.map((r, i) => (
                                                <li key={r.noteId}>
                                                    <span className="akRankNo">{i + 1}</span>
                                                    <span className="akRankBody">
                                                        <a className="akRankTitle" href={`/article/${r.noteId}`}
                                                           target="_blank" rel="noreferrer" title={r.title}>{r.title}</a>
                                                    </span>
                                                    <span className="akRankNums">
                                                        <span>阅读 {fmt(num(r.views))}</span>
                                                        <span>点赞 {fmt(num(r.likes))}</span>
                                                        <span>收藏 {fmt(num(r.favorites))}</span>
                                                        <span>讨论 {fmt(num(r.comments))}</span>
                                                    </span>
                                                </li>
                                            ))}
                                        </ol>
                                    ),
                                }))}
                            />
                        )}
                    </div>
                </>
            )}
        </div>
    )
}

/** 用户活动明细的列。**定在组件外面**：写在 JSX 里每轮渲染都会新建一份数组，
 *  而 antd 的 Table 会因此认定列变了（本页数据量小，但同页的趋势图已经在盯着渲染次数）。 */
const USER_COLUMNS: ColumnsType<UserActivityRow> = [
    {title: '用户', dataIndex: 'name', ellipsis: true},
    {title: '角色', dataIndex: 'role', width: 110},
    {title: '会话数', dataIndex: 'conversations', width: 100, align: 'right', render: (v: number) => fmt(num(v))},
    {title: '消息数', dataIndex: 'messages', width: 100, align: 'right', render: (v: number) => fmt(num(v))},
    {title: '讨论数', dataIndex: 'comments', width: 100, align: 'right', render: (v: number) => fmt(num(v))},
    {
        title: '最近活动', dataIndex: 'lastActiveAt', width: 170,
        // null = 既无会话也无消息。**显示「无活动」而不是空白**：
        // 空白会被读成"渲染坏了"（stats.rs 的口径原话）
        render: (v: string | null) => v ?? <span className="akMuted">无活动</span>,
    },
]

/* * 页签二：用户活跃 */
const UserActivity = () => {
    const [data, setData] = useState<UserStatsReport | null>(null)
    const [loading, setLoading] = useState(true)
    const [err, setErr] = useState('')

    const load = useCallback(() => {
        setLoading(true)
        setErr('')
        getUserStatsReport().then((res) => {
            if (!ok(res)) {
                setErr(errMsg(res, '用户报表加载失败，请稍后再试'))
                return
            }
            const d = res.data.data
            setData({
                generatedAt: typeof d?.generatedAt === 'string' ? d.generatedAt : '',
                roleCounts: Array.isArray(d?.roleCounts) ? d.roleCounts : [],
                totalUsers: num(d?.totalUsers),
                totalConversations: num(d?.totalConversations),
                totalMessages: num(d?.totalMessages),
                totalExecutions: num(d?.totalExecutions),
                totalComments: num(d?.totalComments),
                activeUsers7d: num(d?.activeUsers7d),
                activeUsers30d: num(d?.activeUsers30d),
                listedUsers: num(d?.listedUsers),
                users: asUsers(d?.users),
            })
        }).catch(() => {
            setErr('网络异常，请稍后再试')
        }).finally(() => setLoading(false))
    }, [])

    useEffect(() => {
        load()
    }, [load])

    const cards: { title: string; value: number; bg: string; bgDark: string }[] = [
        {title: '活跃用户（7 天）', value: data?.activeUsers7d ?? 0, bg: '#d8ecd6', bgDark: 'rgba(150, 220, 150, 0.16)'},
        {title: '活跃用户（30 天）', value: data?.activeUsers30d ?? 0, bg: '#dbe7f5', bgDark: 'rgba(120, 170, 230, 0.16)'},
        {title: '用户总数', value: data?.totalUsers ?? 0, bg: '#fbcbd5', bgDark: 'rgba(251, 203, 213, 0.16)'},
        {title: '总会话数', value: data?.totalConversations ?? 0, bg: '#e9dcf5', bgDark: 'rgba(190, 150, 240, 0.16)'},
        {title: '总消息数', value: data?.totalMessages ?? 0, bg: '#e6e0c4', bgDark: 'rgba(226, 214, 160, 0.16)'},
        {title: '总执行数', value: data?.totalExecutions ?? 0, bg: '#d5ecf0', bgDark: 'rgba(130, 210, 225, 0.16)'},
        {title: '总讨论数', value: data?.totalComments ?? 0, bg: '#d9ecec', bgDark: 'rgba(140, 215, 215, 0.16)'},
    ]

    return (
        <div className="akPane">
            <div className="akHead">
                <div className="akHeadMeta">
                    {data?.generatedAt && <span>统计时间：{data.generatedAt}</span>}
                    <Tag color="blue">活跃 = 最近有会话或消息</Tag>
                    <Button size="small" onClick={load} loading={loading}>刷新</Button>
                </div>
            </div>

            {err ? (
                <div className="akErr">
                    <p>{err}</p>
                    <Button size="small" onClick={load}>重试</Button>
                </div>
            ) : loading && !data ? (
                <div className="akLoading"><Spin/></div>
            ) : (
                <>
                    <div className="akSummary">
                        {cards.map((c) => (
                            <Card key={c.title} className="akCard"
                                  style={{"--ak-bg": c.bg, "--ak-bg-dark": c.bgDark} as React.CSSProperties}>
                                <Statistic title={c.title} value={c.value}
                                           formatter={(v) => <CountUp end={Number(v)} separator=","/>}/>
                            </Card>
                        ))}
                    </div>

                    <div className="akPanel akPanelWide">
                        <h3>角色分布</h3>
                        {(data?.roleCounts ?? []).length === 0
                            ? <Empty description="还没有数据" image={Empty.PRESENTED_IMAGE_SIMPLE}/>
                            : (
                                <div className="akRoles">
                                    {(data?.roleCounts ?? []).map((r) => (
                                        <Tag key={r.role}>{r.role}：{fmt(num(r.count))}</Tag>
                                    ))}
                                </div>
                            )}
                    </div>

                    <div className="akPanel akPanelWide">
                        <h3>用户活动明细</h3>
                        <Table<UserActivityRow>
                            size="small"
                            rowKey="id"
                            // 明细是"有活动的人"，不是全部账号——列名与总数分开说，
                            // 免得看的人拿 rows.length 去对"用户总数"
                            pagination={false}
                            dataSource={data?.users ?? []}
                            locale={{emptyText: <Empty description="还没有用户活动" image={Empty.PRESENTED_IMAGE_SIMPLE}/>}}
                            scroll={{y: 420}}
                            columns={USER_COLUMNS}
                        />
                    </div>
                </>
            )}
        </div>
    )
}

const Analytice = () => {
    const [tab, setTab] = useState('notes')
    const items: TabsProps['items'] = [
        {key: 'notes', label: <h3>文章数据</h3>, children: <NoteData/>},
        {key: 'users', label: <h3>用户活跃</h3>, children: <UserActivity/>},
    ]
    return (
        <div className='analyticsBody'>
            <h2 className="akTitle">数据统计</h2>
            <Tabs activeKey={tab} onChange={setTab} items={items}/>
        </div>
    );
};

export default Analytice

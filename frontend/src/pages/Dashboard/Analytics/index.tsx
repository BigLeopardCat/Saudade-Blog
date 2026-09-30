import {Line} from '@ant-design/plots';
import React, {useCallback, useEffect, useState} from "react";
import {Button, Card, Collapse, Empty, Segmented, Spin, Statistic, Table, Tag, Tabs} from "antd";
import type {TabsProps} from "antd";
import type {ColumnsType} from 'antd/es/table';
import CountUp from "react-countup";
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

/**
 * 数据统计（20260930 整页重写；20261001 加页签、收藏量、周月年报）。**此前这一页是写死的
 * 假数据**：一张 2022-2024 的月更折线 + 一张七个假分类的饼图，跟本站的真实内容没有任何关系。
 *
 * 两个页签（形制照「用户管理」那一页，`label` 用 `<h3>`）：
 *
 *   · **文章数据** —— 阅读量 / 点赞量 / 收藏量，三个汇总卡 + 三个全局榜 + 30 天趋势，
 *     外加**周报 / 月报 / 年报**（按期一张可展开的列表）。数据源
 *     `GET /api/protected/stats/notes`（当下快照）与 `.../notes/periods`（分期）。
 *   · **用户活跃** —— 直接渲染 `GET /api/protected/stats/users`（`src/routes/stats.rs`）。
 *     那份端点的**第一个后台消费方**就是本页；它同时还在给看板娘的用户报表供数，
 *     所以这里只排版、不加工口径。
 *
 * 口径三条（与后端模块头注同源，改的时候一起看）：
 *
 * 1. **只统计"当前可见"的文章**。已转草稿/私密的文章连同它的历史阅读量一起排除——
 *    报表的三个数字（总量、排行、趋势）用同一个可见集，不然它们会自己跟自己打架。
 *    注意这与"删文章"不同：删文章走外键 CASCADE，那些行是真的没了，
 *    所以**总阅读量会变小**，"只增不减"在本页不成立（页面上有一枚 Tag 说明口径）。
 * 2. **`daily` 已经由后端补零**（最近 30 天天天有一条），前端不要再自己拼日期，
 *    否则就是第二份"哪几天该有数据"的真相源。
 * 3. **读不到 ≠ 0**。请求失败时显示错误与重试，**绝不显示 0**——一个假的 0
 *    会让人以为网站真的没人看（仓内纪律，同 components/UserCenter/favorites.ts 头注）。
 *    分期列表还多一层：**期界早于统计起点的整期已被后端剔除**，`since` 为 null 表示
 *    "一行记录都还没有"，与"统计了但都是 0"是两件事，界面上要分开说。
 *
 * 图表只用了 `@ant-design/plots` 一条通路（`Bar`/`Column`/`Pie` 都在这个包里；
 * 本页此前是 `Pie` 取自 `@ant-design/charts`、`Line` 取自 plots——同一套 G2v2 包装的
 * 两条版本线，同时引会把 G2 运行时打进两份）。**排行榜刻意不用图表库**：
 * 标题长短差得远，图表里必然要截断，而这一页的价值恰恰是"哪几篇"——
 * 所以排行是 HTML 列表（完整标题 + 一条按比例的背景条），
 * 只有趋势那一张用真图表（30 个点连成的三条线是 HTML 拼不出来的东西）。
 */

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

/** 排行榜一块：HTML 列表，不是图表。条宽按本块最大值归一 —— 三块各归各的，
 *  阅读量与点赞量本来就不在一个量级上，共用一把尺子会让点赞全成一条线。 */
const rankPanel = (
    title: string,
    rows: NoteRankRow[],
    metric: 'views' | 'likes' | 'favorites',
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

/** ── 页签一：文章数据 ─────────────────────────────────────────────────────── */
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
                topViewed: asRows(d?.topViewed),
                topLiked: asRows(d?.topLiked),
                topFavorited: asRows(d?.topFavorited),
                daily: asDaily(d?.daily),
            })
        }).catch(() => {
            setErr('网络异常，请稍后再试')
        }).finally(() => setLoading(false))
    }, [])

    // 依赖数组是**必须的**：这个 effect 里会发起请求，写成上一版那样
    // `useEffect(() => { setData(notes) })`（无依赖数组）等于每轮渲染都跑一遍，
    // 在真数据下会变成"渲染 → 请求 → setState → 渲染"的循环。
    // 依赖写 `[load]`（`load` 已被 useCallback 固定）——**不要再写成 `[]` + 一条
    // eslint-disable**：那条注释在本仓会被 `--report-unused-disable-directives`
    // 判成 error，整个 check job 变红 ⇒ 那次 push 一个字节都不会部署（吃过一次）。
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

    // G2 不吃 antd 的 darkAlgorithm（两套主题系统互不相干），要**显式**告诉图表
    // 现在是哪一档——这正是本页此前挂在 dark-mode-contrast 探针 KNOWN 里的那条。
    const trendData = (report?.daily ?? []).flatMap((d) => [
        {date: d.date, type: '阅读量', value: num(d.views)},
        {date: d.date, type: '点赞量', value: num(d.likes)},
        {date: d.date, type: '收藏量', value: num(d.favorites)},
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
                    {/* 口径写在页面上：数字变小（删了文章）时，看的人要知道为什么 */}
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
                    {/* 卡面颜色走 CSS 变量、由 .akCard 的类规则落地，**不写内联色**：
                        内联样式特异性最高，颜色写死在那里 `.dark &` 就永远赢不了它
                        （20260923 后台接 antd 深色 token 时就栽在这上面，白字压浅底 1.26:1）。 */}
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
                    </div>

                    <div className="akPanels">
                        {rankPanel('阅读量 Top 10', report?.topViewed ?? [], 'views', '#4a54b8', '#a9b1f0')}
                        {rankPanel('点赞量 Top 10', report?.topLiked ?? [], 'likes', '#b03a63', '#f2a6c0')}
                        {rankPanel('收藏量 Top 10', report?.topFavorited ?? [], 'favorites', '#8a6a1f', '#e0c98a')}
                    </div>

                    <div className="akPanel akPanelWide">
                        <h3>最近 30 天趋势</h3>
                        <div className="akChart">
                            {trendData.length === 0
                                ? <Empty description="还没有数据" image={Empty.PRESENTED_IMAGE_SIMPLE}/>
                                : <Line {...trendConfig} />}
                        </div>
                    </div>

                    {/* ── 周报 / 月报 / 年报 ─────────────────────────────────────────
                        形制是**一张可展开的期列表**：折叠态给出"哪一期、三个数"，
                        展开才是这一期的正文（阅读量前 5 名）。这样十二期能一屏扫完，
                        想深看哪一期就点哪一期。 */}
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
                                                {/* 上线那一期只有半截数据 —— 不标出来会被读成"那期流量掉了" */}
                                                {p.partial && <Tag color="orange" className="akPartial">部分统计</Tag>}
                                            </span>
                                            <span className="akPeriodNums">
                                                <span>阅读 {fmt(p.views)}</span>
                                                <span>点赞 {fmt(p.likes)}</span>
                                                <span>收藏 {fmt(p.favorites)}</span>
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
    {
        title: '最近活动', dataIndex: 'lastActiveAt', width: 170,
        // null = 既无会话也无消息。**显示「无活动」而不是空白**：
        // 空白会被读成"渲染坏了"（stats.rs 的口径原话）
        render: (v: string | null) => v ?? <span className="akMuted">无活动</span>,
    },
]

/** ── 页签二：用户活跃 ─────────────────────────────────────────────────────── */
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
    ]

    return (
        <div className="akPane">
            <div className="akHead">
                <div className="akHeadMeta">
                    {data?.generatedAt && <span>统计时间：{data.generatedAt}</span>}
                    {/* "活跃"的口径不写出来就会被读成"登录过"——见 stats.rs 模块头注 */}
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

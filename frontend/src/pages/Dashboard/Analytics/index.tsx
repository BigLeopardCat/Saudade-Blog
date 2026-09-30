import {Line} from '@ant-design/plots';
import React, {useEffect, useState} from "react";
import {Button, Card, Empty, Spin, Statistic, Tag} from "antd";
import CountUp from "react-countup";
import './index.sass'
import {errMsg, ok} from "../../../apis/ProfileMethods.tsx";
import {getNoteStatsReport} from "../../../apis/NoteStatsMethods.tsx";
import type {DailyRow, NoteRankRow, NoteStatsReport} from "../../../interface/NoteStatsType";
import {useIsDarkMode} from "../../../theme";

/**
 * 文章数据报表（20260930 整页重写）。**此前这一页是写死的假数据**：一张 2022-2024 的
 * 月更折线 + 一张七个假分类的饼图，跟本站的真实内容没有任何关系。
 *
 * 现在只做两件事：**阅读量**与**点赞量**（用户点名"只做阅读量、点赞量报表的文章报表"）。
 * 数据源是 `GET /api/protected/stats/notes`（`src/routes/note_stats.rs`），口径三条：
 *
 * 1. **只统计"当前可见"的文章**。已转草稿/私密的文章连同它的历史阅读量一起排除——
 *    报表的三个数字（总量、排行、趋势）用同一个可见集，不然它们会自己跟自己打架。
 *    注意这与"删文章"不同：删文章走外键 CASCADE，那些行是真的没了，
 *    所以**总阅读量会变小**，"只增不减"在本页不成立（页面上有一枚 Tag 说明口径）。
 * 2. **`daily` 已经由后端补零**（最近 30 天天天有一条），前端不要再自己拼日期，
 *    否则就是第二份"哪几天该有数据"的真相源。
 * 3. **读不到 ≠ 0**。请求失败时显示错误与重试，**绝不显示 0**——一个假的 0
 *    会让人以为网站真的没人看（仓内纪律，同 components/UserCenter/favorites.ts 头注）。
 *
 * 图表只用了 `@ant-design/plots` 一条通路（`Bar`/`Column`/`Pie` 都在这个包里；
 * 本页此前是 `Pie` 取自 `@ant-design/charts`、`Line` 取自 plots——同一套 G2v2 包装的
 * 两条版本线，同时引会把 G2 运行时打进两份）。**排行榜刻意不用图表库**：
 * 标题长短差得远，图表里必然要截断，而这一页的价值恰恰是"哪几篇"——
 * 所以排行是 HTML 列表（完整标题 + 一条按比例的背景条），
 * 只有趋势那一张用真图表（30 个点连成的两条线是 HTML 拼不出来的东西）。
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

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const Analytice = () => {
    const isDarkMode = useIsDarkMode()
    const [report, setReport] = useState<NoteStatsReport | null>(null)
    const [loading, setLoading] = useState(true)
    const [err, setErr] = useState('')

    const load = () => {
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
                topViewed: asRows(d?.topViewed),
                topLiked: asRows(d?.topLiked),
                daily: asDaily(d?.daily),
            })
        }).catch(() => {
            setErr('网络异常，请稍后再试')
        }).finally(() => setLoading(false))
    }

    // 依赖数组是**必须的**：这个 effect 里会发起请求，写成上一版那样
    // `useEffect(() => { setData(notes) })`（无依赖数组）等于每轮渲染都跑一遍，
    // 在真数据下会变成"渲染 → 请求 → setState → 渲染"的循环。
    useEffect(() => {
        load()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // G2 不吃 antd 的 darkAlgorithm（两套主题系统互不相干），要**显式**告诉图表
    // 现在是哪一档——这正是本页此前挂在 dark-mode-contrast 探针 KNOWN 里的那条。
    const trendData = (report?.daily ?? []).flatMap((d) => [
        {date: d.date, type: '阅读量', value: num(d.views)},
        {date: d.date, type: '点赞量', value: num(d.likes)},
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

    /** 排行榜一块：HTML 列表，不是图表。条宽按本块最大值归一 —— 两块各归各的，
     *  阅读量与点赞量本来就不在一个量级上，共用一把尺子会让点赞全成一条线。 */
    const rankPanel = (title: string, rows: NoteRankRow[], metric: 'views' | 'likes', accent: string, accentDark: string) => {
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
                                <span className="akRankNum">{num(r[metric])}</span>
                            </li>
                        ))}
                    </ol>
                )}
            </div>
        )
    }

    return (
        <div className='analyticsBody'>
            <div className="akHead">
                <h2>文章数据报表</h2>
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
                    </div>

                    <div className="akPanels">
                        {rankPanel('阅读量 Top 10', report?.topViewed ?? [], 'views', '#4a54b8', '#a9b1f0')}
                        {rankPanel('点赞量 Top 10', report?.topLiked ?? [], 'likes', '#b03a63', '#f2a6c0')}
                    </div>

                    <div className="akPanel akPanelWide">
                        <h3>最近 30 天趋势</h3>
                        <div className="akChart">
                            {trendData.length === 0
                                ? <Empty description="还没有数据" image={Empty.PRESENTED_IMAGE_SIMPLE}/>
                                : <Line {...trendConfig} />}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};

export default Analytice

import './index.sass'
import { useEffect, useMemo, useState } from "react";
import { Button, Grid, Input, Modal, Pagination, Popconfirm, Switch, Table, Tag, Tooltip, message } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from 'antd/es/table';
import http from "../../../apis/axios.tsx";
import { useLiveRefresh } from "../../../utils/liveRefresh.ts";
// 违规类型预设 / 驳回理由上限 / AI 审核列的 tooltip 与评论管理页共用（20261002）。
// 三样都是"同一件事"而不是"长得像"：审核标准、同一个字数上限、同一处 markup——
// 判据与不共用的部分见 `../ContentManage/shared.tsx` 头注。
import { BOARD_REJECT_PRESETS, REJECT_REASON_MAX, aiTip } from "../ContentManage/shared";

/** 留言管理（**20261002 之前它叫「评论管理」**——名字与内容对不上：这一页管的一直是
 *  河灯留言。文章评论另有 `Dashboard/CommentManage`，两张表两条接口，别搞混）。
 *  河灯留言的查询/筛选/删除 + 两段审核（20260905 issue9 双状态显示）
 *  数据来自 /api/protect/board（仅 src=board 的留言，与说说完全独立）。
 *  审核开关存 web_info（aiReviewEnabled/manualReviewEnabled），读写 /api/protected/websetting：
 *    · AI 审核开  → AI 通过/拒绝直接落地，存疑进入人工复核
 *    · 人工复核开 → 无论 AI 结果如何，新留言都先进待审，管理员裁决后才完成审核
 *    · 两闸可叠加；待审留言在本页人工审核列/操作列裁决
 *  双段状态（每行独立两列，互不覆盖）：
 *    · AI 审核  = ai_result：拦截（flag，AI 初审判疑似转人工）/ 通过（pass）/
 *                 未审（null——AI 关、人工全审模式、审核服务不可用转人工或存量历史行）
 *    · 人工审核 = approved：通过(1) 放行展示 / 待审(0) / 未通过(2, 驳回，issue8 起)
 *      ——「AI 拦截 → 人工通过/驳回」的两段经过一目了然
 *  驳回理由（20260923）：驳回弹窗里手填（≤200 字），落 talk.reject_reason；终态（通过/
 *  驳回/改判）都会给发布者发一条站内通知，驳回通知里带上理由。理由只随驳回存在——
 *  恢复通过即清空。
 *  20260926 三处改动（用户报「AI 的驳回理由为什么是未填写、通知里的违规理由太模糊」）：
 *    · 弹窗里**理由必填**（空理由时「确认驳回」禁用）——留空的结果是发布者收到一句
 *      "不符合留言板的留言规范"，既不知道问题在哪、也不知道去哪儿看，等于白发一条通知；
 *    · **常见违规类型预设**（点一下填进可编辑的文本框）＋**一键采用 AI 说明**
 *      （aiReason 非空时才显示）——AI 的判断管理员先看得到，才写得出具体理由；
 *    · 「AI 审核」列的 tooltip 里补上 `aiReason` 全文（此前那一列只显示裁决词，
 *      AI 的说明在整个系统里只存在于 AI 服务那一次的 HTTP 响应里）。
 *  后端**不加**理由必填的硬闸（审核接口是脚本/老前端也在用的兼容面），必填是这一层的
 *  保证；后端做的是"没写理由时按 人工 > reject_reason > aiReason 回落"（见 talks.rs）。
 *  20260926 第二处改动（用户报「评论状态变更前端跟不上 agent」）：这一页此前**只在挂载时**
 *  拉一次、也没有刷新入口 ⇒ 主人开着这一页、让看板娘替她驳回一条，界面纹丝不动。现在接
 *  `utils/liveRefresh.ts`（看板娘收尾事件 / 切回可见 / 20 秒轮询）＋工具栏一个「刷新」按钮；
 *  弹窗开着时那几轮一律不拉（见下面 `useLiveRefresh` 那段的理由）。
 */
interface BoardItem {
    talkKey: number;
    content: string;
    cat: string;
    v: number;
    author: string;
    createTime: string;
    userId: number;
    username: string;
    nickname: string;
    approved: number;
    /** AI 审核判定留痕：pass / reject / flag（存疑）/ null=未审 */
    ai_result?: string | null;
    /** 驳回理由（20260923）：AI 判定说明或管理员驳回时手填；null = 未驳回或没写 */
    rejectReason?: string | null;
    /** AI 审核说明（20260926）：**与裁决无关**（pass/flag/reject 都可能有），null = 没走
     *  AI / AI 没给说明 / 存量行。它是"AI 当时怎么看这条留言"的留痕，只给后台看 */
    aiReason?: string | null;
}

// 驳回理由预设（`BOARD_REJECT_PRESETS`）、理由上限（`REJECT_REASON_MAX`）与 AI 审核列的
// tooltip（`aiTip`）自 20261002 起都在 `../ContentManage/shared`——与评论管理页共用一份，
// 见那里的头注。（本页原先那份本地副本已删；`aiTip` 的 className 随之从 `bm-ai-tip`
// 换成共享的 `content-ai-tip`。）

const CATS = ['愿', '寄', '忆', '诉'];
const LAMP_NAMES = ['莲花灯', '八角灯', '圆笼灯'];
/** 每页条数：分页从 Table 搬到外面那一条，这里的数就是唯一真源（两处都得用它） */
const PAGE_SIZE = 10;

const BoardManage = () => {
    const [items, setItems] = useState<BoardItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [catFilter, setCatFilter] = useState(''); // 类型筛选（空 = 全部）
    const [query, setQuery] = useState(''); // 关键词：留言/留名/用户名/昵称
    const [asc, setAsc] = useState(false); // 时序正序/倒序
    // 审核开关（web_info key-value，缺省关）
    const [aiOn, setAiOn] = useState(false);
    const [manualOn, setManualOn] = useState(false);
    // 驳回弹窗（20260923）：驳回要能说明理由，理由会随审核结果通知发给发布者
    const [rejecting, setRejecting] = useState<BoardItem | null>(null);
    const [rejectReason, setRejectReason] = useState('');
    const [rejectBusy, setRejectBusy] = useState(false);

    /** 拉列表。`silent` = 这一次是**背景重拉**（看板娘收尾事件 / 20 秒轮询）：
     *  · 不闪表格的 loading——后台每 20 秒抖一下 spinner，会让人以为页面自己在动；
     *  · 失败也不弹提示——服务端真挂了的话，主人手动点一次「刷新」会弹；每 20 秒叠一条
     *    「获取留言失败」只会把页面刷满，反而盖住别的东西。
     *  手动那一次（挂载 / 工具栏「刷新」）照旧给反馈。 */
    const load = async (opts?: { silent?: boolean }) => {
        if (!opts?.silent) setLoading(true);
        try {
            const res = await http.get('/api/protect/board');
            setItems(Array.isArray(res?.data?.data) ? res.data.data : []);
        } catch {
            if (!opts?.silent) message.error('获取留言失败');
        } finally {
            if (!opts?.silent) setLoading(false);
        }
    };

    const loadSwitches = async () => {
        try {
            const res = await http.get('/api/protected/websetting');
            const d = res?.data?.data;
            if (d) {
                setAiOn(!!d.aiReviewEnabled);
                setManualOn(!!d.manualReviewEnabled);
            }
        } catch { /* 读取失败保持默认关，入库判定与服务端一致 */ }
    };

    /** 这一页的「重拉一次」= 列表 + 两个审核开关（开关也可能在别处被改，是同一份服务端状态）。
     *  挂载、工具栏「刷新」、事件与轮询全走这一条，少一条路径就少一处会漂的判据。 */
    const refresh = async (opts?: { silent?: boolean }) => {
        await Promise.all([load(opts), loadSwitches()]);
    };

    useEffect(() => {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* 跨端同步（20260926，用户报「评论状态变更前端跟不上 agent，要刷新网页」）：
     * 看板娘从服务端驳回/通过一条留言时，本页此前只在挂载时拉过一次 ⇒ 界面一直停在旧状态，
     * 而这是最典型的用法（主人让 agent 替她审，自己开着这一页看结果）。
     *
     * `skip`（弹窗开着就不拉）不是保险起见：驳回弹窗里那个文本框是**主人正在写**的东西，
     * 一次背景重拉虽然不会清掉它的值，但会让列表在弹窗底下换掉/行序变化，而弹窗认的是
     * 那一行对象 ⇒ 主人按下「确认驳回」时，落到的可能是已经变样的列表。本地有未提交的
     * 输入时一律不覆盖（同后台首页待办卡的 `pendingReload` 纪律）。 */
    useLiveRefresh(() => refresh({ silent: true }), { skip: () => !!rejecting });

    /** 开关切换：乐观更新，POST websetting 落 web_info；失败回滚 */
    const toggleReview = async (key: 'aiReviewEnabled' | 'manualReviewEnabled', on: boolean) => {
        const setter = key === 'aiReviewEnabled' ? setAiOn : setManualOn;
        const prev = key === 'aiReviewEnabled' ? aiOn : manualOn;
        setter(on);
        try {
            const res = await http.post('/api/protected/websetting', { [key]: on });
            if (res.data?.code !== 200) {
                setter(prev);
                message.error(res.data?.message || '保存失败');
            }
        } catch {
            setter(prev);
            message.error('保存失败');
        }
    };

    /** 人工复核：通过(1)=放行展示 / 驳回(0)=写未通过(2)隐藏。**两态都能改判**：
     *  已通过的可以再驳回（收回展示，20260930）、已驳回的可以「恢复通过」。
     *  （仅河灯留言，后端有 src 守卫；人工裁决不改写 ai_result，AI 判定留痕保留）
     *  reason 只在驳回时有意义（通过时后端会清空理由，传了也不生效） */
    const audit = async (id: number, approved: number, reason?: string) => {
        try {
            const res = await http.put(`/api/protect/board/${id}/audit`, { approved, reason });
            if (res.data?.code === 200) {
                message.success(approved === 1 ? '已通过，留言板展示' : '已驳回（未通过），不展示');
                // ⚠️ **入参值 ≠ 落库值**（20260926 修）：入参 0 = 「驳回」这个动作，后端落库
                // 的是 2（未通过，见 talks.rs::audit_board 的 `Set(if reject { 2 } else { 1 })`）。
                // 这里原样把入参写回本地行 ⇒ 驳回后那一行仍停在 `approved: 0`（待审）：
                // 「人工审核」列还是金色「待审」、操作列还挂着「通过/驳回」两颗按钮（能再点一次
                // 驳回）、正文下面的驳回理由一个字都不显示（那一段的渲染条件是 `approved === 2`）
                // —— 后端明明已经改完了，界面要等下次 load() 才追上；而"只改本地那一行"这个
                // 优化的全部意义就是不去 load()。
                const stored = approved === 1 ? 1 : 2;
                // 只改本地那一行（接口已确认成功）：原来每次都 load() 重拉全量列表，
                // 连审 10 条就是 11 次全量请求、每次带全部content
                // 驳回后的理由以后端为准：本次没填而后端回落到已有理由/AI 说明时，
                // 本地不能显示成空（回落链与后端一致：人工 > reject_reason > aiReason）
                setItems((prev) => prev.map((it) => (it.talkKey === id
                    ? {
                        ...it,
                        approved: stored,
                        rejectReason: stored === 2
                            ? (reason?.trim() || it.rejectReason || it.aiReason || null)
                            : null, // 通过（含改判）后端会清空理由（aiReason 留痕不动）
                    }
                    : it)));
            } else {
                message.error(res.data?.message || '操作失败');
            }
            return res.data?.code === 200;
        } catch {
            message.error('操作失败');
            return false;
        }
    };

    /** 弹窗确认驳回：理由可留空，后端在留空时回落到已有理由（AI 判定说明） */
    const confirmReject = async () => {
        if (!rejecting) return;
        setRejectBusy(true);
        const ok = await audit(rejecting.talkKey, 0, rejectReason);
        setRejectBusy(false);
        if (ok) {
            setRejecting(null);
            setRejectReason('');
        }
    };

    /* 查询筛选：类型 + 关键词 + 时序（倒序默认，新近在前），类似灯影集的检索体验 */
    const filtered = useMemo(() => {
        const q = query.trim();
        return [...items]
            .filter((it) => catFilter === '' || it.cat === catFilter)
            .filter((it) =>
                q === '' ||
                it.content.includes(q) ||
                it.author.includes(q) ||
                it.nickname.includes(q) ||
                it.username.includes(q)
            )
            .sort((a, b) => {
                const cmp = a.createTime < b.createTime ? -1 : a.createTime > b.createTime ? 1 : 0;
                return asc ? cmp || a.talkKey - b.talkKey : -cmp || b.talkKey - a.talkKey;
            });
    }, [items, catFilter, query, asc]);

    /** 分页（20260926 从 Table 搬到这条页脚上，见下面 .bm-scroll 的说明）。
     *  当前页只切**已经筛过**的那份，所以筛选条件一变就得回到第一页——否则会停在
     *  「第 3 页」而结果只有 1 页，表格空着、看着像"筛出来什么都没有"。 */
    const [page, setPage] = useState(1);
    useEffect(() => { setPage(1); }, [catFilter, query, asc]);
    const pageRows = useMemo(
        () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        [filtered, page],
    );
    /* 删除留言：管理员确认后删除，留言板不再展示 */
    const del = async (id: number) => {
        try {
            const res = await http.delete(`/api/protect/board/${id}`);
            if (res.data?.code === 200) {
                message.success('已删除');
                setItems((prev) => prev.filter((it) => it.talkKey !== id)); // 同上：本地剔除，不重拉全量
            } else {
                message.error(res.data?.message || '删除失败');
            }
        } catch {
            message.error('删除失败');
        }
    };

    /* ⚠️ **窄屏裁列 + 收窄（20261006 用户第 6 条）**：视口 < `screenLG`（本仓在
       `WASHI_THEME.common` 里把它抬到 1024）时，低信息量的列挂 `responsive: ['lg']`
       直接筛掉，窄屏只留 **留言内容 + 人工审核 + 操作**（全列宽合计 870px，390 屏上不裁就得横拖两屏多）。
       剩下那几列里写死 px 的还要**收窄**（下面 `isNarrow` 那几处三元）：这不是可选的 ——
       这些表是 `table-layout: fixed`（antd 见到 `ellipsis` 就会加），定宽列先把自己拿满、
       剩下的才轮到没写宽的正文列，实测 390 屏上**只裁列不收宽**正文列只剩 66px。
       断点用 antd 自己的 `useBreakpoint`：它读的正是 `WASHI_THEME.common.screenLG`
       那颗令牌 ⇒ 与 CSS 那条 `@media`、壳里那条 matchMedia 同一处事实源，不会漂开
       （它是 `useLayoutEffect`，首帧那个空的 `{}` 上不了屏 ⇒ 宽屏不会闪一下窄屏形态）。
       宽屏（≥1024）逐像素不变。 */
    const screens = Grid.useBreakpoint();
    const isNarrow = !screens.lg;
    const columns: ColumnsType<BoardItem> = [
        {
            title: '印章', dataIndex: 'cat', width: 70, responsive: ['lg'],
            render: (c: string) => <span className="bm-seal">{c}</span>,
        },
        {
            title: '留言内容', dataIndex: 'content', ellipsis: true,
            // 驳回理由跟在正文下面（20260923）：审批人翻列表时要一眼看到
            // "这条为什么被驳回"，而不是逐行去悬停猜
            render: (c: string, r) => (
                <>
                    <div className="bm-content">{c}</div>
                    {r.approved === 2 && (
                        <div className="bm-reason">
                            驳回理由：{r.rejectReason || <i className="bm-reason-none">未填写</i>}
                        </div>
                    )}
                </>
            ),
        },
        {
            title: '留名', dataIndex: 'author', width: 120, responsive: ['lg'],
            render: (a: string) => (a ? a : <span className="bm-anon">无名</span>),
        },
        {
            title: '发布用户', key: 'user', width: 220, responsive: ['lg'],
            render: (_, r) => (
                <span className="bm-user">
                    {r.nickname || r.username}
                    <i>@{r.username} · 用户 #{r.userId}</i>
                </span>
            ),
        },
        {
            title: '灯型', dataIndex: 'v', width: 90, responsive: ['lg'],
            render: (v: number) => LAMP_NAMES[v] ?? LAMP_NAMES[0],
        },
        { title: '时间', dataIndex: 'createTime', width: 160, responsive: ['lg'] },
        {
            /* 两段审核之第一段：AI 初审判定留痕（issue9 起落库展示） */
            title: 'AI 审核', key: 'ai', width: 110, responsive: ['lg'],
            render: (_, r) =>
                r.ai_result === 'flag' ? (
                    <Tooltip title={aiTip('AI 初审判定疑似，拦下转人工裁决', r)}>
                        <Tag color="gold">存疑</Tag>
                    </Tooltip>
                ) : r.ai_result === 'reject' ? (
                    <Tooltip title={aiTip(manualOn ? 'AI 判定拒绝，但人工复核已开启，仍需人工裁决' : 'AI 判定拒绝，已直接拒绝展示', r)}>
                        <Tag color="red">拒绝</Tag>
                    </Tooltip>
                ) : r.ai_result === 'pass' ? (
                    <Tooltip title={aiTip(manualOn ? 'AI 判定通过，但人工复核已开启，仍需人工裁决' : 'AI 判定通过，已直接放行展示', r)}>
                        <Tag color="green">通过</Tag>
                    </Tooltip>
                ) : (
                    <Tooltip title={aiTip(manualOn ? '人工全审模式：新留言不经 AI 初判' : 'AI 审核关闭 / 审核服务不可用转人工 / 存量历史行，未留 AI 判定', r)}>
                        <Tag>未审</Tag>
                    </Tooltip>
                ),
        },
        {
            /* 两段审核之第二段：人工裁决结果（0 待审 / 1 通过 / 2 未通过=驳回） */
            title: '人工审核', key: 'manual', width: isNarrow ? 80 : 110,
            render: (_, r) =>
                r.approved === 1 ? (
                    <Tooltip title="已放行，留言板公开展示">
                        <Tag color="green">通过</Tag>
                    </Tooltip>
                ) : r.approved === 0 ? (
                    <Tooltip title="待人工裁决：可「通过」放行或「驳回」隐藏">
                        <Tag color="gold">待审</Tag>
                    </Tooltip>
                ) : (
                    <Tooltip title="已驳回（未通过）：不公开展示，仅发布者在灯影集「我的河灯」可见；可恢复通过（恢复即清空驳回理由）">
                        <Tag color="red">未通过</Tag>
                    </Tooltip>
                ),
        },
        {
            title: '操作', key: 'op', width: isNarrow ? 130 : 190,
            render: (_, r) => {
                // 驳回按钮**一处实现、两态共用**（20260930）：待审(0) 与已通过(1) 都挂它。
                // 已通过的也能驳回 = 把已经放行的留言收回来（后端 handler 从来没有状态守卫，
                // 卡点只在这排按钮的渲染条件上）；理由弹窗、通知、本地写回三处都不用分叉——
                // `audit(id, 0, reason)` 对两态是同一条路径。
                const rejectBtn = (
                    <Button
                        danger
                        type="link"
                        size="small"
                        onClick={() => {
                            setRejecting(r);
                            setRejectReason('');
                        }}
                    >
                        驳回
                    </Button>
                );
                return (
                <>
                    {r.approved === 0 && (
                        <>
                            <Button type="link" size="small" onClick={() => audit(r.talkKey, 1)}>通过</Button>
                            {rejectBtn}
                        </>
                    )}
                    {r.approved === 1 && rejectBtn}
                    {r.approved === 2 && (
                        <Button type="link" size="small" onClick={() => audit(r.talkKey, 1)}>恢复通过</Button>
                    )}
                    <Popconfirm
                        title="删除这条留言？"
                        description="删除后留言板不再展示，且不可恢复"
                        onConfirm={() => del(r.talkKey)}
                        okText="删除"
                        cancelText="取消"
                    >
                        <Button danger size="small" type="text">删除</Button>
                    </Popconfirm>
                </>
                );
            },
        },
    ];

    return (
        <div className="BoardManage">
            <div className="bm-toolbar">
                <div className="bm-tabs" role="tablist">
                    <button type="button" className={catFilter === '' ? 'sel' : ''} onClick={() => setCatFilter('')}>全部</button>
                    {CATS.map((c) => (
                        <button key={c} type="button" className={catFilter === c ? 'sel' : ''} onClick={() => setCatFilter(c)}>{c}</button>
                    ))}
                </div>
                <Input.Search
                    placeholder="检索留言、留名、用户名或昵称…"
                    allowClear
                    onChange={(e) => setQuery(e.target.value)}
                    style={{ width: 300 }}
                />
                <Button onClick={() => setAsc((a) => !a)}>{asc ? '时序 ↑' : '时序 ↓'}</Button>
                <Button icon={<ReloadOutlined />} onClick={() => refresh()} loading={loading}>
                    刷新
                </Button>
                <span className="bm-count">共 {filtered.length} 条留言</span>
            </div>
            <div className="bm-review">
                <span className="bm-review-item">
                    <Switch size="small" checked={aiOn} onChange={(v) => toggleReview('aiReviewEnabled', v)} />
                    <span>AI 审核</span>
                </span>
                <span className="bm-review-item">
                    <Switch size="small" checked={manualOn} onChange={(v) => toggleReview('manualReviewEnabled', v)} />
                    <span>人工复核</span>
                </span>
                <span className="bm-review-hint">
                    {manualOn
                        ? '开启中：新留言一律先进待审，管理员「通过」后才在留言板展示'
                        : aiOn
                            ? '开启中：新留言先经一次 AI 审核，疑似内容拦下进待审'
                            : '均关闭：新留言直接展示（开关即存即生效）'}
                </span>
            </div>
            {/* 滚动从整页挪进这一块（20260926 用户报"向下滚动会丢掉筛选检索的头"）。
                以前 `.BoardManage` 自己 `overflow-y: auto`，于是工具栏、审核开关、说明
                都跟着表格一起滚走——翻到第 30 条时想换个关键词得先滚回顶上。现在：
                上面两行（筛选 + 审核开关）是固定的，**只有这张表在窗口内滚**，表头
                用 CSS sticky 吸在这一块的顶沿（见 index.sass）；分页条也移出滚动区、
                钉在底部（照文章列表那套：Table 的 pagination 关掉，改由外面的
                Pagination 承担，否则翻页按钮会跟着表体一起滚走）。 */}
            <div className="bm-scroll">
                <Table
                    rowKey="talkKey"
                    columns={columns}
                    dataSource={pageRows}
                    loading={loading}
                    size="middle"
                    pagination={false}
                />
                <p className="bm-note">
                    留言板与说说各自独立：本页仅管理留言板所放河灯。审核分两段展示——AI 审核（初审判定
                    留痕：拦截/通过/未审）+ 人工审核（裁决结果：通过/待审/未通过）。待审与未通过的留言不进
                    公开列表；可「通过」放行、「驳回」隐藏（驳回后可「恢复通过」改判）或删除。存量留言
                    不受开关影响。审核出结果时会自动给发布者发一条站内通知（通过/驳回各一条，驳回会带上
                    理由），改判会再发一条。
                </p>
            </div>
            <div className="bm-foot">
                <Pagination
                    size="small"
                    current={page}
                    pageSize={PAGE_SIZE}
                    total={filtered.length}
                    showSizeChanger={false}
                    onChange={setPage}
                    showTotal={(t) => `共 ${t} 条留言`}
                />
            </div>
            {/* 驳回理由弹窗：理由随审核结果通知发给发布者，**必填**（20260926） */}
            <Modal
                title="驳回这条留言？"
                open={!!rejecting}
                onOk={confirmReject}
                onCancel={() => {
                    setRejecting(null);
                    setRejectReason('');
                }}
                okText="确认驳回"
                cancelText="取消"
                okButtonProps={{
                    danger: true,
                    loading: rejectBusy,
                    className: 'bm-reject-ok',
                    // 理由必填（20260926）：空理由时按钮不可点——留空的结果是发布者收到
                    // 一句"不符合留言板的留言规范"，既不知道问题在哪、也不知道去哪儿看。
                    // 后端不加硬闸（那是脚本/老前端的兼容面），必填在这**入口**这一层保证。
                    disabled: !rejectReason.trim(),
                }}
                rootClassName="bm-reject-modal"
            >
                <p className="bm-reject-tip">
                    驳回后不在留言板展示（仅发布者本人在灯影集可见），同时会给发布者发一条站内通知，
                    理由会一并带上。<b>理由必填</b>——写清是哪一类问题，他才知道该怎么改。
                </p>
                {rejecting?.rejectReason && (
                    <p className="bm-reject-existing">
                        这条留言已有理由：{rejecting.rejectReason}
                        <Button
                            type="link" size="small" className="bm-reject-reuse"
                            onClick={() => setRejectReason(rejecting.rejectReason || '')}
                        >沿用</Button>
                    </p>
                )}
                <div className="bm-reject-presets">
                    {BOARD_REJECT_PRESETS.map((p) => (
                        <Button
                            key={p} size="small" className="bm-reject-preset"
                            onClick={() => setRejectReason(p)}
                        >{p}</Button>
                    ))}
                    {rejecting?.aiReason && (
                        <Button
                            size="small" type="primary" ghost className="bm-reject-use-ai"
                            onClick={() => setRejectReason(rejecting.aiReason || '')}
                        >采用 AI 说明</Button>
                    )}
                </div>
                {/* `counter-room`：给 showCount 的计数腾 22px（它不占布局空间，
                    Modal footer 只留了 12px）。见 src/index.css 那条规则。 */}
                <Input.TextArea
                    className="counter-room"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    maxLength={REJECT_REASON_MAX}
                    showCount
                    autoSize={{ minRows: 3, maxRows: 5 }}
                    placeholder="例如：与文章主题无关的广告（也可以点上面的常见类型，再改成更贴这条的说法）"
                />
            </Modal>
        </div>
    );
};

export default BoardManage;

import './index.sass'
import { useEffect, useRef, useState } from "react";
import { Button, Grid, Input, Modal, Pagination, Popconfirm, Switch, Table, Tag, Tooltip, message } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from 'antd/es/table';
import http from "../../../apis/axios.tsx";
import { useLiveRefresh } from "../../../utils/liveRefresh.ts";
import { BOARD_REJECT_PRESETS, REJECT_REASON_MAX, aiTip } from "../ContentManage/shared";

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
    rejectReason?: string | null;
    aiReason?: string | null;
}


const CATS = ['愿', '寄', '忆', '诉'];
const LAMP_NAMES = ['莲花灯', '八角灯', '圆笼灯'];
const PAGE_SIZE = 10;

const QUERY_DEBOUNCE_MS = 400;

const BoardManage = () => {
    const [items, setItems] = useState<BoardItem[]>([]);
    /** 满足筛选条件的**总条数**（服务端信封里的 `total`，不是本页条数）——
     *  外面那条 Pagination 与工具栏的「共 N 条留言」都用它。 */
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [catFilter, setCatFilter] = useState(''); // 类型筛选（空 = 全部）
    const [query, setQuery] = useState(''); // 检索框里**显示**的那个词（每次击键都变）
    const [applied, setApplied] = useState(''); // 真正发给服务端的那个关键词（防抖之后）
    const [asc, setAsc] = useState(false); // 时序正序/倒序
    const [page, setPage] = useState(1);
    // 审核开关（web_info key-value，缺省关）
    const [aiOn, setAiOn] = useState(false);
    const [manualOn, setManualOn] = useState(false);
    const [rejecting, setRejecting] = useState<BoardItem | null>(null);
    const [rejectReason, setRejectReason] = useState('');
    const [rejectBusy, setRejectBusy] = useState(false);

    /** 列表取数序号：条件/页码挨得近时会有多个请求在途，**只认最后发出去的那一次**。
     *  少了这道闸，乱序回包会把上一次筛选的结果盖回来——用户看到的是"筛完又自己变回去了"。
     *  与 `frontHome/Head` 的 `searchSeq` 是同一条纪律（那边的现场注释更详细）。 */
    const listSeq = useRef(0);

    const load = async (opts?: { silent?: boolean }) => {
        const seq = ++listSeq.current;
        if (!opts?.silent) setLoading(true);
        try {
            const res = await http.get('/api/protect/board', {
                params: {
                    page,
                    page_size: PAGE_SIZE,
                    order: asc ? 'asc' : 'desc',
                    // 空筛选**整条不发**：服务端把"少了这个参数"与"空串"归成同一件事，
                    // 少发一个也让请求 URL 与手测时敲的那条命令逐字对得上
                    ...(catFilter ? { cat: catFilter } : {}),
                    ...(applied.trim() ? { q: applied.trim() } : {}),
                },
            });
            if (seq !== listSeq.current) return;
            const rows = Array.isArray(res?.data?.data) ? res.data.data : [];
            setItems(rows);
            // 总数只认信封里那个，**别拿本页条数当总数**（那只是"结果正好一页"时的巧合）。
            // 服务端没给（旧后端 / 半截部署）时退回本页条数：宁可只显示一页，也不凭空编一个
            // 总数（缺键绝不编 0 —— 编出来的数会同时写进文案与分页器，看着很像真的）。
            const t = res?.data?.total;
            setTotal(typeof t === 'number' ? t : rows.length);
        } catch {
            if (!opts?.silent && seq === listSeq.current) message.error('获取留言失败');
        } finally {
            if (!opts?.silent && seq === listSeq.current) setLoading(false);
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
     *  工具栏「刷新」、事件与轮询走这一条，少一条路径就少一处会漂的判据。
     *  （**挂载**不走它：挂载那一次由下面「条件变了就拉一页」那条 effect 承担，走它会把
     *  列表请求发两遍。） */
    const refresh = async (opts?: { silent?: boolean }) => {
        await Promise.all([load(opts), loadSwitches()]);
    };

    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    /** 撤掉挂着的那一次防抖查询（清空输入 / 卸载两处都要它）。 */
    const cancelScheduledSearch = () => {
        if (searchTimer.current !== null) {
            clearTimeout(searchTimer.current);
            searchTimer.current = null;
        }
    };

    /** 把这次关键词排在 `QUERY_DEBOUNCE_MS` 之后生效；期间再敲一个字就被顶掉，只发最后一次。
     *  生效时**回第一页**：新条件的结果可能只有一页，停在「第 3 页」时表格是空的，
     *  看着像"筛出来什么都没有"。 */
    const scheduleSearch = (kw: string) => {
        cancelScheduledSearch();
        searchTimer.current = setTimeout(() => {
            searchTimer.current = null;
            // 关键词真的变了才回第一页：同一个词敲了又删回去，不该把翻到第 3 页的人拽回来
            if (kw !== applied) setPage(1);
            setApplied(kw);
        }, QUERY_DEBOUNCE_MS);
    };

    // 卸载时把挂着的那一次清掉（清理体**内联**在这里、不调 `cancelScheduledSearch`：那样
    // 会让 exhaustive-deps 要求把它列进依赖，而依赖一变这个 effect 就重跑、每次都把挂着的
    // 定时器清掉——防抖直接失效。同 `frontHome/Head`）。
    useEffect(() => () => {
        if (searchTimer.current !== null) {
            clearTimeout(searchTimer.current);
            searchTimer.current = null;
        }
    }, []);

    /* 列表：挂载 + 四个条件里任何一个变了就拉一页（这就是"服务端筛选"的全部接线）。
     * ⚠️ `load` 每轮渲染都是新闭包（读的正是列在这条依赖里的那几个原始值），把它本身列进
     * 依赖等于每次渲染都重拉一遍 —— 所以依赖只列原始值。**回第一页**不在这里做，在各条件
     * 的改动处做（那里才知道该不该回：翻页时当然不回）。 */
    useEffect(() => {
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page, catFilter, applied, asc]);

    useEffect(() => {
        void loadSwitches();
    }, []);

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

    const audit = async (id: number, approved: number, reason?: string) => {
        try {
            const res = await http.put(`/api/protect/board/${id}/audit`, { approved, reason });
            if (res.data?.code === 200) {
                message.success(approved === 1 ? '已通过，留言板展示' : '已驳回（未通过），不展示');
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

    /* 查询筛选（类型 + 关键词 + 时序）与分页**都在服务端做** —— 三个条件连同 `page` 一起
     * 发给 `/api/protect/board`，`items` 里装的就是"当前这一页"，这里不再 filter/sort/slice。
     * 判据只有服务端那一处（`talks.rs::board_admin_filter`）：前端搜到的 = 全库里符合条件
     * 的，而不是"已经加载进来的那份里符合条件的"。 */

    /* 删除留言：管理员确认后删除，留言板不再展示 */
    const del = async (id: number) => {
        try {
            const res = await http.delete(`/api/protect/board/${id}`);
            if (res.data?.code === 200) {
                message.success('已删除');
                setItems((prev) => prev.filter((it) => it.talkKey !== id)); // 同上：本地剔除，不重拉
                // 总数跟着减一：这一行本来就来自**当前这一页**（本页 = 筛选后的那一段），
                // 删掉它总条数必然少一条。不减的话「共 N 条」与外面那条 Pagination 会停在
                // 旧数上，直到下一次重拉才追上。
                setTotal((t) => Math.max(0, t - 1));
            } else {
                message.error(res.data?.message || '删除失败');
            }
        } catch {
            message.error('删除失败');
        }
    };

    const screens = Grid.useBreakpoint();
    const isNarrow = !screens.lg;
    const columns: ColumnsType<BoardItem> = [
        {
            title: '印章', dataIndex: 'cat', width: 70, responsive: ['lg'],
            render: (c: string) => <span className="bm-seal">{c}</span>,
        },
        {
            title: '留言内容', dataIndex: 'content', ellipsis: true,
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
                    <button type="button" className={catFilter === '' ? 'sel' : ''} onClick={() => { setCatFilter(''); setPage(1); }}>全部</button>
                    {CATS.map((c) => (
                        <button key={c} type="button" className={catFilter === c ? 'sel' : ''} onClick={() => { setCatFilter(c); setPage(1); }}>{c}</button>
                    ))}
                </div>
                <Input.Search
                    placeholder="检索留言、留名、用户名或昵称…"
                    allowClear
                    value={query}
                    onChange={(e) => {
                        const v = e.target.value;
                        setQuery(v);
                        if (v === '') {
                            cancelScheduledSearch();
                            if (applied !== '') setPage(1);
                            setApplied('');
                            return;
                        }
                        scheduleSearch(v);
                    }}
                    // 回车 / 点那颗搜索按钮 = **立刻查**（顶掉挂着的防抖那一次，不查两遍）
                    onSearch={(v) => {
                        cancelScheduledSearch();
                        if (v !== applied) setPage(1);
                        setApplied(v);
                    }}
                    style={{ width: 300 }}
                />
                <Button onClick={() => { setAsc((a) => !a); setPage(1); }}>{asc ? '时序 ↑' : '时序 ↓'}</Button>
                <Button icon={<ReloadOutlined />} onClick={() => refresh()} loading={loading}>
                    刷新
                </Button>
                <span className="bm-count">共 {total} 条留言</span>
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
            <div className="bm-scroll">
                <Table
                    rowKey="talkKey"
                    columns={columns}
                    dataSource={items}
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
                    total={total}
                    showSizeChanger={false}
                    onChange={setPage}
                    showTotal={(t) => `共 ${t} 条留言`}
                />
            </div>
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

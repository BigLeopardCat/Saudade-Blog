import './index.sass'
import { useEffect, useMemo, useState } from "react";
import { Button, Input, Modal, Pagination, Popconfirm, Switch, Table, Tag, Tooltip, message } from "antd";
import type { ColumnsType } from 'antd/es/table';
import http from "../../../apis/axios.tsx";

/** 评论管理：河灯留言的查询/筛选/删除 + 两段审核（20260905 issue9 双状态显示）
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
 *  驳回理由（20260923）：驳回弹窗里可手填（≤200 字，可留空），落 talk.reject_reason；
 *  留空且 AI 判过 reject 时后端回落到 AI 给的 reason。终态（通过/驳回/改判）都会给
 *  发布者发一条站内通知，驳回通知里带上理由。理由只随驳回存在——恢复通过即清空。
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
}

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

    const load = async () => {
        setLoading(true);
        try {
            const res = await http.get('/api/protect/board');
            setItems(Array.isArray(res?.data?.data) ? res.data.data : []);
        } catch {
            message.error('获取留言失败');
        } finally {
            setLoading(false);
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

    useEffect(() => {
        load();
        loadSwitches();
    }, []);

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

    /** 人工复核：通过(1)=放行展示 / 驳回(0)=写未通过(2)隐藏，驳回可「恢复通过」改判
     *  （仅河灯留言，后端有 src 守卫；人工裁决不改写 ai_result，AI 判定留痕保留）
     *  reason 只在驳回时有意义（通过时后端会清空理由，传了也不生效） */
    const audit = async (id: number, approved: number, reason?: string) => {
        try {
            const res = await http.put(`/api/protect/board/${id}/audit`, { approved, reason });
            if (res.data?.code === 200) {
                message.success(approved === 1 ? '已通过，留言板展示' : '已驳回（未通过），不展示');
                // 只改本地那一行（接口已确认成功）：原来每次都 load() 重拉全量列表，
                // 连审 10 条就是 11 次全量请求、每次带全部content
                // 驳回后的理由以后端为准：本次没填而后端回落到已有理由时，本地不能显示成空
                setItems((prev) => prev.map((it) => (it.talkKey === id
                    ? {
                        ...it,
                        approved,
                        rejectReason: approved === 2
                            ? (reason?.trim() || it.rejectReason || null)
                            : null, // 通过（含改判）后端会清空理由
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

    const columns: ColumnsType<BoardItem> = [
        {
            title: '印章', dataIndex: 'cat', width: 70,
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
            title: '留名', dataIndex: 'author', width: 120,
            render: (a: string) => (a ? a : <span className="bm-anon">无名</span>),
        },
        {
            title: '发布用户', key: 'user', width: 220,
            render: (_, r) => (
                <span className="bm-user">
                    {r.nickname || r.username}
                    <i>@{r.username} · 用户 #{r.userId}</i>
                </span>
            ),
        },
        {
            title: '灯型', dataIndex: 'v', width: 90,
            render: (v: number) => LAMP_NAMES[v] ?? LAMP_NAMES[0],
        },
        { title: '时间', dataIndex: 'createTime', width: 160 },
        {
            /* 两段审核之第一段：AI 初审判定留痕（issue9 起落库展示） */
            title: 'AI 审核', key: 'ai', width: 110,
            render: (_, r) =>
                r.ai_result === 'flag' ? (
                    <Tooltip title="AI 初审判定疑似，拦下转人工裁决">
                        <Tag color="gold">存疑</Tag>
                    </Tooltip>
                ) : r.ai_result === 'reject' ? (
                    <Tooltip title={manualOn ? 'AI 判定拒绝，但人工复核已开启，仍需人工裁决' : 'AI 判定拒绝，已直接拒绝展示'}>
                        <Tag color="red">拒绝</Tag>
                    </Tooltip>
                ) : r.ai_result === 'pass' ? (
                    <Tooltip title={manualOn ? 'AI 判定通过，但人工复核已开启，仍需人工裁决' : 'AI 判定通过，已直接放行展示'}>
                        <Tag color="green">通过</Tag>
                    </Tooltip>
                ) : (
                    <Tooltip title={manualOn ? '人工全审模式：新留言不经 AI 初判' : 'AI 审核关闭 / 审核服务不可用转人工 / 存量历史行，未留 AI 判定'}>
                        <Tag>未审</Tag>
                    </Tooltip>
                ),
        },
        {
            /* 两段审核之第二段：人工裁决结果（0 待审 / 1 通过 / 2 未通过=驳回） */
            title: '人工审核', key: 'manual', width: 110,
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
            title: '操作', key: 'op', width: 190,
            render: (_, r) => (
                <>
                    {r.approved === 0 && (
                        <>
                            <Button type="link" size="small" onClick={() => audit(r.talkKey, 1)}>通过</Button>
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
                        </>
                    )}
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
            ),
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
            {/* 驳回理由弹窗：理由随审核结果通知发给发布者，可留空 */}
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
                okButtonProps={{ danger: true, loading: rejectBusy }}
                rootClassName="bm-reject-modal"
            >
                <p className="bm-reject-tip">
                    驳回后不在留言板展示（仅发布者本人在灯影集可见），同时会给发布者发一条站内通知，
                    理由会一并带上。理由可留空。
                </p>
                <Input.TextArea
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    maxLength={200}
                    showCount
                    autoSize={{ minRows: 3, maxRows: 5 }}
                    placeholder={
                        rejecting?.rejectReason
                            ? `可留空；留空沿用已有理由：${rejecting.rejectReason}`
                            : '可留空，例如：与文章主题无关的广告'
                    }
                />
            </Modal>
        </div>
    );
};

export default BoardManage;

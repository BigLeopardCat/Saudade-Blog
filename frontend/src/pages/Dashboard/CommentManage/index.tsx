import './index.sass'
import { useEffect, useState } from "react";
import { Alert, Button, Grid, Input, Modal, Pagination, Popconfirm, Switch, Table, Tag, Tooltip, message } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from 'antd/es/table';
import http from "../../../apis/axios.tsx";
import { useLiveRefresh } from "../../../utils/liveRefresh.ts";
import { COMMENT_REJECT_PRESETS, REJECT_REASON_MAX, aiTip } from "../ContentManage/shared";

import {skipToken} from '@reduxjs/toolkit/query'
import {useAuthToken} from '../../../utils/useAuthToken'
import {getUidFromToken} from '../../../utils/auth'
import {COMMENT_PAGE_SIZE as PAGE_SIZE, useAdminCommentsQuery, useAuditCommentMutation,
    useDeleteCommentMutation, type CommentAdminItem, type CommentFilter} from '../../../apis/commentAdminApi'

const STATUS_FILTERS: {key: CommentFilter; label: string}[] = [
    {key: 'all', label: '全部'},
    {key: 'pending', label: '待审'},
    {key: 'passed', label: '已通过'},
    {key: 'rejected', label: '未通过'},
    {key: 'deleted', label: '已删除'},
];

const AI_KEY = 'commentAiReviewEnabled';
const MANUAL_KEY = 'commentManualReviewEnabled';

const RISK_FIELDS: { key: string; label: string; def: number; unit: string }[] = [
    { key: 'contentRateWindowSecs', label: '统计窗口', def: 600, unit: '秒' },
    { key: 'contentMinIntervalSecs', label: '最小间隔', def: 5, unit: '秒' },
    { key: 'contentRateLimit', label: '转人工阈值', def: 10, unit: '条' },
    { key: 'contentMuteLimit', label: '自动禁言阈值', def: 20, unit: '条' },
    { key: 'contentMuteHours', label: '禁言时长', def: 24, unit: '小时' },
];

const DeleteButton = ({ onConfirm, disabled }: { onConfirm: () => void; disabled: boolean }) => (
    <Popconfirm
        disabled={disabled}
        title="删除这条评论？"
        description="删除后公开侧不再显示（它下面的回复也一起消失），且不可恢复"
        onConfirm={onConfirm}
        okText="删除"
        cancelText="取消"
    >
        <Button danger size="small" type="text" disabled={disabled}>删除</Button>
    </Popconfirm>
);

const CommentManage = () => {
    const token = useAuthToken();
    const ownerUserId = getUidFromToken(token);
    const [filters, setFilters] = useState<{status: CommentFilter; query: string; sort: 'asc' | 'desc'; page: number}>(
        {status: 'all', query: '', sort: 'desc', page: 1});
    const {status: statusFilter, query, sort, page} = filters;
    const {currentData, isFetching: loading, isError, error, refetch} = useAdminCommentsQuery(
        ownerUserId ? {ownerUserId, ...filters} : skipToken);
    const [auditComment, {isLoading: auditing}] = useAuditCommentMutation();
    const [deleteComment, {isLoading: deleting}] = useDeleteCommentMutation();
    const pageRows = currentData?.items ?? [];
    const total = currentData?.total;
    const updateFilters = (next: Partial<typeof filters>) => setFilters(prev => ({...prev, ...next, page: 1}));
    useEffect(() => {
        if (total === undefined) return;
        const last = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (page > last) setFilters(prev => prev.page === page ? {...prev, page: last} : prev);
    }, [total, page]);
    const [aiOn, setAiOn] = useState(false);
    const [manualOn, setManualOn] = useState(false);
    const [riskOpen, setRiskOpen] = useState(false);
    const [riskForm, setRiskForm] = useState<Record<string, string>>({});
    const [riskBusy, setRiskBusy] = useState(false);
    const [rejecting, setRejecting] = useState<CommentAdminItem | null>(null);
    const [rejectReason, setRejectReason] = useState('');
    const [rejectBusy, setRejectBusy] = useState(false);

    const loadSwitches = async () => {
        try {
            const res = await http.get('/api/protected/websetting');
            const d = res?.data?.data;
            if (d) {
                setAiOn(!!d[AI_KEY]);
                setManualOn(!!d[MANUAL_KEY]);
                setRiskForm(Object.fromEntries(
                    RISK_FIELDS.map((f) => [f.key, d[f.key] == null ? '' : String(d[f.key])]),
                ));
            }
        } catch { /* Preserve the last loaded settings on refresh failure. */ }
    };

    const refresh = async () => {
        await Promise.all([ownerUserId ? refetch() : Promise.resolve(), loadSwitches()]);
    };
    useEffect(() => { void loadSwitches(); }, []);
    useLiveRefresh(refresh, {skip: () => !!rejecting || !ownerUserId});

    const toggleReview = async (key: typeof AI_KEY | typeof MANUAL_KEY, on: boolean) => {
        const setter = key === AI_KEY ? setAiOn : setManualOn;
        const prev = key === AI_KEY ? aiOn : manualOn;
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

    const saveRisk = async () => {
        const payload: Record<string, number> = {};
        for (const f of RISK_FIELDS) {
            const raw = (riskForm[f.key] ?? '').trim();
            if (raw === '') continue;
            if (!/^-?\d+$/.test(raw)) {
                message.error(`「${f.label}」要填整数（留空表示沿用默认）`);
                return;
            }
            payload[f.key] = Number(raw);
        }
        if (Object.keys(payload).length === 0) {
            message.info('没有要保存的项：留空表示沿用默认值');
            return;
        }
        setRiskBusy(true);
        try {
            const res = await http.post('/api/protected/websetting', payload);
            if (res.data?.code === 200) {
                message.success('风控阈值已保存，下一条评论 / 留言起生效');
                await loadSwitches();
            } else {
                message.error(res.data?.message || '保存失败');
            }
        } catch {
            message.error('保存失败');
        } finally {
            setRiskBusy(false);
        }
    };

    const audit = async (id: number, approved: number, reason?: string) => {
        if (!ownerUserId) return false;
        try {
            await auditComment({ownerUserId, id, approved, reason}).unwrap();
            message.success(approved === 1 ? '已通过，讨论区展示' : '已驳回（未通过），不展示');
            return true;
        } catch {
            message.error('操作失败，请重试');
            return false;
        }
    };

    const confirmReject = async () => {
        if (!rejecting) return;
        setRejectBusy(true);
        const ok = await audit(rejecting.id, 0, rejectReason);
        setRejectBusy(false);
        if (ok) {
            setRejecting(null);
            setRejectReason('');
        }
    };

    const del = async (id: number) => {
        if (!ownerUserId) return;
        try {
            await deleteComment({ownerUserId, id}).unwrap();
            message.success('已删除（公开侧不再显示）');
        } catch { message.error('删除失败，请重试'); }
    };

    const screens = Grid.useBreakpoint();
    const isNarrow = !screens.lg;
    const columns: ColumnsType<CommentAdminItem> = [
        {
            title: '文章', dataIndex: 'noteTitle', width: 170, ellipsis: true, responsive: ['lg'],
            render: (t: string, r) => (t
                ? <a href={`/article/${r.noteId}`} target="_blank" rel="noreferrer">{t}</a>
                : <span className="cm-dim">（文章已删除）</span>),
        },
        {
            title: '评论内容', dataIndex: 'content', ellipsis: true,
            render: (c: string, r) => (
                <>
                    <div className="cm-content">{c}</div>
                    {r.isDeleted !== 0 && <div className="cm-deleted">已删除（公开侧不再显示）</div>}
                    {r.isDeleted === 0 && r.approved === 2 && (
                        <div className="cm-reason">
                            驳回理由：{r.rejectReason || <i className="cm-reason-none">未填写</i>}
                        </div>
                    )}
                </>
            ),
        },
        {
            title: '评论者', key: 'user', width: 190, responsive: ['lg'],
            render: (_, r) => (
                <span className="cm-user">
                    {r.nickname || r.username}
                    <i>@{r.username} · 用户 #{r.userId}</i>
                </span>
            ),
        },
        {
            title: '回复对象', dataIndex: 'replyToNickname', width: 120, responsive: ['lg'],
            render: (n: string | null | undefined) => (n
                ? <span className="cm-replyto">回复 @{n}</span>
                : <span className="cm-dim">—</span>),
        },
        { title: '时间', dataIndex: 'createTime', width: 160, responsive: ['lg'] },
        {

            title: 'AI 审核', key: 'ai', width: 110, responsive: ['lg'],
            render: (_, r) =>
                r.aiResult === 'flag' ? (
                    <Tooltip title={aiTip('AI 初审判定疑似，拦下转人工裁决', r)}>
                        <Tag color="gold">存疑</Tag>
                    </Tooltip>
                ) : r.aiResult === 'reject' ? (
                    <Tooltip title={aiTip(manualOn ? 'AI 判定拒绝，但人工复核已开启，仍需人工裁决' : 'AI 判定拒绝，已直接拒绝展示', r)}>
                        <Tag color="red">拒绝</Tag>
                    </Tooltip>
                ) : r.aiResult === 'pass' ? (
                    <Tooltip title={aiTip(manualOn ? 'AI 判定通过，但人工复核已开启，仍需人工裁决' : 'AI 判定通过，已直接放行展示', r)}>
                        <Tag color="green">通过</Tag>
                    </Tooltip>
                ) : (
                    <Tooltip title={aiTip(manualOn ? '人工全审模式：新评论不经 AI 初判' : 'AI 审核关闭 / 审核服务不可用转人工 / 存量历史行，未留 AI 判定', r)}>
                        <Tag>未审</Tag>
                    </Tooltip>
                ),
        },
        {

            title: '人工审核', key: 'manual', width: isNarrow ? 80 : 110,
            render: (_, r) =>
                r.approved === 1 ? (
                    <Tooltip title="已放行，讨论区公开展示">
                        <Tag color="green">通过</Tag>
                    </Tooltip>
                ) : r.approved === 0 ? (
                    <Tooltip title="待人工裁决：可「通过」放行或「驳回」隐藏">
                        <Tag color="gold">待审</Tag>
                    </Tooltip>
                ) : (
                    <Tooltip title="已驳回（未通过）：不公开展示；可恢复通过（恢复即清空驳回理由）">
                        <Tag color="red">未通过</Tag>
                    </Tooltip>
                ),
        },
        {
            title: '操作', key: 'op', width: isNarrow ? 120 : 180,
            render: (_, r) => {
                if (r.isDeleted !== 0) {
                    return (
                        <Tooltip title="已删除的评论不再公开显示，也无法再审核（保留这一行供溯源）">
                            <span className="cm-dim">已删除</span>
                        </Tooltip>
                    );
                }
                const rejectBtn = (
                    <Button
                        danger
                        disabled={auditing || deleting}
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
                            <Button type="link" size="small" disabled={auditing || deleting} onClick={() => audit(r.id, 1)}>通过</Button>
                            {rejectBtn}
                        </>
                    )}
                    {r.approved === 1 && rejectBtn}
                    {r.approved === 2 && (
                        <Button type="link" size="small" disabled={auditing || deleting} onClick={() => audit(r.id, 1)}>恢复通过</Button>
                    )}
                    <DeleteButton disabled={auditing || deleting} onConfirm={() => del(r.id)} />
                </>
                );
            },
        },
    ];

    return (
        <div className="CommentManage">
            <div className="cm-toolbar">
                <div className="cm-tabs" role="tablist">
                    {STATUS_FILTERS.map((s) => (
                        <button
                            key={s.key}
                            role="tab"
                            aria-selected={statusFilter === s.key}
                            type="button"
                            className={statusFilter === s.key ? 'sel' : ''}
                            onClick={() => updateFilters({status: s.key})}
                        >{s.label}</button>
                    ))}
                </div>
                <Input.Search
                    placeholder="检索评论、昵称、用户名或文章标题…"
                    allowClear
                    defaultValue={query}
                    onSearch={value => updateFilters({query: value.trim()})}
                    maxLength={120}
                    style={{ width: 300 }}
                />
                <Button onClick={() => updateFilters({sort: sort === 'asc' ? 'desc' : 'asc'})}>{sort === 'asc' ? '时序 ↑' : '时序 ↓'}</Button>
                <Button icon={<ReloadOutlined />} onClick={() => refresh()} loading={loading}>
                    刷新
                </Button>
                <Button className="cm-risk-toggle" onClick={() => setRiskOpen((v) => !v)}>
                    风控设置{riskOpen ? ' ▲' : ' ▼'}
                </Button>
                <span className="cm-count">{total === undefined ? '评论总数待加载' : `共 ${total} 条评论`}</span>
            </div>
            <div className="cm-review">
                <span className="cm-review-item">
                    <Switch size="small" checked={aiOn} onChange={(v) => toggleReview(AI_KEY, v)} />
                    <span>AI 审核</span>
                </span>
                <span className="cm-review-item">
                    <Switch size="small" checked={manualOn} onChange={(v) => toggleReview(MANUAL_KEY, v)} />
                    <span>人工复核</span>
                </span>
                <span className="cm-review-hint">
                    {manualOn
                        ? '开启中：新评论一律先进待审，管理员「通过」后才在讨论区显示'
                        : aiOn
                            ? '开启中：新评论先经一次 AI 审核，疑似内容拦下进待审'
                            : '均关闭：新评论直接显示（开关即存即生效）'}
                </span>
                <span className="cm-review-scope">
                    这对开关只管评论，与「留言管理」那对互不影响
                </span>
            </div>
            {riskOpen && (
                <div className="cm-risk">
                    <span className="cm-risk-title">内容风控（评论与留言一起计数）</span>
                    {RISK_FIELDS.map((f) => (
                        <label key={f.key} className="cm-risk-item">
                            <span>{f.label}</span>
                            <Input
                                size="small"
                                className="cm-risk-input"
                                value={riskForm[f.key] ?? ''}
                                placeholder={String(f.def)}
                                onChange={(e) => setRiskForm((p) => ({ ...p, [f.key]: e.target.value }))}
                            />
                            <i>{f.unit}</i>
                        </label>
                    ))}
                    <Button size="small" type="primary" loading={riskBusy} onClick={saveRisk}>
                        保存
                    </Button>
                    <span className="cm-risk-hint">
                        留空 = 沿用默认（灰字里的数）；填 0 = 显式关掉那一档。
                        窗口内发布合计达到「转人工阈值」⇒ 本条转待审并通知本人；
                        达到「自动禁言阈值」⇒ 写入禁言、通知本人，本条照常保留待审；
                        间隔不足则直接拒发。被禁言的人仍能登录、浏览、对话。
                    </span>
                </div>
            )}
            {isError && <Alert type="error" showIcon
                message={'message' in (error ?? {}) ? String((error as {message: string}).message) : '评论加载失败'}
                description={currentData ? '当前显示上次成功加载的结果。' : '无法读取当前页，请重试。'}
                action={<Button size="small" onClick={() => refetch()}>重试</Button>} />}
            <div className="cm-scroll">
                <Table
                    rowKey="id"
                    columns={columns}
                    dataSource={pageRows}
                    loading={loading}
                    locale={{emptyText: isError ? '当前页加载失败' : loading ? '正在加载评论…' : '暂无评论'}}
                    size="middle"
                    pagination={false}
                />
                <p className="cm-note">
                    本页只管文章详情页底部的讨论区；河灯留言在「留言管理」页，两张表各自独立。
                    审核分两段展示——AI 审核（初审判定留痕：拦截/通过/未审）+ 人工审核（裁决结果：
                    通过/待审/未通过）。待审与未通过的评论不进公开列表；可「通过」放行、「驳回」
                    隐藏（驳回后可「恢复通过」改判）或删除。评论被删除后不再公开显示（它下面的回复
                    也一起消失），这里保留一行供溯源、不可再审。被回复者会收到一条站内通知，
                    点进去直接定位到这条回复；驳回时理由会一并带上。风控阈值在工具栏的
                    「风控设置」里（短时间内大量发评论 / 留言会被限流或自动临时禁言）。
                </p>
            </div>
            <div className="cm-foot">
                <Pagination
                    size="small"
                    current={page}
                    pageSize={PAGE_SIZE}
                    total={total ?? 0}
                    showSizeChanger={false}
                    onChange={next => setFilters(prev => ({...prev, page: next}))}
                    showTotal={(t) => `共 ${t} 条评论`}
                />
            </div>
            <Modal
                title="驳回这条评论？"
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
                    className: 'cm-reject-ok',
                    disabled: !rejectReason.trim(),
                }}
                rootClassName="cm-reject-modal"
            >
                <p className="cm-reject-tip">
                    驳回后不在讨论区展示，同时会给被回复者发一条站内通知，理由会一并带上。
                    <b>理由必填</b>——写清是哪一类问题，他才知道该怎么改。
                </p>
                {rejecting?.rejectReason && (
                    <p className="cm-reject-existing">
                        这条评论已有理由：{rejecting.rejectReason}
                        <Button
                            type="link" size="small" className="cm-reject-reuse"
                            onClick={() => setRejectReason(rejecting.rejectReason || '')}
                        >沿用</Button>
                    </p>
                )}
                <div className="cm-reject-presets">
                    {COMMENT_REJECT_PRESETS.map((p) => (
                        <Button
                            key={p} size="small" className="cm-reject-preset"
                            onClick={() => setRejectReason(p)}
                        >{p}</Button>
                    ))}
                    {rejecting?.aiReason && (
                        <Button
                            size="small" type="primary" ghost className="cm-reject-use-ai"
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

export default CommentManage;

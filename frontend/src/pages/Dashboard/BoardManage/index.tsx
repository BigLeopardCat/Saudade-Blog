import './index.sass'
import { useEffect, useMemo, useState } from "react";
import { Button, Input, Popconfirm, Switch, Table, Tag, Tooltip, message } from "antd";
import type { ColumnsType } from 'antd/es/table';
import http from "../../../apis/axios.tsx";

/** 评论管理：河灯留言的查询/筛选/删除 + 审核（AI 审核/人工复核，20260905 启用）
 *  数据来自 /api/protect/board（仅 src=board 的留言，与说说完全独立）。
 *  审核开关存 web_info（aiReviewEnabled/manualReviewEnabled），读写 /api/protected/websetting：
 *    · AI 审核开  → 每条新留言先经一次 AI 初审，疑似内容拦下（approved=0）进待审
 *    · 人工复核开 → 新留言一律先进待审，管理员「通过」才放行展示
 *    · 两闸可叠加、可单独作用；待审留言在本页审核列/操作列人工裁决
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
}

const CATS = ['愿', '寄', '忆', '诉'];
const LAMP_NAMES = ['莲花灯', '八角灯', '圆笼灯'];

const BoardManage = () => {
    const [items, setItems] = useState<BoardItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [catFilter, setCatFilter] = useState(''); // 类型筛选（空 = 全部）
    const [query, setQuery] = useState(''); // 关键词：留言/留名/用户名/昵称
    const [asc, setAsc] = useState(false); // 时序正序/倒序
    // 审核开关（web_info key-value，缺省关）
    const [aiOn, setAiOn] = useState(false);
    const [manualOn, setManualOn] = useState(false);

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

    /** 人工复核：通过(1)=放行展示 / 驳回(0)=隐藏（仅河灯留言，后端有 src 守卫） */
    const audit = async (id: number, approved: number) => {
        try {
            const res = await http.put(`/api/protect/board/${id}/audit`, { approved });
            if (res.data?.code === 200) {
                message.success(approved === 1 ? '已通过，留言板展示' : '已驳回隐藏');
                load();
            } else {
                message.error(res.data?.message || '操作失败');
            }
        } catch {
            message.error('操作失败');
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

    /* 删除留言：管理员确认后删除，留言板不再展示 */
    const del = async (id: number) => {
        try {
            const res = await http.delete(`/api/protect/board/${id}`);
            if (res.data?.code === 200) {
                message.success('已删除');
                load();
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
        { title: '留言内容', dataIndex: 'content', ellipsis: true },
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
            title: '审核', key: 'audit', width: 120,
            render: (_, r) => (
                r.approved === 1 ? (
                    <Tooltip title="已通过审核，留言板正常展示">
                        <Tag color="green">已通过</Tag>
                    </Tooltip>
                ) : (
                    <Tooltip title={manualOn ? '人工复核拦下：当前不展示，通过后放行' : 'AI 审核拦下：当前不展示，通过后放行'}>
                        <Tag color="red">待审</Tag>
                    </Tooltip>
                )
            ),
        },
        {
            title: '操作', key: 'op', width: 140,
            render: (_, r) => (
                <>
                    {r.approved === 0 && (
                        <Button type="link" size="small" onClick={() => audit(r.talkKey, 1)}>通过</Button>
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
            <Table
                rowKey="talkKey"
                columns={columns}
                dataSource={filtered}
                loading={loading}
                size="middle"
                pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
            />
            <p className="bm-note">
                留言板与说说各自独立：本页仅管理留言板所放河灯。审核 = AI 审核 + 人工复核两闸（可叠加、可单独作用）；被拦下的留言 approved=0
                不进公开列表、在下方「待审」中展示，可在此人工「通过」放行或删除。存量留言不受开关影响。
            </p>
        </div>
    );
};

export default BoardManage;

import './index.sass'
import { useEffect, useMemo, useState } from "react";
import { Button, Input, Popconfirm, Table, Tag, Tooltip, message } from "antd";
import type { ColumnsType } from 'antd/es/table';
import http from "../../../apis/axios.tsx";

/** 后台留言管理：河灯留言的查询/筛选/删除（内容审核机制预留，暂未启用）
 *  数据来自 /api/protect/board（仅 src=board 的留言，与说说完全独立）
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
    useEffect(() => { load(); }, []);

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
            title: '审核', key: 'audit', width: 100,
            render: (_, r) => (
                <Tooltip title="内容审核机制预留，暂未启用">
                    <Tag color={r.approved === 1 ? 'green' : 'red'}>{r.approved === 1 ? '已通过' : '待审'}</Tag>
                </Tooltip>
            ),
        },
        {
            title: '操作', key: 'op', width: 90,
            render: (_, r) => (
                <Popconfirm
                    title="删除这条留言？"
                    description="删除后留言板不再展示，且不可恢复"
                    onConfirm={() => del(r.talkKey)}
                    okText="删除"
                    cancelText="取消"
                >
                    <Button danger size="small" type="text">删除</Button>
                </Popconfirm>
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
            <Table
                rowKey="talkKey"
                columns={columns}
                dataSource={filtered}
                loading={loading}
                size="middle"
                pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
            />
            <p className="bm-note">
                留言板与说说各自独立：本页仅管理留言板所放河灯；内容审核机制已预留（approved 字段与审核接口），暂未启用，当前所有留言默认直接展示。
            </p>
        </div>
    );
};

export default BoardManage;

import './index.sass'
import { useEffect, useMemo, useState } from "react";
import { Button, Input, Modal, Pagination, Popconfirm, Switch, Table, Tag, Tooltip, message } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from 'antd/es/table';
import http from "../../../apis/axios.tsx";
import { useLiveRefresh } from "../../../utils/liveRefresh.ts";
import { COMMENT_REJECT_PRESETS, REJECT_REASON_MAX, aiTip } from "../ContentManage/shared";

/** 评论管理（20261002）：**文章详情页底部讨论区**的查询/筛选/裁决/删除。
 *
 *  ── 与「留言管理」的分工（这一页存在的全部理由）────────────────────────────
 *  20260905 曾把"留言管理"并进「评论管理」这个 Tab，而那个 Tab 里挂的一直是
 *  `BoardManage`（管的是河灯留言）——**标签名与内容对不上**：用户本轮的原话就是
 *  「后台管理的"评论管理"改成'留言管理'，文章详情页下面才是评论，新建评论管理」。
 *  所以现在两页各归各：`留言管理` → `BoardManage`（河灯，`/api/protect/board`），
 *  本页 → 文章评论（`/api/protect/comments`）。两张表、两套数据、**两对审核开关**。
 *
 *  ── 三条承重取舍 ──────────────────────────────────────────────────────────
 *  ① **两个开关是评论自己的那对键**（`commentAiReviewEnabled` / `commentManualReviewEnabled`，
 *     后端常量 `web_info::COMMENT_REVIEW_KEYS`），**不复用留言板那两个**：两种内容可以
 *     分别开关。提示语里点明这一点——管理员看到"两边都开着"才不会以为自己点重了。
 *     开关存 `web_info`（KV 表），**不需要迁移**：缺键的取值天然是"关"。
 *  ② **已删除的行留着、但不可再审**。评论是**软删**（`is_deleted`，作者自删与管理员删除
 *     共用同一位），所以后台列表里会出现已删的行——留着是为了溯源（谁删了什么）。
 *     但它们的操作列**没有按钮**：公开侧按 `is_deleted = 0` 过滤，给一条已删评论改判
 *     "通过"是**看不见效果**的，而后台会弹一句「已通过」并把它标绿——界面因此说了一件
 *     没发生的事。后端同一个判据也有一道（`comments.rs::audit_comment` 直接拒），
 *     前端这道是正常路径的界面判据，那道兜脚本/老前端。
 *  ③ **裁决后只改本地那一行**（不重拉全量列表）。⚠️ **入参值 ≠ 落库值**：入参 0 =
 *     「驳回」这个动作，后端落库的是 2（未通过）——直接把入参写回本地会让那一行停在
 *     「待审」（`BoardManage` 记过这个坑，`QuotaManage` 也引过它）。
 *
 *  列表接口一次回最新 500 条（后端 `ADMIN_PAGE_LIMIT`），与留言板同量级、不分页请求。
 */
interface CommentAdminItem {
    id: number;
    noteId: number;
    /** 文章标题；空 = 文章已删（那时显示「（文章已删除）」，别显示成空白格） */
    noteTitle: string;
    content: string;
    userId: number;
    username: string;
    nickname: string;
    /** 被回复者（「回复 @某人」的 admin 侧镜像）；null = 顶层评论 */
    replyToNickname?: string | null;
    createTime: string;
    /** 人工裁决：0 待审 / 1 通过 / 2 未通过（与留言板同口径） */
    approved: number;
    /** AI 判定留痕：pass / flag / reject；null = 未审（AI 关、人工全审、服务不可用、存量行）。
     *  ⚠️ 键名是 `aiResult`（后端这个 DTO 补了 rename）——**别照留言板的 `ai_result` 抄**，
     *  读错时拿到的是 undefined：不报错，只是那一列永远显示「未审」。 */
    aiResult?: string | null;
    /** 驳回理由；null = 未驳回或没人写过 */
    rejectReason?: string | null;
    /** AI 审核说明（与裁决无关，pass/flag/reject 都可能有）——管理员照它写具体理由 */
    aiReason?: string | null;
    /** 是否已软删（作者自删 / 管理员删除）。公开侧看不到这些行 */
    isDeleted: number;
}

/** 每页条数：分页从 Table 搬到外面那一条，这里的数就是唯一真源（两处都得用它） */
const PAGE_SIZE = 10;

/** 状态筛。**前四档都排除已删除的行**——它们是"当前讨论区的样子"；
 *  已删除单独一档，因为那是另一个问题（"谁删了什么"，溯源用）。
 *  若把已删行混进「已通过」，管理员会看到一行标着「已通过」却永远不出现的评论。 */
const STATUS_FILTERS: { key: string; label: string; match: (r: CommentAdminItem) => boolean }[] = [
    { key: 'all', label: '全部', match: () => true },
    { key: 'pending', label: '待审', match: (r) => r.isDeleted === 0 && r.approved === 0 },
    { key: 'pass', label: '已通过', match: (r) => r.isDeleted === 0 && r.approved === 1 },
    { key: 'reject', label: '未通过', match: (r) => r.isDeleted === 0 && r.approved === 2 },
    { key: 'deleted', label: '已删除', match: (r) => r.isDeleted !== 0 },
];

/** 两个审核开关的键名（**后端 `web_info::COMMENT_REVIEW_KEYS` 的镜像**，改一处要改两处）。
 *  抽成常量是因为它们要同时出现在三处：读取、写入、类型注解——手抄三遍必然漂一处。 */
const AI_KEY = 'commentAiReviewEnabled';
const MANUAL_KEY = 'commentManualReviewEnabled';

/** 五个风控键（**后端 `risk::RISK_KEYS` 的镜像**，顺序也一致——那个常量在 Rust 侧
 *  还是解析时的下标，顺序错了整组阈值会串位）。
 *
 *  `def` 是**界面上的占位提示**（"没配过时后端用的那个值"），**不参与提交**：
 *  提交什么只由输入框里有没有字决定。这两件事必须分开——把 `def` 当作值写进库里，
 *  等于把"没配过"永久固化成"配过了"，以后改默认值这个站也不会跟着变。
 *
 *  前缀是 `content` 而不是 `comment`：**这一套管的是评论与留言两种内容**
 *  （后端把两边合起来数），界面上的标题也照此写。 */
const RISK_FIELDS: { key: string; label: string; def: number; unit: string }[] = [
    { key: 'contentRateWindowSecs', label: '统计窗口', def: 600, unit: '秒' },
    { key: 'contentMinIntervalSecs', label: '最小间隔', def: 5, unit: '秒' },
    { key: 'contentRateLimit', label: '转人工阈值', def: 10, unit: '条' },
    { key: 'contentMuteLimit', label: '自动禁言阈值', def: 20, unit: '条' },
    { key: 'contentMuteHours', label: '禁言时长', def: 24, unit: '小时' },
];

/** 删除确认。与留言板同款（Popconfirm + 动作词按钮），抽成本文件里的一个小函数只是为了
 *  让 `columns` 里那段读起来还是一行——**它不是共享件，别往外提**。 */
const DeleteButton = ({ onConfirm }: { onConfirm: () => void }) => (
    <Popconfirm
        title="删除这条评论？"
        description="删除后公开侧不再显示（它下面的回复也一起消失），且不可恢复"
        onConfirm={onConfirm}
        okText="删除"
        cancelText="取消"
    >
        <Button danger size="small" type="text">删除</Button>
    </Popconfirm>
);

const CommentManage = () => {
    const [items, setItems] = useState<CommentAdminItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [statusFilter, setStatusFilter] = useState('all');
    const [query, setQuery] = useState(''); // 关键词：评论内容 / 昵称 / 用户名 / 文章标题
    const [asc, setAsc] = useState(false); // 时序正序/倒序
    // 审核开关（web_info key-value，缺省关）
    const [aiOn, setAiOn] = useState(false);
    const [manualOn, setManualOn] = useState(false);
    // 内容风控阈值（20261002）：**空串 = 这个键库里没有**，不是一个数值。
    // 与 `aiOn` 那种布尔开关不同，这里必须能表达"没配过"——后端缺键回落出厂默认，
    // 而填 0 是"管理员显式关掉这一档"（见 `risk::parse_config` 的三条取值规则）。
    // 用字符串而不是 number 就是为了留住这个区别：`Number('') === 0` 会把两者合并。
    const [riskOpen, setRiskOpen] = useState(false);
    const [riskForm, setRiskForm] = useState<Record<string, string>>({});
    const [riskBusy, setRiskBusy] = useState(false);
    // 驳回弹窗：驳回要能说明理由，理由会随 Reply 通知发给被回复者（见下）
    const [rejecting, setRejecting] = useState<CommentAdminItem | null>(null);
    const [rejectReason, setRejectReason] = useState('');
    const [rejectBusy, setRejectBusy] = useState(false);

    /** 拉列表。`silent` = 这一次是**背景重拉**（看板娘收尾事件 / 20 秒轮询）：
     *  · 不闪表格的 loading——后台每 20 秒抖一下 spinner，会让人以为页面自己在动；
     *  · 失败也不弹提示——服务端真挂了的话，主人手动点一次「刷新」会弹；每 20 秒叠一条
     *    「获取评论失败」只会把页面刷满，反而盖住别的东西。
     *  手动那一次（挂载 / 工具栏「刷新」）照旧给反馈。 */
    const load = async (opts?: { silent?: boolean }) => {
        if (!opts?.silent) setLoading(true);
        try {
            const res = await http.get('/api/protect/comments');
            setItems(Array.isArray(res?.data?.data) ? res.data.data : []);
        } catch {
            if (!opts?.silent) message.error('获取评论失败');
        } finally {
            if (!opts?.silent) setLoading(false);
        }
    };

    const loadSwitches = async () => {
        try {
            const res = await http.get('/api/protected/websetting');
            const d = res?.data?.data;
            if (d) {
                setAiOn(!!d[AI_KEY]);
                setManualOn(!!d[MANUAL_KEY]);
                // 风控阈值：**缺键给空串，不给 0**（`== null` 同时盖住 null 与 undefined）。
                // 写成 0 的话，设置卡一打开就把五档全显示成"已关闭"——而库里其实什么都没有。
                setRiskForm(Object.fromEntries(
                    RISK_FIELDS.map((f) => [f.key, d[f.key] == null ? '' : String(d[f.key])]),
                ));
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

    /* 跨端同步：看板娘从服务端驳回/通过一条评论时，本页只在挂载时拉过一次 ⇒ 界面一直停在
     * 旧状态，而这是最典型的用法（主人让 agent 替她审，自己开着这一页看结果）。
     *
     * `skip`（弹窗开着就不拉）不是保险起见：驳回弹窗里那个文本框是**主人正在写**的东西，
     * 一次背景重拉虽然不会清掉它的值，但会让列表在弹窗底下换掉/行序变化，而弹窗认的是
     * 那一行对象 ⇒ 主人按下「确认驳回」时，落到的可能是已经变样的列表。本地有未提交的
     * 输入时一律不覆盖（同 `BoardManage` / 后台首页待办卡的纪律）。 */
    useLiveRefresh(() => refresh({ silent: true }), { skip: () => !!rejecting });

    /** 开关切换：乐观更新，POST websetting 落 web_info；失败回滚 */
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

    /** 保存风控阈值。三条规则与后端 `risk::parse_config` 一一对应（两边口径必须一致，
     *  否则界面显示的和实际生效的会是两回事）：
     *   · **留空 ⇒ 不提交这个键**（库里保持现状；没有过就是出厂默认）；
     *   · **`0` 或负数 ⇒ 显式关掉那一档**，照提交；
     *   · **填了但不是整数 ⇒ 当场报错、整份不提交**——静默丢弃是最坏的一种：
     *     主人以为存上了，而闸门用的还是旧值（"改了设置卡、后端读不到"那个坑）。 */
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
                // 阈值是**每个请求现读**的（`risk::load_config`），所以不必重启也不必有
                // "生效"按钮——回读一次把库里的真值显示出来（而不是把输入框当真相源）
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

    /** 人工复核：通过(1)=放行展示 / 驳回(0)=写未通过(2)隐藏。**两态都能改判**：
     *  已通过的可以再驳回（收回展示），已驳回的可以「恢复通过」。
     *  reason 只在驳回时有意义（通过时后端会清空理由，传了也不生效）。
     *  已删除的行到不了这里——操作列不渲染（后端也拒，见文件头注 ②）。 */
    const audit = async (id: number, approved: number, reason?: string) => {
        try {
            const res = await http.put(`/api/protect/comments/${id}/audit`, { approved, reason });
            if (res.data?.code === 200) {
                message.success(approved === 1 ? '已通过，讨论区展示' : '已驳回（未通过），不展示');
                // ⚠️ **入参值 ≠ 落库值**：入参 0 = 「驳回」这个动作，后端落库的是 2
                // （见 comments.rs::audit_comment 的 `Set(if reject { 2 } else { 1 })`）。
                // 原样写回本地会让那一行停在「待审」：列上还是金色「待审」、操作列还挂着
                // 「通过/驳回」两颗按钮、正文下面一个字理由都不显示——后端明明改完了。
                const stored = approved === 1 ? 1 : 2;
                // 只改本地那一行（接口已确认成功）：原来每次都 load() 重拉全量列表，
                // 连审 10 条就是 11 次全量请求、每次带全部 content
                // 驳回后的理由以后端为准：本次没填而后端回落到已有理由/AI 说明时，
                // 本地不能显示成空（回落链与后端一致：人工 > reject_reason > aiReason）
                setItems((prev) => prev.map((it) => (it.id === id
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

    /** 弹窗确认驳回：理由**必填**（空理由时「确认驳回」禁用）——留空的结果是被回复者
     *  收到一句"不符合评论规范"，既不知道问题在哪、也不知道去哪儿看。后端不加硬闸
     *  （那是脚本/老前端的兼容面，它按"人工 > reject_reason > aiReason"回落），
     *  必填在这一层保证。 */
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

    /* 查询筛选：状态 + 关键词 + 时序（倒序默认，新近在前），与留言管理同构 */
    const filtered = useMemo(() => {
        const q = query.trim();
        const f = STATUS_FILTERS.find((s) => s.key === statusFilter);
        return [...items]
            .filter((it) => (f ? f.match(it) : true))
            .filter((it) =>
                q === '' ||
                it.content.includes(q) ||
                it.nickname.includes(q) ||
                it.username.includes(q) ||
                it.noteTitle.includes(q)
            )
            .sort((a, b) => {
                const cmp = a.createTime < b.createTime ? -1 : a.createTime > b.createTime ? 1 : 0;
                return asc ? cmp || a.id - b.id : -cmp || b.id - a.id;
            });
    }, [items, statusFilter, query, asc]);

    /** 分页（与 BoardManage 同款：整页是固定壳，只有表格区滚）。
     *  当前页只切**已经筛过**的那份，所以筛选条件一变就得回到第一页——否则会停在
     *  「第 3 页」而结果只有 1 页，表格空着、看着像"筛出来什么都没有"。 */
    const [page, setPage] = useState(1);
    useEffect(() => { setPage(1); }, [statusFilter, query, asc]);
    const pageRows = useMemo(
        () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        [filtered, page],
    );

    /** 删除评论（软删）。**本地把行标成已删除，而不是把它从列表里抹掉**：后端是软删，
     *  下一次 `load()` 这一行还会回来（标着「已删除」）——本地抹掉的话，刷新一下它又
     *  "复活"，看着像删除失败了。与留言板那个硬删的本地剔除**故意不同**。 */
    const del = async (id: number) => {
        try {
            const res = await http.delete(`/api/protect/comments/${id}`);
            if (res.data?.code === 200) {
                message.success('已删除（公开侧不再显示）');
                setItems((prev) => prev.map((it) => (it.id === id ? { ...it, isDeleted: 1 } : it)));
            } else {
                message.error(res.data?.message || '删除失败');
            }
        } catch {
            message.error('删除失败');
        }
    };

    const columns: ColumnsType<CommentAdminItem> = [
        {
            title: '文章', dataIndex: 'noteTitle', width: 170, ellipsis: true,
            render: (t: string, r) => (t
                ? <a href={`/article/${r.noteId}`} target="_blank" rel="noreferrer">{t}</a>
                : <span className="cm-dim">（文章已删除）</span>),
        },
        {
            title: '评论内容', dataIndex: 'content', ellipsis: true,
            // 已删除标记 + 驳回理由都跟在正文下面：审批人翻列表时要一眼看到
            // "这条为什么被驳回"与"这条已经没了"，而不是逐行去悬停猜
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
            title: '评论者', key: 'user', width: 190,
            render: (_, r) => (
                <span className="cm-user">
                    {r.nickname || r.username}
                    <i>@{r.username} · 用户 #{r.userId}</i>
                </span>
            ),
        },
        {
            title: '回复对象', dataIndex: 'replyToNickname', width: 120,
            render: (n: string | null | undefined) => (n
                ? <span className="cm-replyto">回复 @{n}</span>
                : <span className="cm-dim">—</span>),
        },
        { title: '时间', dataIndex: 'createTime', width: 160 },
        {
            /* 两段审核之第一段：AI 初审判定留痕 */
            title: 'AI 审核', key: 'ai', width: 110,
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
            /* 两段审核之第二段：人工裁决结果（0 待审 / 1 通过 / 2 未通过=驳回） */
            title: '人工审核', key: 'manual', width: 110,
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
            title: '操作', key: 'op', width: 180,
            render: (_, r) => {
                // 已删除的行**没有任何操作**：公开侧按 is_deleted = 0 过滤，改判看不见效果
                // （见文件头注 ②）。这里给一句说明而不是留一片空白——空白会被读成"这行坏了"。
                if (r.isDeleted !== 0) {
                    return (
                        <Tooltip title="已删除的评论不再公开显示，也无法再审核（保留这一行供溯源）">
                            <span className="cm-dim">已删除</span>
                        </Tooltip>
                    );
                }
                // 驳回按钮**一处实现、两态共用**：待审(0) 与已通过(1) 都挂它。
                // 已通过的也能驳回 = 把已经放行的评论收回来（后端 handler 从来没有状态守卫，
                // 卡点只在这排按钮的渲染条件上）；理由弹窗、本地写回两处都不用分叉。
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
                            <Button type="link" size="small" onClick={() => audit(r.id, 1)}>通过</Button>
                            {rejectBtn}
                        </>
                    )}
                    {r.approved === 1 && rejectBtn}
                    {r.approved === 2 && (
                        <Button type="link" size="small" onClick={() => audit(r.id, 1)}>恢复通过</Button>
                    )}
                    <DeleteButton onConfirm={() => del(r.id)} />
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
                            type="button"
                            className={statusFilter === s.key ? 'sel' : ''}
                            onClick={() => setStatusFilter(s.key)}
                        >{s.label}</button>
                    ))}
                </div>
                <Input.Search
                    placeholder="检索评论、昵称、用户名或文章标题…"
                    allowClear
                    onChange={(e) => setQuery(e.target.value)}
                    style={{ width: 300 }}
                />
                <Button onClick={() => setAsc((a) => !a)}>{asc ? '时序 ↑' : '时序 ↓'}</Button>
                <Button icon={<ReloadOutlined />} onClick={() => refresh()} loading={loading}>
                    刷新
                </Button>
                {/* 风控设置默认收起：它是一组"配一次就不动"的阈值，常驻会白占一行高度 */}
                <Button className="cm-risk-toggle" onClick={() => setRiskOpen((v) => !v)}>
                    风控设置{riskOpen ? ' ▲' : ' ▼'}
                </Button>
                <span className="cm-count">共 {filtered.length} 条评论</span>
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
            {/* 内容风控阈值（20261002）。默认收起（见工具栏那个开关）——它是一组
                "配一次就不动"的数，而这一页的高度链是固定的（多一个常驻行就少一行表格）。
                **标题里点明"与留言一起计数"**：那两个阈值管的是评论 + 留言的合计条数，
                只盯着本页读会以为只数评论，于是把阈值调得偏小、留言板跟着被误伤。 */}
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
            {/* 滚动从整页挪进这一块（同 BoardManage）：上面两行是固定的，**只有这张表在
                窗口内滚**，表头用 CSS sticky 吸在这一块的顶沿（见 index.sass）；
                分页条也移出滚动区、钉在底部。 */}
            <div className="cm-scroll">
                <Table
                    rowKey="id"
                    columns={columns}
                    dataSource={pageRows}
                    loading={loading}
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
                    total={filtered.length}
                    showSizeChanger={false}
                    onChange={setPage}
                    showTotal={(t) => `共 ${t} 条评论`}
                />
            </div>
            {/* 驳回理由弹窗：理由随通知发给被回复者，**必填** */}
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
                    // 理由必填：空理由时按钮不可点（见 confirmReject 的说明）
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

export default CommentManage;

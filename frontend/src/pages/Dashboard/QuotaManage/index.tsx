import './index.sass'
import { useEffect, useMemo, useState } from "react";
import { Button, Grid, Input, Modal, Pagination, Table, Tag, Tooltip, message } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from 'antd/es/table';
// 走接口层而不是就地写 URL（这一页与 agent 的 `list_quota_requests` 工具**共用同一条
// 接口**，端点字符串只该有一份；`ok`/`errMsg` 也是那一层收口的 `code === 200` 口径）
import { errMsg, getQuotaRequests, ok, reviewQuotaRequest } from "../../../apis/ProfileMethods.tsx";
import { useLiveRefresh } from "../../../utils/liveRefresh.ts";
import { quotaBalanceText, quotaLevel } from "../../../utils/quota.ts";

/** 额度管理（20260929）：普通用户「对话额度用完了、申请重置」的**裁决队列**。
 *
 *  数据来自 `GET /api/protected/quota/requests`（挂后台守卫域，与 agent 的
 *  `list_quota_requests` 工具**共用同一条接口**——所以这一页与看板娘看到的是同一份队列）。
 *  两个动作：批准（`approved: true`，会把对方计数器清零）与驳回（`approved: false` + 理由）。
 *
 *  ── 与账号管理页的分工（别把两件事混起来）──
 *  按**账号**的动作（含"主动重置，不管他有没有申请过"）住在账号管理那一行的「重置额度」
 *  按钮上；本页只放**按申请**的裁决。与评论管理（BoardManage）只管裁决队列同构。
 *
 *  ── 三条承重取舍 ──────────────────────────────────────────────────────────
 *  ① **回包只有一句中文，所以成功之后重拉列表**（不做"就地更新那一行"）。
 *     就地更新在这里做不到诚实：批准改的是**两个**事实——这一行的 status，以及
 *     **那个账号的 `used`（清零了）**——而回包一个值都没带回来。自己拼一个 status=1
 *     写回本地，正是 `BoardManage` 记下的那个坑（「入参值 ≠ 落库值」，那里入参 0 而
 *     库落 2，界面于是停在待审）。列表上限 200 行、裁决是低频动作，重拉一次最省事也最诚实。
 *  ② **驳回理由必填**（空理由时「确认驳回」禁用）＋常见类型预设。后端**不硬闸**
 *     （理由为空时它回落成「管理员没有填写理由」，见 routes/quota.rs 头注②）——
 *     留空的结果是申请人收到一句什么也没说的通知，等于白发一条。必填在这一层保证，
 *     与评论管理逐条同形。上限 255 是本页与后端 `NOTE_MAX`、`quota_request.note` 的
 *     **列宽**三处对齐的数（后端超限是拒绝而不是截断）。
 *  ③ **`status` 是三值不是布尔**：0 待处理 / 1 已批准 / 2 已驳回。已处理的行不再有动作
 *     （后端也只是"这条申请已经处理过了"，不是错误），所以「全部」视图里那两态只读。
 */
interface QuotaRow {
    id: number;
    userId: number;
    username: string;
    nickname: string;
    /** 申请人**当前**已用轮数（不是提交那一刻的快照——审核看的是"他现在还剩多少"） */
    used: number;
    /** 上限；**0 = 不限额**（别把 0 读成"用完了"） */
    limit: number;
    reason?: string | null;
    /** 0 待处理 / 1 已批准 / 2 已驳回 */
    status: number;
    /** 管理员的驳回理由（批准时为 null） */
    note?: string | null;
    createdAt: string;
    handledAt?: string | null;
}

/** 常见驳回理由预设：点一下填进**可编辑**的文本框，管理员按需改。
 *  只放"一眼能判、与额度这件事对得上"的类型；不放"其他"这种等于没填的项
 *  ——理由必填的意义就在于说清是哪一类（同评论管理那组预设的取舍）。 */
const REJECT_PRESETS = ['理由不充分', '额度还有剩余', '短时间内重复申请', '请先说明用途'];

/** 驳回理由上限（字符）。与后端 `quota::NOTE_MAX` 和 `quota_request.note` 的列宽
 *  （varchar(255)）是同一个数——**改一处要三处同步**。 */
const NOTE_MAX = 255;

/** 每页条数（分页由外面那一条承担，见下面 `.qm-scroll` 的说明） */
const PAGE_SIZE = 10;

/** 用量那一列：**余额口径**（20260929b 与个人中心/账号行统一）。
 *
 *  `limit === 0` ⇒ 不限额（与后端 `quota::limit_of` 的口径一致）。不限额的人**不会**
 *  出现在这个队列里（他的计数器从来不增长），所以这一支只是防御——真出现时也不能
 *  显示成 `0/0`（那会被读成"用完了"）。
 *
 *  **裁决看的就是余额**：这个页面唯一的问题"该不该再给他 500 轮"，答案取决于他此刻
 *  还剩多少——`已用 363/500` 要心算一步，`剩 137/500` 直接就是结论。减法与档位色都
 *  来自 `utils/quota.ts`（同一套在四处显示共用），这里不许自己再算一遍。 */
const usageText = (r: QuotaRow): string => quotaBalanceText(r.limit - r.used, r.limit)

/** 用量那一列的档位（决定染不染色）。与文案同一个减法——两处都走 util，不各算一遍。 */
const usageLevel = (r: QuotaRow) => quotaLevel(r.limit - r.used, r.limit)

/** 状态标签（三值三色，与评论管理那两段状态同一套配色语义） */
const STATUS_TAG: Record<number, { text: string; color: string; tip: string }> = {
    0: { text: '待处理', color: 'gold', tip: '可以「批准」（对方的额度恢复到上限）或「驳回」（额度不变）' },
    1: { text: '已批准', color: 'green', tip: '已批准、额度恢复到上限，申请人收到了一条站内通知' },
    2: { text: '已驳回', color: 'red', tip: '已驳回，额度一个字节都没动；申请人收到理由，还可以再申请' },
}

const QuotaManage = () => {
    const [rows, setRows] = useState<QuotaRow[]>([]);
    const [loading, setLoading] = useState(false);
    /** 只看待处理 / 全部。判据交给**服务端**（`?status=pending`）而不是本地过滤：
     *  队列是全局的（所有人的申请），本地过滤会先被 `limit(200)` 截一次。 */
    const [onlyPending, setOnlyPending] = useState(true);
    /** 驳回弹窗 */
    const [rejecting, setRejecting] = useState<QuotaRow | null>(null);
    const [rejectReason, setRejectReason] = useState('');
    /** 批准弹窗（批准是不可逆的，且会清零，所以要二次确认） */
    const [approving, setApproving] = useState<QuotaRow | null>(null);
    const [busy, setBusy] = useState(false);
    /** 当前页（客户端分页，见下面的 `.qm-foot`）。切筛选时归 1——否则在"全部"的第 3 页
     *  切到"待处理"（可能只有 2 条）会停在一个空页面上。 */
    const [page, setPage] = useState(1);

    /** 拉列表。`silent` = 背景重拉（看板娘收尾事件 / 20 秒轮询）：不闪 loading、失败不弹提示
     *  ——后台每 20 秒抖一下 spinner 会让人以为页面自己在动，每 20 秒叠一条报错只会刷屏。
     *  手动那一次（挂载 / 「刷新」按钮 / 每次裁决之后）照旧给反馈。 */
    const load = async (opts?: { silent?: boolean }) => {
        if (!opts?.silent) setLoading(true);
        try {
            const res = await getQuotaRequests(onlyPending ? 'pending' : 'all');
            // 信封口径：`{code,message,data}`，data 是数组（与本页其它后台列表一致）
            setRows(Array.isArray(res?.data?.data) ? res.data.data : []);
        } catch {
            if (!opts?.silent) message.error('获取额度申请失败');
        } finally {
            if (!opts?.silent) setLoading(false);
        }
    };

    useEffect(() => {
        setPage(1);
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onlyPending]);

    /* 跨端同步（20260929）：看板娘可以替主人批准/驳回申请（agent 的
       `approve_quota_request` / `reject_quota_request`），也可以主动重置某个账号的额度。
       本页若只在挂载时拉一次，主人开着这一页让 agent 去批，界面就永远停在待处理。
       `skip`（裁决弹窗开着就不拉）：弹窗认的是**那一行对象**，底下列表在它开着的时候
       被换掉/重排，主人按下去的那一下就可能落到已经变样的队列上（同 BoardManage）。 */
    useLiveRefresh(() => load({ silent: true }), { skip: () => !!rejecting || !!approving });

    /** 当前页那几条。**只切显示、不改 rows**：上面那个「共 N 条」与页脚的总数都读全量。 */
    const pageRows = useMemo(
        () => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        [rows, page],
    );

    /** 裁决。`approved` = 批准（后端会清零对方的计数器）/ 驳回（额度不动）。
     *  理由只在驳回时有意义（批准时后端恒把 note 落 NULL，传了也不生效）。
     *  成功之后**重拉列表**——见文件头注 ①（回包没有值可写回，且批准还改了对方的 used）。 */
    const review = async (row: QuotaRow, approved: boolean, reason?: string) => {
        setBusy(true);
        try {
            const res = await reviewQuotaRequest(row.id, approved, reason);
            if (ok(res)) {
                // 人话在 **`data`** 里（`ApiResponse::success` 的 message 恒为字面量 "ok"，
                // 见 src/utils.rs——后台这几页踩过不止一次）
                message.success(res.data.data || '已处理');
                await load({ silent: true });
                return true;
            }
            message.error(errMsg(res));
            // 失败也重拉一次：`这条申请已经处理过了` 意味着**别人刚处理过**（agent 或另
            // 一个窗口），本地那一行已经过期——把它留在屏幕上比拉一次网络糟得多
            await load({ silent: true });
            return false;
        } catch {
            message.error('操作失败');
            return false;
        } finally {
            setBusy(false);
        }
    };

    const confirmReject = async () => {
        if (!rejecting) return;
        const okDone = await review(rejecting, false, rejectReason.trim());
        if (okDone) {
            setRejecting(null);
            setRejectReason('');
        }
    };

    const confirmApprove = async () => {
        if (!approving) return;
        const okDone = await review(approving, true);
        if (okDone) setApproving(null);
    };

    /* ⚠️ **窄屏裁列 + 收窄（20261006 用户第 6 条）**：视口 < `screenLG`（本仓在
       `WASHI_THEME.common` 里把它抬到 1024）时，低信息量的列挂 `responsive: ['lg']`
       直接筛掉，窄屏只留 **申请人 + 申请理由 + 操作**。
       —— 这里**没留「状态」而留了「申请人」**（与计划里那句「留标题+状态+操作」是故意
       不同的取舍）：本页默认就停在「待处理」页签上，`状态` 列在窄屏几乎是个常量；而
       「批准」把对方的额度恢复到上限、**不可逆**（没有「改回原值」这个入口），所以
       「这一行是谁」比「这一行什么状态」更要紧。余额/上限、申请时间同样挂 `lg`：
       余额在批准确认弹窗里有，申请时间对「要不要批」没有影响。。
       剩下那几列里写死 px 的还要**收窄**（下面 `isNarrow` 那几处三元）：这不是可选的 ——
       这些表是 `table-layout: fixed`（antd 见到 `ellipsis` 就会加），定宽列先把自己拿满、
       剩下的才轮到没写宽的正文列，实测 390 屏上**只裁列不收宽**正文列只剩 66px。
       断点用 antd 自己的 `useBreakpoint`：它读的正是 `WASHI_THEME.common.screenLG`
       那颗令牌 ⇒ 与 CSS 那条 `@media`、壳里那条 matchMedia 同一处事实源，不会漂开
       （它是 `useLayoutEffect`，首帧那个空的 `{}` 上不了屏 ⇒ 宽屏不会闪一下窄屏形态）。
       宽屏（≥1024）逐像素不变。 */
    const screens = Grid.useBreakpoint();
    const isNarrow = !screens.lg;
    const columns: ColumnsType<QuotaRow> = [
        {
            // 窄屏收窄到 110（昵称照旧折行、`@账号名 · 用户 #id` 那行跟着挤）——
            // 这一列是窄屏三列里唯一不能删的（谁能被恢复满额），所以让出宽度的是自己。
            title: '申请人', key: 'user', width: isNarrow ? 110 : 220,
            render: (_, r) => (
                <span className="qm-user">
                    {r.nickname || r.username}
                    <i>@{r.username} · 用户 #{r.userId}</i>
                </span>
            ),
        },
        {
            // 标题也跟着改口径（20260929b）：这一列现在给的是**余额**，标题写「已用 / 上限」
            // 就与格子里的字对不上了。
            title: '剩余 / 上限', key: 'usage', width: 130, responsive: ['lg'],
            // **数字来自服务端**（`limit` 由 env 决定、`used` 是他此刻的真实值），
            // 前端不把 500 写死——上限是可以调的，写死的那一刻这一列就在说谎。
            render: (_, r) => (
                <span className={`qm-usage${usageLevel(r) ? ` is-${usageLevel(r)}` : ''}`}>
                    {usageText(r)}
                </span>
            ),
        },
        {
            title: '申请理由', dataIndex: 'reason', ellipsis: true,
            render: (v: string | null | undefined, r) => (
                <>
                    <div className="qm-reason">
                        {v ? v : <i className="qm-none">（没填理由）</i>}
                    </div>
                    {/* 驳回理由跟在下面（同评论管理那条纪律：翻列表时要一眼看到
                        "这条为什么被驳回"，不必逐行悬停猜） */}
                    {r.status === 2 && (
                        <div className="qm-note">
                            驳回理由：{r.note || <i className="qm-none">未填写</i>}
                        </div>
                    )}
                </>
            ),
        },
        { title: '申请时间', dataIndex: 'createdAt', width: 160, responsive: ['lg'] },
        {
            title: '状态', key: 'status', width: 200, responsive: ['lg'],
            render: (_, r) => {
                const st = STATUS_TAG[r.status] || { text: '未知', color: 'default', tip: '' };
                return (
                    <>
                        <Tooltip title={st.tip}>
                            <Tag color={st.color}>{st.text}</Tag>
                        </Tooltip>
                        {/* 处理时间只在已处理的行上出现（两列都空时整块不画） */}
                        {r.handledAt && <div className="qm-handled">处理于 {r.handledAt}</div>}
                    </>
                );
            },
        },
        {
            title: '操作', key: 'op', width: isNarrow ? 110 : 150,
            render: (_, r) => (
                // 已处理的行一条动作都不给（后端也只是"已经处理过了"，不是错误）
                r.status === 0 ? (
                    <>
                        <Button type="link" size="small" onClick={() => setApproving(r)}>批准</Button>
                        <Button
                            danger type="link" size="small"
                            onClick={() => { setRejecting(r); setRejectReason(''); }}
                        >驳回</Button>
                    </>
                ) : null
            ),
        },
    ];

    return (
        <div className="QuotaManage">
            <div className="qm-toolbar">
                <div className="qm-tabs" role="tablist">
                    <button type="button" className={onlyPending ? 'sel' : ''}
                            onClick={() => setOnlyPending(true)}>待处理</button>
                    <button type="button" className={!onlyPending ? 'sel' : ''}
                            onClick={() => setOnlyPending(false)}>全部</button>
                </div>
                <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
                    刷新
                </Button>
                <span className="qm-count">共 {rows.length} 条申请</span>
            </div>
            {/* 上面那一行固定、只有这张表在窗口内滚（表头 sticky，见 index.sass）——
                同评论管理那套：筛选头跟着表格一起滚走，翻到第 30 条想换筛选得先滚回顶上。 */}
            <div className="qm-scroll">
                <Table
                    rowKey="id"
                    columns={columns}
                    dataSource={pageRows}
                    loading={loading}
                    size="middle"
                    pagination={false}
                    locale={{ emptyText: onlyPending ? '没有待处理的额度申请' : '还没有人申请过重置' }}
                />
                <p className="qm-note-text">
                    普通用户终身 500 轮对话额度（每轮 1 轮，含检索；管理员不限额）。
                    「批准」会把对方的额度恢复到上限、他立刻可以继续问，并收到一条站内通知；
                    「驳回」只发通知、额度一个字节都不动，他还可以再申请。
                    想<b>主动</b>把某个账号的额度恢复到上限（不必他先申请）请到「账号管理」那一行用「重置额度」。
                </p>
            </div>
            <div className="qm-foot">
                <Pagination
                    size="small"
                    current={page}
                    pageSize={PAGE_SIZE}
                    total={rows.length}
                    showSizeChanger={false}
                    onChange={(p) => setPage(p)}
                    showTotal={(t) => `共 ${t} 条申请${onlyPending ? '（当前只显示待处理）' : ''}`}
                />
            </div>

            {/* 批准确认（受控 Modal：命令式弹窗沙箱测不到）。按钮写**动作词**而不是
                「确定」、「批准」是这一下唯一不可逆的那半边——恢复满额之后没有"改回原值"
                这个入口（同意闸与风险说明同后台冻结那套）。
                标题里的身份用**账号名**而不是昵称：昵称可空、可重名、可随时自己改，
                而这一下是不可逆的（同页「发通知」那个弹窗也只用账号名）。申请人是谁
                在列表里已经写全了（`@账号名 · 用户 #id` + 昵称）。
                **按钮与正文都写「恢复到上限」而不是「清零」**（20260929 用户指出）：
                主人看到的那个数是递减的余额，"计数器清零"是库里的实现。 */}
            <Modal
                title={`批准 ${approving?.username || ''} 的额度重置申请？`}
                open={!!approving}
                onOk={confirmApprove}
                onCancel={() => setApproving(null)}
                okText="批准并恢复满额"
                cancelText="取消"
                confirmLoading={busy}
                // 类名给沙箱断言用（`tests/users-page.test.py` 按它认这个弹窗）——
                // 同 `BoardManage` 的 `.bm-reject-ok`、账号页的 `.tu-notify-ok`：
                // 一页上同时挂着几个 `.ant-modal-wrap`，只有类名能把它们分开
                // （按文案认会在改文案时静默失联）。
                okButtonProps={{ className: 'qm-approve-ok' }}
                width={460}
            >
                <div className="qm-confirm">
                    {/* 括号里为什么印**已用**而不是列表那列的余额：这一句要回答"他要被
                        退掉多少"，那个数就是已用的这一截（余额是"还剩多少"，读了会以为
                        恢复的是余额）。余额口径的单一来源仍是 `utils/quota.ts`（列表列用它）。 */}
                    <div>
                        批准后：该账号的额度<b>恢复到上限</b>（当前已用
                        {approving ? approving.used : ''} 轮，这一截不再计入），
                        他立刻可以继续对话，并会收到一条站内通知。
                    </div>
                    <div className="qm-confirm-warn">
                        这一下撤不回来——原值不会被记下来，唯一能再变的是下一次重置。
                    </div>
                </div>
            </Modal>

            {/* 驳回弹窗：**理由必填**（空理由时按钮禁用）——留空的结果是申请人收到一句
                什么也没说的通知，等于白发一条。后端不加硬闸（那是脚本/agent 也在用的
                兼容面），必填在这一层保证（同评论管理的驳回弹窗）。 */}
            <Modal
                title={`驳回 ${rejecting?.username || ''} 的额度重置申请？`}
                open={!!rejecting}
                onOk={confirmReject}
                onCancel={() => { setRejecting(null); setRejectReason(''); }}
                okText="确认驳回"
                cancelText="取消"
                okButtonProps={{
                    className: 'qm-reject-ok',
                    danger: true,
                    loading: busy,
                    // **空理由 ⇒ 按钮禁用**：这一条是"理由必填"的落点（后端只做回落，
                    // 见上面那条注释）。`.trim()` 是承重的——打几个空格不算填了。
                    disabled: !rejectReason.trim(),
                }}
                rootClassName="qm-reject-modal"
                width={520}
            >
                <p className="qm-reject-tip">
                    驳回后<b>额度一个字节都不动</b>，申请人会收到一条站内通知、理由一并带上，
                    他还可以再申请。<b>理由必填</b>——写清为什么这一次不批，他才知道下次该怎么办。
                </p>
                <div className="qm-reject-presets">
                    {REJECT_PRESETS.map((p) => (
                        <Button key={p} size="small" className="qm-reject-preset"
                                onClick={() => setRejectReason(p)}>{p}</Button>
                    ))}
                </div>
                {/* `counter-room`：给 showCount 的计数腾 22px（它不占布局空间，
                    Modal footer 只留了 12px）。见 src/index.css 那条规则。 */}
                <Input.TextArea
                    className="counter-room"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    maxLength={NOTE_MAX}
                    showCount
                    autoSize={{ minRows: 3, maxRows: 5 }}
                    placeholder="例如：这个月已经重置过一次了，先用完剩下的额度再来申请"
                />
            </Modal>
        </div>
    );
};

export default QuotaManage;

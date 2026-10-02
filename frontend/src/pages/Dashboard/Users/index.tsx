import './index.sass'
import { Button, Dropdown, Input, message, Modal, Radio, Tabs, Tag, Tooltip } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { TabsProps } from 'antd';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import BoardManage from '../BoardManage';
import CommentManage from '../CommentManage';
import QuotaManage from '../QuotaManage';
// 共享 axios 客户端（20260926）。这一页原来六处都自己 `fetch` + 手拼
// `'Bearer ' + token`，于是**绕过了全局那两件事**：①令牌过期时的 401 处理
// （清 tokenKey + 提示 + 跳 /login，见 src/apis/axios.tsx 的响应拦截器）——
// 手拼的那份只会弹一句"请求失败"，管理员被冻结/令牌失效时看到的是一句无信息的
// 报错而不是登录页；②请求头里 token 的 `Bearer ` 前缀归一（后端 strip_prefix）。
// 同页的评论管理（BoardManage）本来就走共享客户端，两半行为不一致本身就是坑。
import http from "../../../apis/axios.tsx";
import getToken from "../../../apis/getToken.tsx";
import { useLiveRefresh } from "../../../utils/liveRefresh.ts";
// 账号列表的**单一真源**住在同目录的 ./tempUsers.ts（模块级缓存，20261002）。
// 这一页从"自己拿着数组、挂载时拉一次"改成"订阅那份缓存"——见该文件头注的四条纪律。
// 注意 `invalidateTempUsers`（写操作后）与 `refreshTempUsers`（定时/事件叫醒）不是
// 同义词：前者会**作废在途读数**再重拉，后者与在途请求去重。别顺手换着用。
import { invalidateTempUsers, refreshTempUsers, useTempUsers, type TempUser } from "./tempUsers.ts";
import { quotaChipText, quotaLevel, type QuotaLevel } from "../../../utils/quota.ts";
import { ROLE_LABEL, roleLabel, getRoleFromToken, getUidFromToken } from "../../../utils/auth.ts";
import { RoleBadge } from "../../../components/RoleBadge";

/** 用户管理 = 账号管理（临时访客账号）+ 留言管理（河灯审核）+ 评论管理（文章讨论区审核）
 *  + 额度管理（重置申请裁决）。
 *  20260905 拍板：原 Announcement 内嵌临时用户段迁入「账号管理」；
 *  原独立「留言管理」页并入「评论管理」。设置类（站点信息等）拆独立侧栏入口 UserControl。
 *
 *  ⚠️ **20261002 把那次合并拆回来了**（用户原话：「后台管理的"评论管理"改成'留言管理'，
 *  文章详情页下面才是评论，新建评论管理」）：合并之后那个 Tab 的**标签名与内容对不上**
 *  ——叫「评论管理」、里面挂的一直是 `BoardManage`（管的是河灯留言）。现在：
 *  `留言管理` → `BoardManage`（河灯，行为零改动），`评论管理` → `CommentManage`（文章评论）。
 *
 *  `?tab=` 是**深链**（20260924 起一个、20260929 起两个、20261002 起三个）：后台首页待办卡
 *  上那两行提示（"N 条评论待人工审核" / "N 条额度重置申请待处理"）点过来就该直接看见那几条，
 *  而不是先看见账号列表再自己找 Tab。取值走**白名单** `review | comment | quota`，认不出的
 *  落回账号管理。只在**进页那一下**当初始值——之后切 Tab 不再回写 URL（这一页没有
 *  "当前 Tab 是哪一页"的可分享语义，URL 也不是它的真源）。
 *  ⚠️ 首页待办卡那行数的是**河灯留言**（`profile.rs::board_pending_count`），所以它
 *  20261002 跟着改叫「条留言待人工审核」、**继续指 `?tab=review`**（落点与数值一致）。
 *  **文章评论的待审数不在这条汇总里**：要加就得新开一个 `pendingComments` 字段 + 本页
 *  第三行，并且指向 `?tab=comment`——两个数合成一行的话，点进去只能落在其中一页，
 *  另一个数就成了永远对不上的账（同一段说明也在 `Dashboard/Home/index.tsx` 里）。
 *
 *  账号筛选（20260926）：列表从"只列普通账号"扩到全部已知角色，于是要能按
 *  角色筛、按用户名检索；这一块与评论管理同款——**筛选与检索的头固定，只有
 *  下面的账号列表在窗口内滚**（原来整页滚，翻到后面想换个关键词得先滚回顶上）。
 */

/** 账号是否已冻结。判据与后端 `crate::authz::is_frozen` **同一条**：
 *  `user.status` 里不是 0 的一律算冻结（未登记的取值也按冻结处理，不默认放行）。
 *  `undefined`（字段缺失）按 0 算——缺失只可能出现在"前端已上线、后端还没"这种
 *  部署顺序里，而这两半是同一次部署、迁移先跑，所以它不该发生；
 *  真发生了也宁可少标一个"冻结"（后端照样会拒它），而不是把整页账号标成冻结。
 *  这里刻意不做「=== 1 才算冻结」：那会与后端对不上，后端认的是 != 0。 */
const isFrozen = (u: any) => Number(u.status ?? 0) !== 0

/** 账号**当前是否处于禁言期**（20261002 内容风控）。
 *
 *  ⚠️ 判据**不在这一页**：后端算好了 `muted` 再回传（`authz::is_muted` = 现在 < 到期
 *  时刻）。前端自己拿 `mutedUntil` 跟当前时间比大小会造出第二个真相源——而且"永久"
 *  是一个哨兵值，比错一次就露馅。这里是**取用**，不是重算。
 *  字段缺失按 false（老后端 + 新前端）：不标"已禁言"是这里唯一安静的失败，
 *  而反过来的默认值会把整页账号标成禁言。 */
const isMuted = (u: any) => !!u.muted

/** `mutedUntil`（原始库值）→ 列表上那一截人话（`永久` / `2026-10-04 12:00`）。
 *
 *  这是后端 `authz::mute_until_text` 的**镜像**，而不是"前端也判一次"：账号列表是
 *  裸数组形状的**跨语言契约**（`TempUserInfo`，agent 的工具层也读它），不能为了
 *  显示美观再多加一个字段——那边要的是原始事实（谁被禁到什么时候），这边要的是能读的字。
 *  哨兵值与后端 `authz::MUTE_FOREVER` 同源；用**字符串比大小**（定宽 ISO 格式，
 *  字典序即时间序），不做日期解析——解析要处理时区与非法值，而这里只需要"是不是那个哨兵"。 */
const MUTE_FOREVER = '9999-12-31 23:59:59'
const muteUntilText = (v?: string | null) => {
    if (!v) return ''
    if (v >= MUTE_FOREVER) return '永久'
    return v.slice(0, 16) // 去掉秒：列表里到分钟足够
}

/** 禁言时长选项（小时）。**`0` = 永久**（后端认 `null` / `<=0` 为永久，
 *  见 `SetMuteReq`）——列表里放一个"永久"选项比让管理员自己算小时数清楚得多。
 *  默认选 24 小时：最常见的处置是"先关一天看看"，而最不该成为默认的是永久。 */
const MUTE_DURATIONS: { hours: number; label: string }[] = [
    { hours: 1, label: '1 小时' },
    { hours: 24, label: '24 小时' },
    { hours: 24 * 7, label: '7 天' },
    { hours: 0, label: '永久' },
]

/** 筛选项：前三个按**角色**分流，最后一个是与角色正交的**状态**筛选
 *  （20260926 用户点名要的三个：管理员账号 / 普通用户账号 / 冻结账号）。
 *  「全部」是额外给的一个复位项。
 *
 *  刻意**不做**「角色筛选自动排除冻结账号」：一个被冻结的管理员在两个筛选项下
 *  都出现是对的——"他是管理员"和"他现在不能用"是两件同时为真的事，
 *  行上有「已冻结」标签，两处都能看见。把它从角色视图里藏起来反而是丢信息。 */
const ACC_FILTERS: { key: string; label: string; match: (u: any) => boolean }[] = [
    { key: 'all', label: '全部', match: () => true },
    { key: 'admin', label: '管理员账号', match: (u) => u.role === 'admin' },
    { key: 'user', label: '普通用户账号', match: (u) => u.role !== 'admin' },
    { key: 'frozen', label: '冻结账号', match: (u) => isFrozen(u) },
]

/** 可指派的四个身份（20260926；20261002 加杂鱼）。`superadmin` **不在这一列**，
 *  而且不是"忘了加"：后端的取值域判据是 `authz::is_assignable_role`（已知 且
 *  != superadmin），多一个超级管理员是一条数据库迁移的决定，不该是界面上点一下的事。
 *
 *  `rank` 只服务于**按钮极性**：变更身份往哪个方向都伴随"对方全部会话失效"，
 *  分不出轻重的一律染红等于没信息——照冻结/解冻那一套（收紧=danger、放开=普通）
 *  取"权限收窄"那一侧。
 *
 *  杂鱼的 `rank` 是 **-2 而不是 -1**：`roleRank` 的兜底就是 -1（认不出的角色），
 *  用 -1 会让"杂鱼"与"未知角色"同档，而下面对 `rank` 的比较正是决定按钮极性与
 *  「收窄/放宽」文案的那一处。零工具角色比普通用户还窄一档，-2 是它该在的位置。 */
const ASSIGNABLE_ROLES: { role: string; rank: number }[] = [
    { role: 'zako', rank: -2 },
    { role: 'user', rank: 0 },
    { role: 'secretary', rank: 1 },
    { role: 'admin', rank: 2 },
]
const roleRank = (role?: string | null) =>
    ASSIGNABLE_ROLES.find((r) => r.role === role)?.rank ?? -1

/** 管理员（非超管）能动的那两档（20261002 下放）。**与 Rust 侧 `authz::is_admin_tier`
 *  同一份口径**：判据只有一份实现（在后端），这里是"按钮该不该出现"的副本，
 *  改这里就要一起改那里，反之亦然。 */
const ADMIN_ROLE_TIERS: string[] = ['user', 'zako']

/** 行上那一截额度：**文案 + 档位**（20260929，20260929b 改口径）。
 *
 * 文案与档位都从 `utils/quota.ts` 来——同一套减法与阈值在四处显示共用（个人中心额度
 * 页签 / 这一行 / 额度管理那一列 / agent 的系统上下文行），这里**不许**自己再算一遍
 * `limit - used`。
 *
 * 三种"不是数字"的形态都是**不同的事实**，不许合并成一个：
 *  · `chatQuotaLimit === 0` ⇒ 「不限额」（管理员档；后端 `quota::limit_of` 的口径——
 *    0 是"不限"而不是"上限为零"，这与"用完了"正好相反）；
 *  · 两个字段都在 ⇒ 「额度：剩 N/上限」（**余额口径**：用户要求"500 开始减少而不是
 *    0 开始计数"——`已用/上限` 读起来要从零往上攒，而额度是**越用越少**的东西）；
 *  · 字段缺失（前端已上线、后端还没到）⇒ 「额度 —」，**不是** 剩 0/0：那会被读成
 *    "这个人的额度用完了"，而同一页的行上没有别的线索能纠正它。
 *
 * 档位（`is-low` / `is-critical` / `is-empty`）**是这一批新加的**：此前那一小截刻意
 * 不上色（"不拿颜色暗示多少，用完了在个人中心才有结论"）。改成余额口径之后那句话
 * 不成立了——`剩 3/500` 本身就是结论，账号一列扫下来该看得出谁快没了。 */
const quotaChip = (u: any): { text: string; level: QuotaLevel | null } => {
    const lim = u?.chatQuotaLimit
    const used = u?.chatQuotaUsed
    if (typeof lim !== 'number' || typeof used !== 'number') {
        return { text: '额度 —', level: null }
    }
    return { text: quotaChipText(used, lim), level: quotaLevel(lim - used, lim) }
}

/** 缓存还没到手时的占位**空数组常量**。必须是模块级同一个引用：写成 `?? []`
 *  会在每次渲染造一个新数组，把下面 `filteredUsers` 的 memo 每次都打穿。 */
const NO_USERS: TempUser[] = []

const Users = () => {
    const [searchParams] = useSearchParams()
    // 初始 Tab 走**白名单**（20260929 起两个）：`?tab=` 是给别处点进来的深链用的
    // （后台首页那两行提示分别指向 `?tab=review` 与 `?tab=quota`），不是真源——
    // 认不出的值一律落回账号管理，而不是把 URL 里的任意串当成 Tab key。
    const [tab, setTab] = useState(() => {
        const t = searchParams.get('tab')
        return t === 'review' || t === 'comment' || t === 'quota' ? t : 'accounts'
    })

    // ── 临时用户（账号管理）──
    // 列表本体自 20261002 起住在 `./tempUsers.ts`（模块级缓存），这一页只是它的消费者。
    // 原来这里挂载时 `setTimeout(loadTempUsers, 500)` 拉一次——切走再切回来是同一套
    // "先空一下再填上"，而两次的数据几乎一模一样（用户报的"每次点都重新拉数据"，
    // 那个 500ms 空窗正是观感的来源）。现在切回页签**首帧就是上次那份**，同时在后台
    // 静默刷新一次；`enabled` 为 false（不在账号页签）时一次请求都不发。
    // 这里原来还有一行 `const token = localStorage.getItem('tokenKey')`，六处 fetch
    // 各拼一次 `'Bearer ' + token`。改走共享客户端之后它没有用武之地——令牌由
    // `src/apis/axios.tsx` 的请求拦截器统一加（且顺手归一了 `Bearer ` 前缀）。
    const { users: cachedUsers, failed: usersFailed } = useTempUsers(tab === 'accounts')
    /** 给下面那几处渲染用的数组形态。`null`（还没成功读到过）不能塌成 `[]`——
     *  "读不到"与"读到了、确实是空的"是两件事，塌掉之后占位文案就只剩"暂无账号"
     *  一种说法了（本仓已经栽过这个谎）。空态的三分法见列表那一段。 */
    const tempUsers = cachedUsers ?? NO_USERS
    const [tempUsername, setTempUsername] = useState('')
    const [tempPassword, setTempPassword] = useState('')
    const [pwModalOpen, setPwModalOpen] = useState(false)
    const [pwTarget, setPwTarget] = useState<any>(null)
    const [pwNewPassword, setPwNewPassword] = useState('')
    const [recoveryModalOpen, setRecoveryModalOpen] = useState(false)
    const [recoveryTarget, setRecoveryTarget] = useState<any>(null)
    const [recoveryCode, setRecoveryCode] = useState('')
    // 账号筛选/检索（20260926）
    const [accFilter, setAccFilter] = useState('all')
    const [accQuery, setAccQuery] = useState('')

    /** 筛选后的账号列表：先按角色分流，再按**用户名或 ID**包含匹配（用户名大小写不敏感）。
     *  与评论管理同一条纪律——筛的是**已经有了的那份数据**，不发新请求。
     *
     *  ID 检索（20260926 用户点名）：行上一直显示着 `ID: N`，但检索框只认用户名 ——
     *  拿着一个 ID 来查（工单/日志里通常只有 ID）就永远查不到。判据是**子串**，
     *  与用户名的匹配方式一致：输入 `2` 会同时命中 `ID 2`、`ID 12`、用户名含 2 的行，
     *  与"按用户名子串查"的现有手感一样（不搞"纯数字就精确匹配 ID"那套两套语义：
     *  用户名本身也可能全是数字）。 */
    const filteredUsers = useMemo(() => {
        const f = ACC_FILTERS.find((x) => x.key === accFilter) ?? ACC_FILTERS[0]
        const q = accQuery.trim().toLowerCase()
        return tempUsers.filter((u) => f.match(u)
            && (q === ''
                || String(u.username ?? '').toLowerCase().includes(q)
                || String(u.id ?? '').includes(q)))
    }, [tempUsers, accFilter, accQuery])

    const handleCreateTempUser = async () => {
        if (!tempUsername || !tempPassword) { message.warning('请输入用户名和密码'); return }
        try {
            const res = await http.post('/api/temp-users',
                { username: tempUsername, password: tempPassword })
            if (res.data?.code === 200) {
                message.success('创建成功')
                setTempUsername('')
                setTempPassword('')
                invalidateTempUsers()
            } else {
                message.error(res.data?.message)
            }
        } catch { message.error('请求失败') }
    }

    /** 删除账号（20261001 加二次确认）。
     *
     *  背景：这是全页**唯一一个点一下就下手的危险操作**（其它五个写入口都有受控
     *  Modal），而它偏偏是最不可逆的那个——后端是硬删：`user` 行连同
     *  `chat_history`/`chat_summary`/`conversation` 三张会话表一起清，没有软删、
     *  没有回收站、没有回滚入口（用户正是在这里误删了几个账号）。
     *
     *  所以确认框的正文必须把**不可恢复**和**连带清掉什么**写在明处——只说
     *  "确定要删除吗"是把一个不可逆操作说成了可逆操作。按钮写动作词「删除」、
     *  极性 danger，与同页冻结那一侧同一套纪律（受控 Modal：命令式弹窗沙箱测不到）。
     */
    const [delTarget, setDelTarget] = useState<any>(null)
    const askDeleteTempUser = (user: any) => setDelTarget(user)
    const confirmDeleteTempUser = async () => {
        const t = delTarget
        setDelTarget(null)      // 先关窗再发请求（同 confirmSetStatus）
        if (t) await handleDeleteTempUser(t.id)
    }

    const handleDeleteTempUser = async (id: number) => {
        try {
            const res = await http.delete('/api/temp-users/' + id)
            if (res.data?.code === 200) {
                // 人话在 `data` 里不在 `message` 里（`ApiResponse::success` 的 `message`
                // 恒为 "ok"）——同页其它四个写入口都读这个字段，这一处此前是唯一一个
                // 写死字面量「已删除」的。读错字段不会报错、不会红，只会弹一个空条，
                // 所以这里跟着同一条纪律走，别让第六个入口再各写各的。
                message.success(res.data.data || '已删除')
                invalidateTempUsers()
            }
            else { message.error(res.data?.message) }
        } catch { message.error('请求失败') }
    }

    /** 冻结 / 解冻（20260926）。**要点确认，且确认按钮上写的是这一下的动作词**
     *  （用户点名：「冻结解冻弹窗，把 OK 换成对应具体事务」）。
     *
     *  两件事分开看：
     *  ① *要不要*确认——它虽然可逆，但**代价不对称**：冻结会让对方正在进行的
     *     会话当场断掉（不只是"下次登不进来"），而"解冻"并不能把那一刻还回去。
     *     所以真正的代价发生在**点下去的那一下**，而不是它可不可逆。
     *  ② *按钮上写什么*——`确定`/`OK` 在这个弹窗里是零信息量的：同一排按钮里
     *     既有冻结又有解冻，用户看的是自己那一行的按钮，弹窗上再出现一个"确定"，
     *     他就得回头读一遍标题才知道自己刚才点的是哪个方向。按钮上直接写
     *     「冻结」/「解冻」，弹窗自己就把动作说清楚了。
     *
     *  传**目标状态**而不是"切换一下"（下面 body 里那行 `{frozen}` 也是这个理由）：
     *  服务端不猜意图，重试/双击都安全。 */
    const handleSetStatus = async (user: any, frozen: boolean) => {
        try {
            // 传**目标状态**而不是"切换一下"：服务端不猜意图，重试/双击都安全
            const res = await http.post('/api/temp-users/' + user.id + '/status', { frozen })
            if (res.data?.code === 200) {
                // 人类可读的那句在 **`data`** 里，不在 `message` 里：`ApiResponse::success`
                // 的 `message` 恒为字面量 `"ok"`（见 src/utils.rs），后端把「账号已冻结，
                // 其登录状态已全部失效」放在 `data`。照 `message` 显示出来的就是那个
                // 只有一个「ok」的弹窗条（用户 20260926 报的现场）。
                message.success(res.data.data || '操作完成')
                invalidateTempUsers()
            }
            else { message.error(res.data?.message) }
        } catch { message.error('请求失败') }
    }

    /** 冻结/解冻的确认弹窗。`statusNext` = 点确定之后那一行的目标状态：
     *  true 冻结 / false 解冻。用**目标状态**而不是 `isFrozen(statusTarget)` 现算——
     *  弹窗开着的这段时间里列表可能被重新拉过（看板娘刚改过 / 切回可见 / 20 秒轮询，
     *  见下面 `useLiveRefresh` 那段），现算会让"我点的是冻结、确定下去却解冻了"。 */
    const [statusTarget, setStatusTarget] = useState<any>(null)
    const [statusNext, setStatusNext] = useState(false)
    const askSetStatus = (user: any, frozen: boolean) => {
        setStatusTarget(user)
        setStatusNext(frozen)
    }
    const confirmSetStatus = async () => {
        const t = statusTarget
        const frozen = statusNext
        setStatusTarget(null)   // 先关窗再发请求：失败走 message 提示，不留一个"卡住的确认框"
        if (t) await handleSetStatus(t, frozen)
    }

    /** 禁言 / 解除禁言（20261002 内容风控）。**与冻结是两件事**，这一页上必须分得清：
     *  冻结改的是 `user.status`（踢下线、作废令牌），禁言改的是 `user.muted_until`——
     *  **不碰登录、不碰令牌**，对方照样能登录、能读文章、能跟泠月喵对话，只是发不出
     *  评论与留言。所以：①这个按钮**不写 danger**（红按钮在这一页的含义是"把人赶走"）；
     *  ②下面那个弹窗的正文**一个字都不提"下线/失效"**（提了就是假话——`temp_user.rs`
     *  里为此专门写了 `mute_change_body` 而不复用 `account_change_body`，同一件事在
     *  通知正文与这里各说一遍就是两份真相，所以这里的措辞与它对齐）。
     *
     *  `hours` 只在**禁言方向**有意义：`1/24/168` 小时，或 `0` = 永久（后端 `SetMuteReq`
     *  认 `null` / `<= 0` 为永久）。解禁方向不带它——"解禁要多久"不是一个问题。
     *  与冻结同一条纪律：传**目标状态**而不是"切换一下"，重试/双击都安全。 */
    const handleSetMute = async (user: any, muted: boolean, hours: number) => {
        try {
            const res = await http.post('/api/temp-users/' + user.id + '/mute',
                { muted, hours: muted ? hours : null })
            if (res.data?.code === 200) {
                // 人话在 **`data`** 里、不在 `message` 里——同 `handleSetStatus` 那条注
                // （`ApiResponse::success` 的 `message` 恒为字面量 `"ok"`）。
                message.success(res.data.data || '操作完成')
                invalidateTempUsers()
            }
            else { message.error(res.data?.message) }
        } catch { message.error('请求失败') }
    }

    /** 禁言确认弹窗。`muteTarget` + `muteHours` 都是**开窗那一刻的快照**——同
     *  `statusTarget`/`statusNext` 那条注：窗口开着的这段时间列表可能被重拉，
     *  现算会让"我选的 24 小时、确定下去变成永久了"。 */
    const [muteTarget, setMuteTarget] = useState<any>(null)
    const [muteHours, setMuteHours] = useState(24)
    const askSetMute = (user: any) => {
        setMuteTarget(user)
        setMuteHours(24)    // 每次开窗回到默认档，不沿用上一次的选择
    }
    const confirmSetMute = async () => {
        const t = muteTarget
        const hours = muteHours
        setMuteTarget(null)
        if (t) await handleSetMute(t, true, hours)
    }
    /** 解禁确认：**单独一个窗口**，不与禁言共用一个（禁言要选时长、解禁没有这一维，
     *  硬塞进同一个弹窗就得让半个窗口在两种方向下长得不一样）。 */
    const [unmuteTarget, setUnmuteTarget] = useState<any>(null)
    const confirmUnmute = async () => {
        const t = unmuteTarget
        setUnmuteTarget(null)
        if (t) await handleSetMute(t, false, 0)
    }

    /** 我自己的角色（20260926）。**只用于界面分流**——这一页此前刻意不读令牌
     *  （权限判据全在后端），这次为了"哪个按钮该不该亮"破例：管理员之间不能互相
     *  冻结、只有超管能改身份，这两个判据后端都有一份，这里的副本只是别让人白点
     *  一下再吃一句拒绝。
     *
     *  读的是**本地令牌里的快照**，所以它可能是旧的（刚被降级/刚被提权，令牌还没
     *  换）——按钮亮着但后端拒绝，是这一处的正常失败模式，界面不会因此做出任何
     *  "假装成功"的事（那要等接口回话）。 */
    const myRole = useMemo(() => getRoleFromToken(getToken()), [])
    /** 我自己的 uid：判"这一行是我自己"（后端不许冻自己），同一次解析里一起取。 */
    const myUid = useMemo(() => getUidFromToken(getToken()), [])

    /** 变更身份（20260926）：受控 Modal 二次确认，同页其它确认框一套纪律。 */
    const [roleTarget, setRoleTarget] = useState<any>(null)
    const [roleNext, setRoleNext] = useState('')
    const askSetRole = (user: any, role: string) => {
        setRoleTarget(user)
        setRoleNext(role)
    }
    /* 变更身份的**授权面**（20261002 下放给管理员）——这里的副本只是"按钮该不该出现"，
       真正的判据在 Rust 侧 `authz::check_role_change`，两边口径必须一致：
         · 超管：除超管外的四档随便搬（`ASSIGNABLE_ROLES` 全体）；
         · 管理员：只在**普通用户 / 杂鱼**这两档之间搬（`authz::is_admin_tier`）。
       「目标不在我管的范围里」这一支**不渲染入口**（不是禁用、更不是点了才被拒）——
       与「非普通账号不给删除按钮」同一条纪律：没有这个能力的人不必看见这颗按钮。
       代价是同一页上不同角色看到的行不一样，这正是它该有的样子。 */
    const roleMenuRoles = myRole === 'superadmin'
        ? ASSIGNABLE_ROLES
        : ASSIGNABLE_ROLES.filter((r) => ADMIN_ROLE_TIERS.includes(r.role))
    const canChangeRoleOf = (role?: string | null) =>
        myRole === 'superadmin' || (myRole === 'admin' && ADMIN_ROLE_TIERS.includes(role || ''))
    const confirmSetRole = async () => {
        const t = roleTarget
        const r = roleNext
        setRoleTarget(null)     // 先关窗再发请求（同 confirmSetStatus）
        if (!t || !r) return
        try {
            const res = await http.post('/api/temp-users/' + t.id + '/role', { role: r })
            if (res.data?.code === 200) {
                // 人话在 `data` 里不在 `message` 里（`success` 的 message 恒为 "ok"，
                // 见 src/utils.rs）——同一个坑这一页已经踩过一次，别再踩第二次
                message.success(res.data.data || '操作完成')
                invalidateTempUsers()
            } else { message.error(res.data?.message) }
        } catch { message.error('请求失败') }
    }

    /** 发通知（20260926）：给**单个**账号发一条站内通知。
     *
     *  这是账号管理页第三个写入口（前两个是改密码、冻结）。三处与前两个不同的地方：
     *  · **发出去收不回**——`user_notification` 今天没有删除语义，对方在个人中心
     *    看得到、抹不掉。所以正文用 `<Input.TextArea>`（多行、看得全）而不是单行框，
     *    并且**空正文时不让点发送**（发一条没有内容的通知只是给对方添个红点）；
     *  · 标题可留空（后端有默认标题），正文必填——必填这条同时写在这里与后端，
     *    前端拦是"别让人白填一次"，后端拦才是判据；
     *  · 成功文案同样在 **`data`** 里（`ApiResponse::success` 的 `message` 恒为
     *    字面量 `"ok"`，见 src/utils.rs）——本页已经踩过一次这个坑（冻结那批）。
     *
     *  收件人**只能是列表里的账号**：后端用与 `list_temp_users` 逐字同一条判据
     *  （`authz::is_listable_role`）挡超管，所以这一页不需要再分一次流。 */
    const [notifyTarget, setNotifyTarget] = useState<any>(null)
    const [notifyTitle, setNotifyTitle] = useState('')
    const [notifyContent, setNotifyContent] = useState('')

    const openNotifyModal = (user: any) => {
        setNotifyTarget(user)
        setNotifyTitle('')
        setNotifyContent('')
    }

    const handleSendNotice = async () => {
        const t = notifyTarget
        const content = notifyContent.trim()
        if (!t) return
        if (!content) { message.warning('请输入通知内容'); return }
        // 先关窗再发请求（同 confirmSetStatus / confirmSetRole）：失败走 message
        // 提示，不留一个"卡住的确认框"
        setNotifyTarget(null)
        try {
            // 标题留空时**原样传空串**，由后端取默认标题——不在前端另写一份默认值
            // （"系统自己写的字"该只有一处来源，否则两边迟早不一样）
            const res = await http.post('/api/temp-users/' + t.id + '/notice',
                { title: notifyTitle.trim(), content })
            if (res.data?.code === 200) message.success(res.data.data || '已发送')
            else message.error(res.data?.message)
        } catch { message.error('请求失败') }
    }

    /** 主动重置某个账号的对话额度（20260929）。与"批准申请"是两件事：**这里不需要对方
     *  申请过**（见 routes/quota.rs 头注那一节），所以它是账号行上的第四个动作，
     *  而不是额度管理页签里的一个按钮。
     *
     *  三条纪律与冻结/发通知逐条同形：受控 Modal（命令式弹窗沙箱测不到）、成功文案读
     *  **`data`** 而不是 `message`（`ApiResponse::success` 的 message 恒为字面量 "ok"，
     *  见 src/utils.rs——本页踩过一次）、先关窗再发请求。
     *  这一处的请求**没有请求体**（handler 只有 State + Path 两个提取器，同
     *  `/password-reset-token`）——别顺手补个 `{}`。 */
    const [quotaTarget, setQuotaTarget] = useState<any>(null)
    const confirmResetQuota = async () => {
        const t = quotaTarget
        setQuotaTarget(null)
        if (!t) return
        try {
            const res = await http.post('/api/temp-users/' + t.id + '/quota-reset')
            if (res.data?.code === 200) {
                message.success(res.data.data || '操作完成')
                invalidateTempUsers()
            } else { message.error(res.data?.message) }
        } catch { message.error('请求失败') }
    }

    const openPwModal = (user: any) => {
        setPwTarget(user)
        setPwNewPassword('')
        setPwModalOpen(true)
    }

    const handleChangePassword = async () => {
        if (!pwNewPassword || pwNewPassword.length < 3) { message.warning('密码至少3位'); return }
        try {
            const res = await http.post('/api/temp-users/' + pwTarget.id + '/password',
                { password: pwNewPassword })
            if (res.data?.code === 200) { message.success('密码已修改'); setPwModalOpen(false) }
            else { message.error(res.data?.message) }
        } catch { message.error('请求失败') }
    }

    const handleCreateRecoveryCode = async (user: any) => {
        try {
            // 这个接口**没有请求体**（恢复码由后端生成，handler 只有 State + Path
            // 两个提取器，没有 Json）——所以 post 的第二参省略，别顺手补个 `{}`。
            const res = await http.post('/api/temp-users/' + user.id + '/password-reset-token')
            if (res.data?.code === 200) {
                setRecoveryTarget(user)
                setRecoveryCode(res.data.data)
                setRecoveryModalOpen(true)
            } else {
                message.error(res.data?.message || '恢复码生成失败')
            }
        } catch { message.error('请求失败') }
    }

    /* 跨端同步（20260926；20261002 改接缓存 store）：看板娘收尾事件 / 切回可见 /
       20 秒轮询，任一发生就叫醒 `./tempUsers.ts` 去刷一次。**轮询不拥有数据**——它只可能用
       更新的服务端真相替换缓存，不存在"把缓存冲掉"（数据只有 store 里那一份）。
       七个写入口的弹窗开着时**一律不拉**（`skip`）：冻结/解冻、变更身份、发通知、改密码、
       恢复码、禁言、解禁。理由都是同一句——**绝不覆盖主人正在编辑或正在确认的东西**：冻结那个弹窗存的
       是一份**目标状态快照**（见 `statusTarget` 的注释），底下列表在它开着的时候换掉，主人
       点下去的那一下就跟自己看到的那一行对不上了。
       注意 skip 只挡这一路的**轮询**：写操作成功后的 `invalidateTempUsers()` 不受它影响
       （那是主人自己刚做完的动作，界面必须马上反映），而此刻弹窗早已先关掉（五处都是
       "先关窗再发请求"）。
       `tab !== 'accounts'`（留言/评论/额度页签）也跳过：那几半的同步由各自的页面负责，
       在别人的页签上偷偷轮询这份账号列表是白花流量；`useTempUsers(false)` 那一侧也会让
       消费计数归零，于是连事件触发的拉取都一并停掉。 */
    useLiveRefresh(() => refreshTempUsers(), {
        skip: () => tab !== 'accounts'
            || !!statusTarget || !!roleTarget || !!notifyTarget || !!quotaTarget
            || !!muteTarget || !!unmuteTarget
            || pwModalOpen || recoveryModalOpen,
    });

    const items: TabsProps['items'] = [
        {
            key: 'accounts',
            label: <h3>账号管理</h3>,
            children: (
                <>
                    {/* 三段式（20260926）：上面这一截（新建 + 说明 + 筛选检索）固定，
                        只有下面的 .tu-list-wrap 在窗口内滚——原来整块 .tu-section
                        自己 overflow-y: auto，翻到第 30 个账号想换个关键词得先滚回顶上。 */}
                    <div className="tu-section">
                        <div className="tu-head">
                            <div className="tu-create">
                                {/* autoComplete 的两个取值是刻意的（20260926）：
                                    密码框用 new-password —— Chrome 的密码管理器对**判定为
                                    凭据**的字段忽略 `off`，`off` 只对非凭据字段有效；要退出
                                    凭据判定就得给具体 token。用户名框按规范只能是 username/off。
                                    ⚠️ 但真正让这两个框被回填的**不是这里缺属性**，而是页面里
                                    曾常驻一个密码框（见下面「修改密码」弹窗的注释）——属性只是
                                    把"这是个新建账号的表单"说清楚。 */}
                                <Input
                                    name="new-account-name"
                                    autoComplete="off"
                                    placeholder="用户名"
                                    value={tempUsername}
                                    onChange={e => setTempUsername(e.target.value)}
                                    style={{ flex: 1 }}
                                />
                                <Input.Password
                                    name="new-account-password"
                                    autoComplete="new-password"
                                    placeholder="密码"
                                    value={tempPassword}
                                    onChange={e => setTempPassword(e.target.value)}
                                    style={{ flex: 1 }}
                                />
                                <Button type="primary" onClick={handleCreateTempUser}>新建临时用户</Button>
                            </div>
                            <p className="tu-hint">
                                临时用户可登录前台发布说说、放河灯留言（供家人/访客开账号用）
                            </p>
                            <div className="tu-filter">
                                <div className="tu-tabs" role="tablist">
                                    {ACC_FILTERS.map((f) => (
                                        <button
                                            key={f.key}
                                            type="button"
                                            className={accFilter === f.key ? 'sel' : ''}
                                            onClick={() => setAccFilter(f.key)}
                                        >
                                            {f.label}
                                        </button>
                                    ))}
                                </div>
                                <Input.Search
                                    placeholder="检索用户名 / ID…"
                                    allowClear
                                    onChange={e => setAccQuery(e.target.value)}
                                    style={{ width: 240 }}
                                />
                                {/* 手动刷新走 `invalidateTempUsers` 而不是 `refreshTempUsers`：
                                    后者与在途请求去重，主人点了按钮却"什么都没发生"（那次请求
                                    恰好还在路上）；前者先作废在途读数再发一次新的，点了必有一次
                                    真请求。 */}
                                <Button
                                    icon={<ReloadOutlined />}
                                    onClick={() => invalidateTempUsers()}
                                >
                                    刷新
                                </Button>
                                {/* 计数也要跟着三态走：缓存没到手时写「共 0 个账号」是与上面
                                    空态同一族的谎（"读不到"讲成"没有"），而这一处更醒目——
                                    它就挂在筛选栏右边，扫一眼就是结论。 */}
                                <span className="tu-count">
                                    {cachedUsers === null ? '正在读取账号…' : `共 ${filteredUsers.length} 个账号`}
                                </span>
                            </div>
                        </div>
                        <div className="tu-list-wrap">
                            {filteredUsers.length === 0 ? (
                                <div className="tu-empty">
                                    {/* 空态**三分**（20261002）：缓存没到手 = 还在读或读失败，
                                        缓存到手但列表空 = 账号真的是 0 个。前两种绝不能说成
                                        「暂无账号」——那是把"读不到"讲成"没有"（本仓的老谎，
                                        而且账号列表空一屏恰好是那种会让人以为"账号都没了"的
                                        时刻）。第三态里再分"筛掉了"与"真的没有"。 */}
                                    {cachedUsers === null ? (
                                        usersFailed
                                            ? <>读取失败 <Button type="link" size="small" onClick={() => invalidateTempUsers()}>点此重试</Button></>
                                            : '正在读取…'
                                    ) : (
                                        tempUsers.length === 0 ? '暂无账号' : '没有匹配的账号'
                                    )}
                                </div>
                            ) : (
                                <div className="tu-list">
                                    {filteredUsers.map((u: any) => {
                                      /** 这一行的冻结按钮该不该亮。两种情况下后端会拒，
                                       *  这里说到做到（**只决定按钮亮不亮**，真正的闸在
                                       *  服务端 `authz::check_freeze`）：
                                       *  · 目标就是我自己（uid 从令牌的 `sub` 里读，不用
                                       *    再拉一次 /profile）——冻了自己就再也解不开了；
                                       *  · 我是管理员、对方也是管理员（同级）——但**超管
                                       *    不受这条限制**（超管冻管理员是放行的），所以
                                       *    判据必须是"我是 admin"而不是"对方是 admin"。
                                       *  文案与后端那两句是同一句话（见
                                       *  `routes/temp_user.rs::freeze_denial_message`）：
                                       *  同一件事不该在界面上和在接口里说成两句。 */
                                      const freezeBlocked =
                                          (myUid !== null && u.id === myUid) ? '不能冻结自己的账号'
                                              : (myRole === 'admin' && u.role === 'admin')
                                                  ? '管理员之间不可互相冻结' : ''
                                      // 额度那一截（文案 + 档位）。与另外三处同源，见 `quotaChip`。
                                      const qc = quotaChip(u)
                                      // 冻结/解冻：一个按钮、两种含义，按当前状态取反。
                                      // danger 只给"冻结"那一侧——红按钮按下去会让对方下线，
                                      // "解冻"是恢复性操作，用红的不合适。
                                      const freezeBtn = (
                                          <Button
                                              size="small"
                                              className="tu-freeze-btn"
                                              danger={!isFrozen(u)}
                                              disabled={!!freezeBlocked}
                                              onClick={() => askSetStatus(u, !isFrozen(u))}
                                          >
                                              {isFrozen(u) ? '解冻' : '冻结'}
                                          </Button>
                                      )
                                      /** 这一行的禁言按钮该不该亮。条件与冻结**逐字相同**
                                       *  （后端 `authz::check_mute` 与 `check_freeze` 共用一张
                                       *  规则表，只有动词不同），所以两个 `Blocked` 只看动作词
                                       *  是否一致一眼就能核对——**这不是重复，是同一张规则表
                                       *  在两处的投影**；真出分歧的地方是后端那一处。
                                       *  ⚠️ 两句文案是跨语言契约，与 `routes/temp_user.rs::
                                       *  mute_denial_message` 逐字同源，agent 转述的就是它们。 */
                                      const muteBlocked =
                                          (myUid !== null && u.id === myUid) ? '不能禁言自己的账号'
                                              : (myRole === 'admin' && u.role === 'admin')
                                                  ? '管理员之间不可互相禁言' : ''
                                      const muted = isMuted(u)
                                      /** 禁言/解禁：一个按钮两种含义，按当前状态取反。
                                       *  **两侧都不给 danger**——禁言不踢人下线，红按钮留给冻结。 */
                                      const muteBtn = (
                                          <Button
                                              size="small"
                                              className="tu-mute-btn"
                                              disabled={!!muteBlocked}
                                              onClick={() => (muted ? setUnmuteTarget(u) : askSetMute(u))}
                                          >
                                              {muted ? '解除禁言' : '禁言'}
                                          </Button>
                                      )
                                      return (
                                        <div key={u.id} className="tu-row">
                                            <div>
                                                <strong className={isFrozen(u) ? 'tu-frozen-name' : ''}>{u.username}</strong>
                                                {/* 身份徽章（20261002 换掉 antd 的具名色 Tag）：
                                                    图形 + 形状 + 配色三样一起区分五档，见 RoleBadge 头注。
                                                    「普通用户不显示」这条规则不变——后台行上满屏都是普通用户，
                                                    这一枚只用来**标出例外**。 */}
                                                {u.role !== 'user' && (
                                                    <RoleBadge role={u.role} size={22} style={{ marginLeft: 8 }} />
                                                )}
                                                {/* 冻结状态**显示成标签**而不是只靠按钮文案：
                                                    冻结账号筛选视图里也是这一行，得一眼看出为什么它在这儿 */}
                                                {isFrozen(u) && (
                                                    <Tag color="red" style={{ marginLeft: 8 }}>已冻结</Tag>
                                                )}
                                                {/* 禁言状态（20261002）：与「已冻结」并列但**各说各的**
                                                    ——冻结标签说的是"登录态没了"，这一枚说的是"发言被
                                                    关了"，两枚同时出现**不是矛盾**（一个被冻结又恰在禁言
                                                    期内的账号是真的存在）。到期时刻写在标签里：只有
                                                    "已禁言"三个字的话，管理员没法回答"关到什么时候"，
                                                    而这正是他下一步要判断的东西（该不该解禁）。 */}
                                                {muted && (
                                                    <Tag color="orange" style={{ marginLeft: 8 }}>
                                                        已禁言{u.mutedUntil ? ` · ${muteUntilText(u.mutedUntil)}` : ''}
                                                    </Tag>
                                                )}
                                                <span className="tu-id">ID: {u.id}</span>
                                                {/* 额度（20260929）：正常用户终身 500 轮、管理员不限额。
                                                    数字**从行上读**（后端 quota::limit_of 已算好），
                                                    前端不许把 500 写死——上限由 env 决定。
                                                    20260929b：余额口径 + 档位色（见 `quotaChip` 那段注）。 */}
                                                <span className={`tu-quota${qc.level ? ` is-${qc.level}` : ''}`}>
                                                    {qc.text}
                                                </span>
                                            </div>
                                            <div style={{ display: 'flex', gap: 8 }}>
                                                <Button size="small" onClick={() => openPwModal(u)}>修改密码</Button>
                                                <Button size="small" onClick={() => handleCreateRecoveryCode(u)}>生成恢复码</Button>
                                                {/* 发通知（20260926）：对**单个**账号发一条站内通知，
                                                    与"公告"（粉丝/全体可见）是两件事——所以它在这一行上，
                                                    而不是页面顶部一个"发公告"按钮。 */}
                                                <Button size="small" className="tu-notify-btn"
                                                        onClick={() => openNotifyModal(u)}>发通知</Button>
                                                {/* 重置额度（20260929）：账号族第四个动作。
                                                    **不限额的行禁用**（`chatQuotaLimit === 0`，
                                                    管理员档）：后端会拒（「该账号不限额，无需重置额度」），
                                                    但让按钮干脆不亮，比点了才被告知更清楚——与
                                                    「非普通账号不给删除按钮」同一条纪律。 */}
                                                <Button size="small" className="tu-quota-btn"
                                                        disabled={u.chatQuotaLimit === 0}
                                                        onClick={() => setQuotaTarget(u)}>重置额度</Button>
                                                {freezeBlocked
                                                    ? <Tooltip title={freezeBlocked}>{freezeBtn}</Tooltip>
                                                    : freezeBtn}
                                                {/* 禁言（20261002）：与冻结并列的第二道"限制这个账号"的动作。
                                                    被挡住时同样用 Tooltip 说明原因——与冻结那不是"顺手也加一个"，
                                                    而是同一张规则表在这里的同一处投影（见 `muteBlocked` 的注）。 */}
                                                {muteBlocked
                                                    ? <Tooltip title={muteBlocked}>{muteBtn}</Tooltip>
                                                    : muteBtn}
                                                {/* 变更身份（20260926；**20261002 下放给管理员**）：
                                                    入口可见性 = `canChangeRoleOf`（超管全档、管理员只
                                                    低两档），**看不见的档位连入口都不渲染**——
                                                    不多给一个"把它禁掉"的中间态，禁用按钮会让人
                                                    以为"本可以有"。菜单里**不列当前身份**：一个
                                                    "改成我现在这个"的选项只会带来一次什么都没发生的往返。 */}
                                                {canChangeRoleOf(u.role) && (
                                                    <Dropdown
                                                        trigger={['click']}
                                                        menu={{
                                                            items: roleMenuRoles
                                                                .filter((r) => r.role !== u.role)
                                                                .map((r) => ({ key: r.role, label: ROLE_LABEL[r.role] })),
                                                            onClick: ({ key }) => askSetRole(u, key),
                                                        }}
                                                    >
                                                        <Button size="small" className="tu-role-btn">变更身份</Button>
                                                    </Dropdown>
                                                )}
                                                {/* 非普通账号不给删除按钮：后端也会拒（见 delete_temp_user），
                                                    但让按钮干脆不出现，比点了才被告知不行更清楚 */}
                                                {u.role === 'user' && (
                                                    <Button size="small" className="tu-del-btn" danger onClick={() => askDeleteTempUser(u)}>删除</Button>
                                                )}
                                            </div>
                                        </div>
                                      )
                                    })}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* 重置额度确认（20260929）。三条纪律与冻结那个弹窗逐条同形：
                        · `okText` 写动作词（「重置额度」）而不是「确定」——**与行上那颗
                          按钮同名**（同一件事两个名字比"确定"更难读）；
                        · 受控 Modal（命令式弹窗沙箱测不到）；
                        · **不给 danger** —— 把额度还给他属于恢复性动作
                          （与"解冻"同一侧），红按钮会是错的信息。
                        正文写清两件事：他立刻能继续问；以及**界面上撤不回来**
                        （没有"改回原值"这个入口，下一次重置只会再恢复一次）。
                        **正文说的是「恢复到上限」而不是「清零」**（20260929 用户指出）：
                        主人看到的那个数是**递减的余额**，"计数器清零"是库里的实现、不是
                        他看到的东西。同一说法在个人中心、通知、agent 侧一并统一
                        （跨语言契约）。 */}
                    <Modal
                        title={'重置额度 - ' + (quotaTarget?.username || '')}
                        open={!!quotaTarget}
                        onOk={confirmResetQuota}
                        onCancel={() => setQuotaTarget(null)}
                        okText="重置额度"
                        cancelText="取消"
                        okButtonProps={{ className: 'tu-quota-ok' }}
                        width={420}
                    >
                        <div style={{ marginTop: 12, lineHeight: 1.7 }}>
                            <div>
                                确定要把<strong>{quotaTarget?.username}</strong> 的对话额度恢复到上限吗？
                            </div>
                            <div style={{ marginTop: 8, color: 'var(--washi-ink-2, #7c6584)' }}>
                                恢复后：他的额度立刻回到满额、可以继续对话，并会收到一条站内通知。
                                这一下在界面上撤不回来——原值不会被记下来，唯一能再变的是下一次重置。
                            </div>
                        </div>
                    </Modal>

                    {/* 删除账号确认（20261001）。与冻结那个弹窗同三条纪律：按钮写动作词
                        （「删除」而不是「确定」）、danger 极性、受控 Modal。

                        正文不能只说"确定要删除吗"——那样读起来像件可逆的小事。这一下
                        真正的后果有两半，都要写出来：① 账号本身没了；② 它在站内的全部
                        会话记录（历史消息、摘要、会话列表）跟着一起清掉。而且**没有
                        回滚入口**：后端是硬删，删完就查不到这个人了（连一条通知都发不
                        到他那儿——收件箱随账号一起没）。 */}
                    <Modal
                        title={'删除账号 - ' + (delTarget?.username || '')}
                        open={!!delTarget}
                        onOk={confirmDeleteTempUser}
                        onCancel={() => setDelTarget(null)}
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true, className: 'tu-del-ok' }}
                        cancelButtonProps={{ className: 'tu-del-cancel' }}
                        width={420}
                    >
                        <div style={{ marginTop: 12, lineHeight: 1.7 }}>
                            <div>
                                确定要删除账号<strong>{delTarget?.username}</strong> 吗？
                            </div>
                            <div style={{ marginTop: 8, color: 'var(--washi-ink-2, #7c6584)' }}>
                                删除后：该账号无法再登录，它在站内的全部对话记录
                                （历史消息、会话摘要、会话列表）会一并清除。
                                <strong>这一步不可恢复</strong>，站内没有回收站，也查不回这个人。
                                只是想让他暂时登不进来，请改用「冻结」。
                            </div>
                        </div>
                    </Modal>

                    {/* 冻结/解冻确认（20260926）。三个细节是刻意的：
                        · `okText` 写动作词（「冻结」/「解冻」）而不是「确定」——
                          同屏既有冻结又有解冻，写"确定"等于让人回头再读一遍标题；
                        · `okButtonProps.danger` 只给冻结那一侧，与行上按钮同一套极性；
                        · 不用 `Modal.confirm`（命令式）：它渲染到另一个容器里，
                          这个仓库的无头沙箱是按 DOM 结构断言的，受控 Modal 才测得到
                          （同页其它确认框也都用受控式）。 */}
                    <Modal
                        title={statusNext ? '冻结账号' : '解冻账号'}
                        open={!!statusTarget}
                        onOk={confirmSetStatus}
                        onCancel={() => setStatusTarget(null)}
                        okText={statusNext ? '冻结' : '解冻'}
                        cancelText="取消"
                        okButtonProps={{ danger: statusNext, className: 'tu-status-ok' }}
                        cancelButtonProps={{ className: 'tu-status-cancel' }}
                        width={420}
                    >
                        <div style={{ marginTop: 12, lineHeight: 1.7 }}>
                            <div>
                                确定要{statusNext ? '冻结' : '解冻'}
                                <strong>{statusTarget?.username}</strong> 吗？
                            </div>
                            <div style={{ marginTop: 8, color: 'var(--washi-ink-2, #7c6584)' }}>
                                {statusNext
                                    ? '冻结后：该账号无法再登录，已登录的网页会话立即失效；解冻后需要重新登录，冻结前的登录状态不会恢复。'
                                    : '解冻后：该账号可以重新登录；它冻结前的登录状态不会恢复。'}
                            </div>
                        </div>
                    </Modal>

                    {/* 禁言确认（20261002 内容风控）。与冻结那个弹窗同三条纪律（按钮写动作词、
                        受控 Modal、正文说清后果），但正文说的是**另一件事**：
                        · 这里**一个字都不提"下线/失效"**——禁言不碰登录态，提了就是假话，
                          而这一页的使用者会照着弹窗正文去预判对方的体验（`temp_user.rs::mute_change_body`
                          为同一件事专门写了一份正文，两处说同一件事实，所以措辞要对齐）；
                        · 后果写**两段**：被拒的是什么（发布评论与留言），不受影响的是什么
                          （登录、浏览、对话）——只说前一半会让人以为禁言等于封号；
                        · 时长选择放在正文里（Radio 一行四档），默认 24 小时：最常见的处置是
                          "先关一天看看"，而**最不该成为默认的是永久**。 */}
                    <Modal
                        title={'禁言账号 - ' + (muteTarget?.username || '')}
                        open={!!muteTarget}
                        onOk={confirmSetMute}
                        onCancel={() => setMuteTarget(null)}
                        okText="禁言"
                        cancelText="取消"
                        okButtonProps={{ className: 'tu-mute-ok' }}
                        cancelButtonProps={{ className: 'tu-mute-cancel' }}
                        width={440}
                    >
                        <div style={{ marginTop: 12, lineHeight: 1.7 }}>
                            <div>
                                确定要禁言 <strong>{muteTarget?.username}</strong> 吗？
                            </div>
                            <div style={{ marginTop: 8 }}>
                                <Radio.Group
                                    className="tu-mute-duration"
                                    value={muteHours}
                                    onChange={(e) => setMuteHours(e.target.value)}
                                >
                                    {MUTE_DURATIONS.map((d) => (
                                        <Radio key={d.hours} value={d.hours}>{d.label}</Radio>
                                    ))}
                                </Radio.Group>
                            </div>
                            <div style={{ marginTop: 8, color: 'var(--washi-ink-2, #7c6584)' }}>
                                禁言期间：该账号不能发布文章评论与留言，这两处提交会被直接拒绝。
                                其余一切照常——仍可登录、浏览文章、与泠月喵对话，点赞也不受影响。
                            </div>
                        </div>
                    </Modal>

                    {/* 解禁确认。**单开一个窗口**而不是与禁言共用：解禁没有"多久"这一维，
                        塞进同一个弹窗会得到一个在两方向下长得不一样的窗口。 */}
                    <Modal
                        title={'解除禁言 - ' + (unmuteTarget?.username || '')}
                        open={!!unmuteTarget}
                        onOk={confirmUnmute}
                        onCancel={() => setUnmuteTarget(null)}
                        okText="解除禁言"
                        cancelText="取消"
                        okButtonProps={{ className: 'tu-unmute-ok' }}
                        cancelButtonProps={{ className: 'tu-unmute-cancel' }}
                        width={420}
                    >
                        <div style={{ marginTop: 12, lineHeight: 1.7 }}>
                            <div>
                                确定要解除 <strong>{unmuteTarget?.username}</strong> 的禁言吗？
                            </div>
                            <div style={{ marginTop: 8, color: 'var(--washi-ink-2, #7c6584)' }}>
                                解禁后该账号可以立即发布评论与留言。这与冻结无关：期间它的登录
                                状态一直有效，不受本次操作影响。
                            </div>
                        </div>
                    </Modal>

                    {/* 变更身份确认（20260926）。与冻结那个弹窗同三条纪律：
                        按钮写动作词（「改成秘书」而不是「确定」）、danger 跟着方向走、
                        受控 Modal（命令式弹窗沙箱测不到）。正文写**两件事**：改完之后
                        他还能干什么（新身份），以及**他会被踢下线**——后者是这次变更
                        唯一不可逆的那半边（旧令牌代次已作废，换不回旧会话）。 */}
                    <Modal
                        title={'变更身份 - ' + (roleTarget?.username || '')}
                        open={!!roleTarget}
                        onOk={confirmSetRole}
                        onCancel={() => setRoleTarget(null)}
                        okText={'改成' + (ROLE_LABEL[roleNext] || roleNext)}
                        cancelText="取消"
                        okButtonProps={{
                            danger: roleRank(roleNext) < roleRank(roleTarget?.role),
                            className: 'tu-role-ok',
                        }}
                        cancelButtonProps={{ className: 'tu-role-cancel' }}
                        width={420}
                    >
                        <div style={{ marginTop: 12, lineHeight: 1.7 }}>
                            <div>
                                把 <strong>{roleTarget?.username}</strong> 的身份从
                                「{roleLabel(roleTarget?.role)}」改为
                                「{ROLE_LABEL[roleNext] || roleNext}」
                            </div>
                            <div style={{ marginTop: 8, color: 'var(--washi-ink-2, #7c6584)' }}>
                                {roleRank(roleNext) < roleRank(roleTarget?.role)
                                    ? '这是收窄权限：改完他就没有现在这些能力了。'
                                    : '这是放宽权限：改完他能做的事比现在多。'}
                                该账号的登录状态会立即失效，需要重新登录。
                            </div>
                        </div>
                    </Modal>

                    <Modal
                        title={'修改密码 - ' + (pwTarget?.username || '')}
                        open={pwModalOpen}
                        onOk={handleChangePassword}
                        onCancel={() => setPwModalOpen(false)}
                        okText="确认修改"
                        cancelText="取消"
                        // forceRender 是下面那条"关窗摘密码框"能生效的**前提**，不是性能选项：
                        // rc-dialog 的 children 被 MemoChildren 包着，判据是
                        // `shouldUpdate = visible || forceRender`——关窗时 shouldUpdate=false，
                        // 整棵 children 冻结成"最后一次可见时"的快照，`{pwModalOpen && …}` 那一刻
                        // 根本不会被应用。同族修法见 UserCenter（20260924 实测过）。
                        forceRender
                    >
                        <div style={{ marginTop: 16 }}>
                            {/* 关窗即从 DOM 摘掉这个密码框（20260926，用户报"注册账号输入框
                                被浏览器默认填充了"）。根因不在新建表单缺属性，而是这里：
                                Chrome 对判定为凭据的字段忽略 `autocomplete="off"`，而**页面里
                                没有任何 `<form>` 时它会把整页散落的输入框当成一个合成表单**
                                ——于是"页面上常驻一个密码框"就等于"本页是登录页"，它便去回填
                                页面上最裸的那个文本框（这里就是新建账号的用户名/密码框）。
                                本弹窗是常驻挂载的（open 只切显隐），所以这个框会一直留在 DOM 里，
                                只能按开合状态摘挂。关窗时 pwNewPassword 本来就该作废。 */}
                            {pwModalOpen && (
                                <Input.Password
                                    name="change-account-password"
                                    autoComplete="new-password"
                                    placeholder="输入新密码"
                                    value={pwNewPassword}
                                    onChange={e => setPwNewPassword(e.target.value)}
                                />
                            )}
                        </div>
                    </Modal>

                    {/* 发通知（20260926）。四个细节是刻意的：
                        · 主按钮写「发送」而不是「确定」——同页其它确认框一个纪律
                          （「冻结」/「解冻」/「改成管理员」），按钮上是这一下的动作，
                          不必让人回头读标题；
                        · **正文为空时主按钮禁用**（`okButtonProps.disabled`）：后端也会拒
                          （`send_notice` 里那句"通知内容不能为空"），但那要往返一趟；
                          这里是"别让人白填一次"，判据仍在后端；
                        · `forceRender` + `{notifyTarget && …}` 与上面的改密码框同一条纪律：
                          关窗即把这两个输入框从 DOM 摘掉（Chrome 会在**没有 `<form>`**
                          时把整页散落的输入框当成一个合成表单去回填，本页 20260926 已中过一次）；
                        · 正文用 TextArea：发出去收不回，得让人看清自己写了什么。 */}
                    <Modal
                        title={'发通知 - ' + (notifyTarget?.username || '')}
                        open={!!notifyTarget}
                        onOk={handleSendNotice}
                        onCancel={() => setNotifyTarget(null)}
                        okText="发送"
                        cancelText="取消"
                        okButtonProps={{
                            disabled: !notifyContent.trim(),
                            className: 'tu-notify-ok',
                        }}
                        cancelButtonProps={{ className: 'tu-notify-cancel' }}
                        width={520}
                        forceRender
                    >
                        {notifyTarget && (
                            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                                <div style={{ color: 'var(--washi-ink-2, #7c6584)' }}>
                                    这条通知会出现在 <strong>{notifyTarget.username}</strong> 的个人中心，
                                    发出后无法撤回。标题留空则显示为「站内通知」。
                                </div>
                                <Input
                                    className="tu-notify-title"
                                    name="notice-title"
                                    autoComplete="off"
                                    placeholder="标题（可留空）"
                                    maxLength={128}
                                    value={notifyTitle}
                                    onChange={e => setNotifyTitle(e.target.value)}
                                />
                                {/* `counter-room`：给 antd 的 showCount 计数腾 22px。
                                    计数是绝对定位的、**不占布局空间**，而 Modal footer 的
                                    `margin-top` 只有 12px ⇒ 不腾就压在「发送」那颗按钮上
                                    （20260929 用户反馈"字数计数遮挡发送按钮"）。
                                    见 src/index.css 那条规则与它引的 antd 源码事实。 */}
                                <Input.TextArea
                                    className="tu-notify-body counter-room"
                                    name="notice-content"
                                    autoComplete="off"
                                    placeholder="通知内容（必填）"
                                    rows={5}
                                    maxLength={1000}
                                    showCount
                                    value={notifyContent}
                                    onChange={e => setNotifyContent(e.target.value)}
                                />
                            </div>
                        )}
                    </Modal>

                    <Modal
                        title={'一次性恢复码 - ' + (recoveryTarget?.username || '')}
                        open={recoveryModalOpen}
                        footer={null}
                        onCancel={() => setRecoveryModalOpen(false)}
                    >
                        <p>请通过安全渠道把下面恢复码交给用户。恢复码 15 分钟内有效，生成新码会立即使旧码失效。</p>
                        {/* Type=text（不是 Password）：恢复码要能念给对方，且它不是凭据——
                            没必要再往"合成登录表单"里添一个密码框 */}
                        <Input value={recoveryCode} readOnly />
                    </Modal>
                </>
            ),
        },
        {
            // 20261002 更名：这个 Tab 里挂的一直是 `BoardManage`（管河灯留言），
            // 而它从 20260905 起叫「评论管理」——名字与内容对不上。现在评论有自己的
            // 页签（下一个），这一页叫回它本来的名字，**行为零改动**。
            key: 'review',
            label: <h3>留言管理</h3>,
            children: <BoardManage />,
        },
        {
            // 文章评论（20261002）：文章详情页底部讨论区的裁决队列，与留言管理同构。
            // 数据来自 /api/protect/comments（**另一张表**：note_comment，不是 talk）。
            key: 'comment',
            label: <h3>评论管理</h3>,
            children: <CommentManage />,
        },
        {
            // 额度管理（20260929）：放的是**申请队列**（谁申请了、批不批），
            // 与账号管理行上那枚「重置额度」按钮分工明确——按账号的动作住在行上，
            // 按申请的裁决住在这里（与评论管理只管裁决队列同构）。
            key: 'quota',
            label: <h3>额度管理</h3>,
            children: <QuotaManage />,
        },
    ];

    return (
        <div className="users-page">
            <Tabs activeKey={tab} onChange={setTab} items={items} />
        </div>
    );
};

export default Users;

import './index.sass'
import { Button, Dropdown, Input, message, Modal, Tabs, Tag, Tooltip } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { TabsProps } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import BoardManage from '../BoardManage';
// 共享 axios 客户端（20260926）。这一页原来六处都自己 `fetch` + 手拼
// `'Bearer ' + token`，于是**绕过了全局那两件事**：①令牌过期时的 401 处理
// （清 tokenKey + 提示 + 跳 /login，见 src/apis/axios.tsx 的响应拦截器）——
// 手拼的那份只会弹一句"请求失败"，管理员被冻结/令牌失效时看到的是一句无信息的
// 报错而不是登录页；②请求头里 token 的 `Bearer ` 前缀归一（后端 strip_prefix）。
// 同页的评论管理（BoardManage）本来就走共享客户端，两半行为不一致本身就是坑。
import http from "../../../apis/axios.tsx";
import getToken from "../../../apis/getToken.tsx";
import { useLiveRefresh } from "../../../utils/liveRefresh.ts";
import { ROLE_LABEL, roleLabel, roleTagColor, getRoleFromToken, getUidFromToken } from "../../../utils/auth.ts";

/** 用户管理 = 账号管理（临时访客账号）+ 评论管理（河灯留言审核）
 *  20260905 拍板：原 Announcement 内嵌临时用户段迁入「账号管理」；
 *  原独立「留言管理」页并入「评论管理」。设置类（站点信息等）拆独立侧栏入口 UserControl。
 *
 *  `?tab=review` 直接落在评论管理（20260924 三轮）：后台首页待办卡上那行
 *  "N 条评论待人工审核"点过来就该看见那几条，而不是先看见账号列表再自己找 Tab。
 *  只在**进页那一下**当初始值——之后切 Tab 不再回写 URL（这一页没有"当前 Tab 是
 *  哪一页"的可分享语义，URL 也不是它的真源）。
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

/** 可指派的三个身份（20260926）。`superadmin` **不在这一列**，而且不是"忘了加"：
 *  后端的取值域判据是 `authz::is_assignable_role`（已知 且 != superadmin），
 *  多一个超级管理员是一条数据库迁移的决定，不该是界面上点一下的事。
 *
 *  `rank` 只服务于**按钮极性**：变更身份往哪个方向都伴随"对方全部会话失效"，
 *  分不出轻重的一律染红等于没信息——照冻结/解冻那一套（收紧=danger、放开=普通）
 *  取"权限收窄"那一侧。 */
const ASSIGNABLE_ROLES: { role: string; rank: number }[] = [
    { role: 'user', rank: 0 },
    { role: 'secretary', rank: 1 },
    { role: 'admin', rank: 2 },
]
const roleRank = (role?: string | null) =>
    ASSIGNABLE_ROLES.find((r) => r.role === role)?.rank ?? -1

const Users = () => {
    const [searchParams] = useSearchParams()
    const [tab, setTab] = useState(() =>
        searchParams.get('tab') === 'review' ? 'review' : 'accounts')

    // ── 临时用户（账号管理）──
    // 这里原来有一行 `const token = localStorage.getItem('tokenKey')`，六处 fetch
    // 各拼一次 `'Bearer ' + token`。改走共享客户端之后它没有用武之地——令牌由
    // `src/apis/axios.tsx` 的请求拦截器统一加（且顺手归一了 `Bearer ` 前缀）。
    const [tempUsers, setTempUsers] = useState<any[]>([])
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

    const loadTempUsers = async () => {
        try {
            // 这个接口回的是**裸数组**（不是 {code,message,data} 那层壳，见
            // src/routes/temp_user.rs::list_temp_users）——所以判据是 res.data 本身，
            // 别顺手写成 `res.data.data`（那会永远拿到 undefined、列表恒空，
            // 而 axios 不报错、页面不红，看起来只是"没有账号"）。
            const res = await http.get('/api/temp-users')
            if (Array.isArray(res?.data)) setTempUsers(res.data)
        } catch { /* ignore */ }
    }

    useEffect(() => {
        setTimeout(loadTempUsers, 500)
    }, [])

    const handleCreateTempUser = async () => {
        if (!tempUsername || !tempPassword) { message.warning('请输入用户名和密码'); return }
        try {
            const res = await http.post('/api/temp-users',
                { username: tempUsername, password: tempPassword })
            if (res.data?.code === 200) {
                message.success('创建成功')
                setTempUsername('')
                setTempPassword('')
                loadTempUsers()
            } else {
                message.error(res.data?.message)
            }
        } catch { message.error('请求失败') }
    }

    const handleDeleteTempUser = async (id: number) => {
        try {
            const res = await http.delete('/api/temp-users/' + id)
            if (res.data?.code === 200) { message.success('已删除'); loadTempUsers() }
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
                loadTempUsers()
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
                loadTempUsers()
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

    /* 跨端同步（20260926）：账号列表此前只在挂载时拉一次（还刻意延迟 500ms 让首屏先出来）。
       现在接 `utils/liveRefresh.ts`——看板娘收尾事件 / 切回可见 / 20 秒轮询，任一发生就重拉。
       五个写入口的弹窗开着时**一律不拉**（`skip`）：冻结/解冻、变更身份、发通知、改密码、
       恢复码。理由都是同一句——**绝不覆盖主人正在编辑或正在确认的东西**：冻结那个弹窗存的
       是一份**目标状态快照**（见 `statusTarget` 的注释），底下列表在它开着的时候换掉，主人
       点下去的那一下就跟自己看到的那一行对不上了。
       `tab !== 'accounts'`（评论管理页签）也跳过：那一半的同步由它自己的页面负责，
       在别人的页签上偷偷轮询这份账号列表是白花流量。 */
    useLiveRefresh(loadTempUsers, {
        skip: () => tab !== 'accounts'
            || !!statusTarget || !!roleTarget || !!notifyTarget || pwModalOpen || recoveryModalOpen,
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
                                <Button
                                    icon={<ReloadOutlined />}
                                    onClick={() => loadTempUsers()}
                                >
                                    刷新
                                </Button>
                                <span className="tu-count">共 {filteredUsers.length} 个账号</span>
                            </div>
                        </div>
                        <div className="tu-list-wrap">
                            {filteredUsers.length === 0 ? (
                                <div className="tu-empty">
                                    {tempUsers.length === 0 ? '暂无账号' : '没有匹配的账号'}
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
                                      return (
                                        <div key={u.id} className="tu-row">
                                            <div>
                                                <strong className={isFrozen(u) ? 'tu-frozen-name' : ''}>{u.username}</strong>
                                                {u.role !== 'user' && (
                                                    <Tag color={roleTagColor(u.role)} style={{ marginLeft: 8 }}>
                                                        {ROLE_LABEL[u.role] || u.role}
                                                    </Tag>
                                                )}
                                                {/* 冻结状态**显示成标签**而不是只靠按钮文案：
                                                    冻结账号筛选视图里也是这一行，得一眼看出为什么它在这儿 */}
                                                {isFrozen(u) && (
                                                    <Tag color="red" style={{ marginLeft: 8 }}>已冻结</Tag>
                                                )}
                                                <span className="tu-id">ID: {u.id}</span>
                                            </div>
                                            <div style={{ display: 'flex', gap: 8 }}>
                                                <Button size="small" onClick={() => openPwModal(u)}>修改密码</Button>
                                                <Button size="small" onClick={() => handleCreateRecoveryCode(u)}>生成恢复码</Button>
                                                {/* 发通知（20260926）：对**单个**账号发一条站内通知，
                                                    与"公告"（粉丝/全体可见）是两件事——所以它在这一行上，
                                                    而不是页面顶部一个"发公告"按钮。 */}
                                                <Button size="small" className="tu-notify-btn"
                                                        onClick={() => openNotifyModal(u)}>发通知</Button>
                                                {freezeBlocked
                                                    ? <Tooltip title={freezeBlocked}>{freezeBtn}</Tooltip>
                                                    : freezeBtn}
                                                {/* 变更身份（20260926）：只有超管看得见这个入口。
                                                    不多给一个"把它禁掉"的中间态——普通管理员从来没有
                                                    过这个能力，禁用按钮会让人以为"本可以有"。
                                                    菜单里**不列当前身份**：一个"改成我现在这个"的
                                                    选项只会带来一次什么都没发生的往返。 */}
                                                {myRole === 'superadmin' && (
                                                    <Dropdown
                                                        trigger={['click']}
                                                        menu={{
                                                            items: ASSIGNABLE_ROLES
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
                                                    <Button size="small" className="tu-del-btn" danger onClick={() => handleDeleteTempUser(u.id)}>删除</Button>
                                                )}
                                            </div>
                                        </div>
                                      )
                                    })}
                                </div>
                            )}
                        </div>
                    </div>

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
                            <div style={{ marginTop: 8, color: '#8c8c8c' }}>
                                {statusNext
                                    ? '冻结后：该账号无法再登录，已登录的网页会话立即失效；解冻后需要重新登录，冻结前的登录状态不会恢复。'
                                    : '解冻后：该账号可以重新登录；它冻结前的登录状态不会恢复。'}
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
                            <div style={{ marginTop: 8, color: '#8c8c8c' }}>
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
                                <div style={{ color: '#8c8c8c' }}>
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
                                <Input.TextArea
                                    className="tu-notify-body"
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
            key: 'review',
            label: <h3>评论管理</h3>,
            children: <BoardManage />,
        },
    ];

    return (
        <div className="users-page">
            <Tabs activeKey={tab} onChange={setTab} items={items} />
        </div>
    );
};

export default Users;

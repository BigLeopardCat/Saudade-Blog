/**
 * 「这个浏览器上现在是哪个账号」——头部头像三态的唯一判据（20260922 用户要求）。
 *
 * 用户原话：「右上角头像若过期登录，或者退出登录有账号挂着等待输入密码，以及正常登录状态
 * 显示用户头像。没有账号登录记录，未上传头像使用默认头像显示」。
 *
 * 三种状态与各自的头像来源：
 *   ① 正常登录          → 自己的头像（`GET /api/protected/profile` 的 avatar）
 *   ② 过期登录 / 退出登录但本机有过账号 → **上次那个账号的头像**（localStorage 记住的）
 *   ③ 从没有过账号记录，或本人没上传过头像 → 默认头像 `/default-avatar.png`
 *
 * 为什么需要 ②：令牌是自包含的（无服务端会话），"过期"和"退出"在浏览器这一侧长得一样——
 * `tokenKey` 没了或被清掉了，但那个人明明还挂在这台机器上等输密码。头像不该跟着一起失忆。
 *
 * 两条纪律：
 *   · **这里只记展示身份（账号/昵称/头像地址），绝不记令牌**——令牌只有 `tokenKey` 一处，
 *     多存一份就多一个泄露面。退出登录**不清**这份缓存（清了就等于状态 ② 不存在）。
 *   · 缓存只用于**显示**，任何一次请求的身份都由 `tokenKey` 决定；先写进 localStorage
 *     再补一个 `useViewerAvatar` 的纯函数选择——没有账号记录时永远回默认头像，不猜。
 *
 * 20261001 补：身份是**跨标签页**的事实（localStorage 同源共享），所以"换账号"的感知
 * 通道必须包含 `storage` 事件——`auth-change` 只在本 document 里跑，光靠它会出现"另一个
 * 标签页换了账号、这里还顶着旧头像，刷新才变"。实现见下面那段 store 说明。
 */
import { useEffect, useState } from 'react'
import getToken from '../../apis/getToken.tsx'
import { getProfile, ok } from '../../apis/ProfileMethods.tsx'
import { resolveApiAssetUrl } from '../../utils/runtimeApi'

/** 默认头像（`frontend/public/default-avatar.png`，由 2047×1872 的原图居中裁方 + 缩到 256）。
 *  放在 public 下走**根相对路径**：头像展示位最大 100px，256 够 2 倍屏；改图只需换这个文件。 */
export const DEFAULT_AVATAR_URL = '/default-avatar.png'

/** localStorage 键。`saudade.` 前缀与 isDarkMode/announcement_seen_id 那几个自建键同族。 */
const LAST_USER_KEY = 'saudade.lastUser'
/** 本机登录过的**账号清单**（20260924 补）。`lastUser` 只留了最近一个，而"换账号输入"
 *  要认的是**这台机器上用过的每一个**——只留最近一个时，输上一个用过的账号会掉回默认头像。 */
const KNOWN_USERS_KEY = 'saudade.knownUsers'
/** 清单上限。这台机器上登录过的账号本来就是个位数；封顶是防脏数据把它们堆成无限列表。 */
const KNOWN_USERS_MAX = 8

export interface RememberedUser {
    username: string
    nickname: string
    avatar: string
    /** 记下的时刻（本地钟面字符串）——排障时能看出这份缓存有多旧 */
    at: string
}

/** 从任意来源（localStorage 解析结果）抠出规范形状；坏值一律按空字符串处理。 */
function toRememberedUser(v: any): RememberedUser | null {
    if (!v || typeof v !== 'object') return null
    return {
        username: typeof v.username === 'string' ? v.username : '',
        nickname: typeof v.nickname === 'string' ? v.nickname : '',
        avatar: typeof v.avatar === 'string' ? v.avatar : '',
        at: typeof v.at === 'string' ? v.at : '',
    }
}

/** 读取本机记住的**最近那个**账号（从没用过 / 数据坏了都返回 null，调用方按"没有记录"处理）。 */
export function readRememberedUser(): RememberedUser | null {
    try {
        const raw = localStorage.getItem(LAST_USER_KEY)
        return raw ? toRememberedUser(JSON.parse(raw)) : null
    } catch (e) {
        return null
    }
}

/**
 * 读取本机登录过的**账号清单**（最近的在前）。
 *
 * **兼容旧数据**：`knownUsers` 是 20260924 才有的键，此前只写过 `lastUser`。清单缺失/坏掉时
 * 用 `lastUser` 合成一条——否则升级那一刻，所有老访客会连"最近那个账号"都认不出来。
 * **这里只读不写**（读取方不该有副作用），迁移靠读时兜底，不需要改历史数据。
 */
export function readKnownUsers(): RememberedUser[] {
    try {
        const raw = localStorage.getItem(KNOWN_USERS_KEY)
        if (raw) {
            const arr = JSON.parse(raw)
            if (Array.isArray(arr)) {
                return arr.map(toRememberedUser)
                    .filter((u): u is RememberedUser => !!u && !!u.username)
            }
        }
    } catch (e) {
        /* 坏数据 → 落回 lastUser 那条 */
    }
    const last = readRememberedUser()
    return last && last.username ? [last] : []
}

/** 清单里按用户名找（trim + 忽略大小写）。展柜/登录页都用它做"这是本机认得的账号吗"。 */
export function findKnownUser(users: RememberedUser[], username: string): RememberedUser | null {
    const want = username.trim().toLowerCase()
    if (!want) return null
    return users.find((u) => u.username.trim().toLowerCase() === want) || null
}

/** 记下"这个浏览器上登录过谁"。每次拿到 profile 都写一遍（昵称/头像可能刚改过）。
 *  写两处：`lastUser`（最近那个，头部第②态用）与 `knownUsers` 清单（登录页按输入认人用）。 */
export function rememberUser(u: { username?: string; nickname?: string; avatar?: string | null }) {
    try {
        const d = new Date()
        const two = (n: number) => String(n).padStart(2, '0')
        const row: RememberedUser = {
            username: u.username || '',
            nickname: u.nickname || '',
            avatar: u.avatar || '',
            // **本地钟面**：全站时间约定是 +08:00 直读（`toISOString` 会是 UTC，差 8 小时）
            at: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} `
                + `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`,
        }
        localStorage.setItem(LAST_USER_KEY, JSON.stringify(row))
        if (!row.username) return
        // 清单：同一个人只留一条（忽略大小写去重），最近的排最前 —— 昵称/头像改了就是"新的那条"
        const rest = readKnownUsers()
            .filter((x) => x.username.trim().toLowerCase() !== row.username.trim().toLowerCase())
        localStorage.setItem(KNOWN_USERS_KEY,
            JSON.stringify([row, ...rest].slice(0, KNOWN_USERS_MAX)))
    } catch (e) {
        /* 隐私模式下 localStorage 可能不可写——头像退回默认，不影响任何请求 */
    }
}

/** 三态 → 头像地址（纯函数，便于单测与排障）。
 *  `myAvatar` 只在**真拿到过自己的资料**时才有值（null = 未登录或令牌已失效）：
 *  拿不到就退到本机记住的那个账号——这正是"退出登录但账号还挂着"要的效果。 */
export function selectAvatar(myAvatar: string | null, rememberedAvatar: string | null): string {
    return resolveApiAssetUrl(myAvatar || rememberedAvatar || '') || DEFAULT_AVATAR_URL
}

/**
 * **登录页**那一格头像（20260924 用户拍板）。与头部不同的唯一一点：它还要看**账号输入框**。
 *
 * 规则（纯本地比较，零请求）：
 *   · 输入框空着 ⇒ 上面那句算出来的头像（= 头部第②态那个"本机挂着的账号"，语义保持一致）
 *   · 填的账号在**本机登录过的清单**里 ⇒ 那个账号自己缓存的头像（**不是**最近那个人的）
 *   · 其余 ⇒ 默认头像
 *
 * 为什么不能"按输入的用户名去问后端要头像"：那等于给所有人一个**账号枚举 oracle**——输 `sora`
 * 出猫头像、输 `soraa` 出默认头像，一次请求就把"这个账号存不存在"吐出来。企业侧的通行做法是
 * 认证前不回显任何按用户名查到的资料：要么走"先输账号、下一页才显示欢迎语"的两步流，要么
 * **只认本机登录过的账号**（Windows/macOS 的账号选择器），要么登录页干脆不放个人头像。这里取
 * 第二条：头像只来自 localStorage（`saudade.knownUsers` 清单 + `saudade.lastUser`），
 * 输入框一偏离这份清单就回默认。
 *
 * **认不出来的那些账号**：清单只收"在这台机器上登录过、且当时拿到过资料"的账号——从没在本机
 * 登录过的、或本机登录它时还没这个清单的（20260924 之前的记录），都只能回默认头像。这是这条
 * 方案的固有代价，不是 bug：想认全，只能问后端，而那条路正是上面那个 oracle。
 *
 * 比较做 trim + 忽略大小写：这只是**展示层**的宽容匹配，真正的账号大小写语义在后端。
 */
export function selectLoginAvatar(
    viewerAvatar: string,
    knownUsers: RememberedUser[],
    typedAccount: string,
): string {
    if (!typedAccount.trim()) return viewerAvatar
    const hit = findKnownUser(knownUsers, typedAccount)
    return hit ? (resolveApiAssetUrl(hit.avatar || '') || DEFAULT_AVATAR_URL) : DEFAULT_AVATAR_URL
}

/** 三态 → 昵称（纯函数）。与 `selectAvatar` 同一条链，只是少了"默认值"这一档：
 *  昵称**没有**合理的默认值——编不出来就如实给空串，由调用方决定回落到什么
 *  （后台侧栏回落到站点作者名，签名则整块不渲染）。 */
export function selectNickname(myNickname: string | null, rememberedNickname: string | null): string {
    return (myNickname || rememberedNickname || '').trim()
}

/** "此刻看这个页面的人是谁"（展示用，绝不参与鉴权）。 */
export interface ViewerProfile {
    avatar: string
    nickname: string
}

// ══ 展示身份的**单一真源**（20261001，与 favorites.ts / unread.ts 同一套 store 形态）══
//
// 此前 `useViewerProfile` 是普通 hook：四个调用点（首页头部 / 登录页 / 后台侧栏 /
// 后台首页）各持一份 useState、各挂一组监听。两个后果：
//
//   ① **换账号只在"本标签页"里同步**（用户 20261001 报的那条）。`auth-change` 是挂在
//      `window` 上的自定义事件，只在本 document 里跑。用户在**另一个标签页**登录/退出
//      之后，本标签页唯一能知道这件事的通道是 `storage` 事件（同源 localStorage 是
//      共享的；改动的那个 document 自己不收事件、其余同源 document 才收）——而全仓
//      没有任何一处听过它（`grep -rn "'storage'" src/` 为空）。于是头像停在旧账号，
//      **必须刷新网页**才换。用户原话：「切换登录帐号了还显示着上次账号的头像，
//      必须刷新网页才同步」。
//   ② 同一份事实有 N 个各自计时的副本：后台一页同时挂着侧栏与首页两个消费者，
//      `/api/protected/profile` 被同一个浏览器打两次——unread.ts 记过同一条账。
//
// 现在身份只有一份（下面的 `mine` / `remembered` 与由它们派生的 `snap`），监听只在
// **模块加载时**挂一次，谁要显示就来订阅；`useViewerProfile` 只是薄薄一层 React 绑定。
// 顺带一个好处：快照是模块级的 ⇒ 换页（`/` → `/dashboard`）不再闪一下默认头像。

/** 本人资料（`null` = 未登录 / 令牌失效 / 还没拉回来）——store 内部状态，组件别直接读 */
let mine: { avatar: string; nickname: string } | null = null
/** 本机记住的**最近那个**账号（三态里的第 ② 态）。与 `mine` 一并在 `refreshViewer` 里更新 */
let remembered: RememberedUser | null = readRememberedUser()
/** 派生态：三态 → 头像/昵称。**值没变就不换引用**（订阅者把它写进 state） */
let snap: ViewerProfile = derive()
/** 活着的消费者数：0 时一次请求都不发（没人在看头像，拉它干嘛） */
let active = 0
/** 去重：同一时刻只发一次 GET（换账号那一刻 storage 与 visibility 可能一起到） */
let inflight: Promise<void> | null = null
const subs = new Set<() => void>()

/** 三态 → 快照（纯函数，两个 selector 的唯一出口） */
function derive(): ViewerProfile {
    return {
        avatar: selectAvatar(mine?.avatar ?? null, remembered?.avatar ?? null),
        nickname: selectNickname(mine?.nickname ?? null, remembered?.nickname ?? null),
    }
}

function emit(): void {
    subs.forEach((fn) => { try { fn() } catch (e) { /* 一个订阅者抛错不该拖垮其余 */ } })
}

/** 换快照：**值没变就不换引用、不发通知**（理由同 unread.ts 的 setSnap：内容相同的新
 *  引用会被 React 判成"变了"而白渲染一轮）。 */
function setSnap(next: ViewerProfile): void {
    if (next.avatar === snap.avatar && next.nickname === snap.nickname) return
    snap = next
    emit()
}

/** 订阅本 store（组件不要直接调，走 `useViewerProfile`） */
function subscribe(fn: () => void): () => void {
    subs.add(fn)
    return () => { subs.delete(fn) }
}

/**
 * 拉一次本人资料（并发去重 + 未登录即退回"本机记住的那个账号"）。
 *
 * 失败**不改动已有身份**（保住上一次的，界面不闪）——与 unread/favorites 同一条纪律：
 * 读不到不是"没有账号"。未登录是**事实**不是失败 ⇒ 退回三态的第 ② 态。
 */
export function refreshViewer(): Promise<void> {
    if (typeof window === 'undefined' || !active) return Promise.resolve()
    if (!getToken()) {
        // 退出登录：不请求，直接用本机记住的那个账号（缓存由上面的 rememberUser 维护）。
        // ⚠️ 顺手把**在途的那一次读取作废**：不摘掉的话，紧接着换账号登录会因为
        // "有在途请求"直接复用它 ⇒ 头像永远停在退登前那个账号（这正是本条要修的病）。
        inflight = null
        mine = null
        remembered = readRememberedUser()
        setSnap(derive())
        return Promise.resolve()
    }
    if (inflight) return inflight
    // 这一份读数属于**哪一次登录**。期间换过账号（另一个标签页登录/退出、别处改了密码
    // 使令牌换代）⇒ 结果作废——晚到的旧回包不许把旧账号写回 `mine`。
    const tokenAtRequest = getToken()
    const p: Promise<void> = getProfile()
        .then((res) => {
            if (getToken() !== tokenAtRequest) return
            if (!ok(res) || !res.data.data) return
            const d = res.data.data
            mine = { avatar: d.avatar || '', nickname: d.nickname || '' }
            // 本机那份同步成刚拿到的最新值（昵称/头像可能刚改过），同 rememberUser
            remembered = {
                username: d.username || '',
                nickname: d.nickname || '',
                avatar: d.avatar || '',
                at: '',
            }
            setSnap(derive())
            rememberUser(d)
        })
        .catch(() => {
            /* 令牌过期/网络异常：保住本机记住的那份，界面不闪 */
        })
        .finally(() => { if (inflight === p) inflight = null })
    inflight = p
    return p
}

// 全局监听在**模块加载时**挂一次（任何一个调用点引用本模块即生效）。要不要真去拉，
// 由 `refreshViewer` 里的 active 判据决定——挂载点不该由"这一刻谁在显示头像"决定。
if (typeof window !== 'undefined') {
    const onOwnChange = () => { refreshViewer() }   // 本标签页里登录/退出/改资料
    window.addEventListener('auth-change', onOwnChange)
    window.addEventListener('profile-change', onOwnChange)
    // ★ 别的标签页换了账号 —— 本标签页唯一的感知通道（见上面那段 store 说明）。
    // ⚠️ **必须把本模块自己会写的那两把键排除掉**：`refreshViewer` 里的 `rememberUser`
    // 每次都回写 `lastUser`（`at` 是秒级钟面，隔一秒写两次就是"值变了"）⇒ 不排除的话
    // 两个标签页会互相触发，ping-pong 永不停。
    window.addEventListener('storage', (e) => {
        if (e.key === LAST_USER_KEY || e.key === KNOWN_USERS_KEY) return
        refreshViewer()
    })
    // 回到本标签页时补一次（后台标签页里事件可能被降频/迟到；也顺带补上
    // "别人在另一个标签页改了昵称/头像"这种令牌没变的改动）。
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshViewer()
    })
}

/**
 * 登记一个"此刻真的在看这个头像"的消费者（`useViewerProfile` 挂载时调用），返回取消登记
 * 的函数。0 个消费者时事件照收、但一次请求都不发。
 */
export function retainViewer(): () => void {
    active += 1
    refreshViewer()
    return () => { active = Math.max(0, active - 1) }
}

/**
 * 头部 / 后台侧栏 / 登录页（以及任何要知道"当前访客是谁"的地方）用的展示身份。
 *
 * 拉取时机（五个，20261001 起）——都收敛到上面那一个 `refreshViewer`：
 *   1. 有人开始看时（`retainViewer` 登记）；2. `auth-change`；3. `profile-change`；
 *   4. **`storage`**（别的标签页动了 localStorage，**换账号**走这条）；
 *   5. `visibilitychange`（切回本标签页补一次）。
 * 未登录**不发请求**——访客的头部不该为了一张头像打后端。
 *
 * 返回的是 store 里那个快照对象本身：**同一个值不会换引用**，调用方可以安心把它
 * 放进依赖数组（别改成每次返回新对象——那会让 effect 每帧重跑）。
 */
export function useViewerProfile(): ViewerProfile {
    const [seen, setSeen] = useState<ViewerProfile>(() => snap)

    useEffect(() => subscribe(() => { setSeen(snap) }), [])
    // 登记消费者（0 → 1 时拉一次；走光之后事件不再触发请求）
    useEffect(() => retainViewer(), [])

    return seen
}

/** 供测试与排障：当前快照、几个消费者、几个订阅者 */
export function viewerDebug(): {
    profile: ViewerProfile; active: number; subscribers: number
} {
    return { profile: snap, active, subscribers: subs.size }
}

/** 只要头像的那一支（头部用它；与 `useViewerProfile` 同一份实现，别各写一遍）。 */
export function useViewerAvatar(): string {
    return useViewerProfile().avatar
}

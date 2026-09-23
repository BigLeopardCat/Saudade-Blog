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

/**
 * 头部（以及任何要知道"当前访客是谁"的地方）用的头像地址。
 *
 * 拉取时机：挂载时 + `auth-change`（登录/退出）+ `profile-change`（改完昵称/头像）。
 * 未登录**不发请求**——访客的头部不该为了一张头像打后端。
 */
export function useViewerAvatar(): string {
    // mine=null 表示"还没有本人的资料"（未登录 / 令牌失效 / 请求还没回来）
    const [mine, setMine] = useState<string | null>(null)
    const [remembered, setRemembered] = useState<string | null>(
        () => readRememberedUser()?.avatar || null,
    )

    useEffect(() => {
        let alive = true
        const pull = () => {
            if (!getToken()) {
                // 退出登录：不请求，直接用本机记住的那个账号（缓存由上面的 rememberUser 维护）
                if (!alive) return
                setMine(null)
                setRemembered(readRememberedUser()?.avatar || null)
                return
            }
            getProfile()
                .then((res) => {
                    if (!alive || !ok(res) || !res.data.data) return
                    const p = res.data.data
                    setMine(p.avatar || '')
                    setRemembered(p.avatar || null)
                    rememberUser(p)
                })
                .catch(() => {
                    /* 令牌过期/网络异常：保住本机记住的那份，界面不闪 */
                })
        }
        pull()
        const onAuthChange = () => pull()
        const onProfileChange = () => pull()
        window.addEventListener('auth-change', onAuthChange)
        window.addEventListener('profile-change', onProfileChange)
        return () => {
            alive = false
            window.removeEventListener('auth-change', onAuthChange)
            window.removeEventListener('profile-change', onProfileChange)
        }
    }, [])

    return selectAvatar(mine, remembered)
}

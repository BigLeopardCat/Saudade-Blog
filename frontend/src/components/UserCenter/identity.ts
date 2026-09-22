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

export interface RememberedUser {
    username: string
    nickname: string
    avatar: string
    /** 记下的时刻（本地钟面字符串）——排障时能看出这份缓存有多旧 */
    at: string
}

/** 读取本机记住的账号（从没用过 / 数据坏了都返回 null，调用方按"没有记录"处理）。 */
export function readRememberedUser(): RememberedUser | null {
    try {
        const raw = localStorage.getItem(LAST_USER_KEY)
        if (!raw) return null
        const v = JSON.parse(raw)
        if (!v || typeof v !== 'object') return null
        return {
            username: typeof v.username === 'string' ? v.username : '',
            nickname: typeof v.nickname === 'string' ? v.nickname : '',
            avatar: typeof v.avatar === 'string' ? v.avatar : '',
            at: typeof v.at === 'string' ? v.at : '',
        }
    } catch (e) {
        return null
    }
}

/** 记下"这个浏览器上登录过谁"。每次拿到 profile 都写一遍（昵称/头像可能刚改过）。 */
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

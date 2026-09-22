/**
 * 登录态与令牌解析（20260922 个人中心一期）。
 *
 * 令牌是无状态的 HS256 JWT，claims 里带 `role`——前端判"是不是管理员"就从这里读，
 * 不额外加一个"我是谁"的接口（后台守卫 AuthRouter 一直是这么做的，这里把那段抽出来
 * 给第二、第三个调用点共用，避免三份实现各自漂移）。
 *
 * **前端只拿它做界面分流（显示哪个入口/哪个窗口），不是权限判据**：真正的授权在
 * Rust 侧 `auth_guard`（后台接口）与各 handler 的 `auth_uid`（个人中心接口）。
 * 伪造 role 只能骗到自己的界面，骗不到任何一个接口。
 */

export interface TokenClaims {
    /** 用户 id（后端 auth_uid 用的就是它） */
    sub?: number
    /** 角色：admin 为管理员，其余为普通用户 */
    role?: string
    /** 过期时间（秒级 unix） */
    exp?: number
}

/** 解析 JWT payload。解析不出（缺段/非法 base64/非 JSON）一律返回 null，不抛。 */
export function getTokenClaims(token?: string | null): TokenClaims | null {
    if (!token) return null
    try {
        const part = token.split('.')[1]
        if (!part) return null
        // JWT 用 base64url（`-`/`_`、无填充），atob 只认标准 base64 ⇒ 先转再补 '='
        const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
        const json = decodeURIComponent(
            atob(padded)
                .split('')
                .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
                .join(''),
        )
        return JSON.parse(json) as TokenClaims
    } catch (e) {
        return null
    }
}

/** 当前登录用户的 role（未登录/解析失败 = null） */
export function getRoleFromToken(token?: string | null): string | null {
    return getTokenClaims(token)?.role ?? null
}

/** 是否管理员（前端界面分流用，非权限判据，见文件头） */
export function isAdminToken(token?: string | null): boolean {
    return getRoleFromToken(token) === 'admin'
}

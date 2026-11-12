export interface TokenClaims {
    /** 用户 id（后端 auth_uid 用的就是它） */
    sub?: number
    /** 角色：admin 管理员 / superadmin 超级管理员 / user 普通用户 / zako 杂鱼 */
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
    } catch {
        return null
    }
}

/** 当前登录用户的 role（未登录/解析失败 = null） */
export function getRoleFromToken(token?: string | null): string | null {
    return getTokenClaims(token)?.role ?? null
}

/** 解析当前账号 id，仅供界面判断本人操作；不构成服务端授权。 */
export function getUidFromToken(token?: string | null): number | null {
    const sub = getTokenClaims(token)?.sub
    return typeof sub === 'number' ? sub : null
}

/** 前端后台入口判断；真实权限由服务端当前账号状态核对。 */
export function isAdminToken(token?: string | null): boolean {
    const role = getRoleFromToken(token)
    return role === 'admin' || role === 'superadmin'
}

/** 角色显示名，与服务端 KNOWN_ROLES 的取值一致。 */
export const ROLE_LABEL: Record<string, string> = {
    admin: '管理员',
    superadmin: '站长',
    user: '普通用户',
    zako: '杂鱼',
}

/** 角色 → 显示名。未知/空角色原样返回（空串时给「—」，与个人中心其它"读不到"的
 *  展示同一套：**不猜、不编**）。 */
export function roleLabel(role?: string | null): string {
    if (!role) return '—'
    return ROLE_LABEL[role] || role
}


/** Mirrors authz::can_manage_credentials for UI affordances only. Unknown identities fail closed. */
export function canManageCredentials(token: string | null, target: {id: number; role?: string | null}): boolean {
    const claims = getTokenClaims(token);
    if (!claims || !Number.isSafeInteger(claims.sub) || Number(claims.sub) <= 0
        || !Number.isSafeInteger(target.id) || target.id <= 0 || claims.sub === target.id
        || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) return false;
    if (!['admin', 'superadmin'].includes(claims.role || '') || !['admin', 'user', 'zako'].includes(target.role || '')) return false;
    return claims.role === 'superadmin' || target.role !== 'admin';
}

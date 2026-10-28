import {getTokenClaims} from './auth';

const key = 'tokenKey';
const bare = (token: string | null | undefined) => token?.replace(/^Bearer\s+/i, '') || null;

/** An old failed request must never sign out a newly authenticated session. */
export function clearAuthToken(expected?: string | null): boolean {
    const current = localStorage.getItem(key);
    if (!current || (expected !== undefined && bare(expected) !== bare(current))) return false;
    localStorage.removeItem(key);
    window.dispatchEvent(new Event('auth-change'));
    return true;
}

let owners = 0;
let dispose: (() => void) | undefined;

/** One expiry timer for the whole application, including background-tab recovery. */
export function startAuthExpiry(): () => void {
    if (owners++ === 0) {
        let timer: number | undefined;
        const refresh = () => {
            window.clearTimeout(timer);
            const token = localStorage.getItem(key);
            if (!token) return;
            const exp = getTokenClaims(token)?.exp;
            if (typeof exp !== 'number' || !Number.isFinite(exp) || exp * 1000 <= Date.now()) {
                clearAuthToken(token);
                return;
            }
            timer = window.setTimeout(refresh, Math.min(2_147_483_647, exp * 1000 - Date.now() + 1));
        };
        const visible = () => { if (!document.hidden) refresh(); };
        window.addEventListener('auth-change', refresh);
        window.addEventListener('storage', refresh);
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', visible);
        dispose = () => {
            window.clearTimeout(timer);
            window.removeEventListener('auth-change', refresh);
            window.removeEventListener('storage', refresh);
            window.removeEventListener('focus', refresh);
            document.removeEventListener('visibilitychange', visible);
        };
        refresh();
    }
    let stopped = false;
    return () => {
        if (stopped) return;
        stopped = true;
        if (--owners === 0) { dispose?.(); dispose = undefined; }
    };
}

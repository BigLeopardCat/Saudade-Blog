import {useEffect, useState, useSyncExternalStore, type ReactNode} from 'react';
import {message} from 'antd';
import {useNavigate} from 'react-router-dom';
import getToken from '../apis/getToken';
import {getTokenClaims, isAdminToken} from '../utils/auth';

function subscribeAuth(refresh: () => void) {
    window.addEventListener('auth-change', refresh);
    window.addEventListener('storage', refresh);
    return () => {
        window.removeEventListener('auth-change', refresh);
        window.removeEventListener('storage', refresh);
    };
}

// The snapshot changes at expiry as well as when storage changes.
function getLiveToken() {
    const token = getToken();
    const expires = getTokenClaims(token)?.exp;
    return typeof expires === 'number' && Number.isFinite(expires) && expires * 1000 > Date.now() ? token : null;
}

/** UI gate only: every API still verifies authorization on the server. */
export function AuthRouter({children}: {children: ReactNode}) {
    const navigate = useNavigate();
    const token = useSyncExternalStore(subscribeAuth, getLiveToken, () => null);
    const [clockRevision, tick] = useState(0);
    const expires = getTokenClaims(token)?.exp;
    const allowed = isAdminToken(token);

    useEffect(() => {
        if (!allowed || typeof expires !== 'number') return;
        const timer = window.setTimeout(() => tick(value => value + 1), Math.min(2_147_483_647, Math.max(0, expires * 1000 - Date.now())));
        return () => window.clearTimeout(timer);
    }, [allowed, expires, clockRevision]);

    useEffect(() => {
        if (allowed) return;
        message.error(!token ? '请先登录！' : '无权限访问后台');
        navigate('/', {replace: true});
    }, [allowed, token, navigate]);

    // Returning null prevents effects and lazy imports in the protected subtree.
    return allowed ? <>{children}</> : null;
}

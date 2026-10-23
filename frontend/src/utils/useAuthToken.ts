import {useEffect, useState, useSyncExternalStore} from 'react';
import getToken from '../apis/getToken';
import {getTokenClaims} from './auth';

function subscribe(refresh: () => void) {
    window.addEventListener('auth-change', refresh);
    window.addEventListener('storage', refresh);
    return () => {
        window.removeEventListener('auth-change', refresh);
        window.removeEventListener('storage', refresh);
    };
}
export function getLiveAuthToken(): string | null {
    const token = getToken();
    const expires = getTokenClaims(token)?.exp;
    return typeof expires === 'number' && Number.isFinite(expires) && expires * 1000 > Date.now() ? token : null;
}
/** Reactive UI identity; authorization remains server-side. */
export function useAuthToken() {
    const token = useSyncExternalStore(subscribe, getLiveAuthToken, () => null);
    const [revision, tick] = useState(0);
    const expires = getTokenClaims(token)?.exp;
    useEffect(() => {
        if (typeof expires !== 'number') return;
        const timer = window.setTimeout(() => tick(value => value + 1), Math.min(2_147_483_647, Math.max(0, expires * 1000 - Date.now())));
        return () => window.clearTimeout(timer);
    }, [expires, revision]);
    return token;
}

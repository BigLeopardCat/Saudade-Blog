import {useSyncExternalStore} from 'react';
import {startAuthExpiry} from './authSession';
import getToken from '../apis/getToken';
import {getTokenClaims} from './auth';

function subscribe(refresh: () => void) {
    window.addEventListener('auth-change', refresh);
    window.addEventListener('storage', refresh);
    const stop = startAuthExpiry();
    return () => {
        stop();
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
    return useSyncExternalStore(subscribe, getLiveAuthToken, () => null);
}

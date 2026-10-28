import {afterEach, describe, expect, it, vi} from 'vitest';
import {clearAuthToken, startAuthExpiry} from '../../src/utils/authSession';
const token = (exp: number) => `header.${btoa(JSON.stringify({sub: 7, role: 'user', exp}))}.signature`;
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; localStorage.clear(); vi.useRealTimers(); });
describe('application session expiry', () => {
    it('clears credentials and notifies UI subscribers exactly once at expiration', () => {
        vi.useFakeTimers(); vi.setSystemTime(1_000_000);
        localStorage.setItem('tokenKey', token(1060));
        const changed = vi.fn(); window.addEventListener('auth-change', changed);
        stop = startAuthExpiry(); vi.advanceTimersByTime(60_001);
        expect(localStorage.getItem('tokenKey')).toBeNull(); expect(changed).toHaveBeenCalledTimes(1);
        window.removeEventListener('auth-change', changed);
    });
    it('reschedules rotation and rejects stale unauthorized responses', () => {
        vi.useFakeTimers(); vi.setSystemTime(1_000_000);
        const old = token(1060), fresh = token(1120);
        localStorage.setItem('tokenKey', old); stop = startAuthExpiry();
        localStorage.setItem('tokenKey', fresh); window.dispatchEvent(new Event('auth-change'));
        expect(clearAuthToken(`Bearer ${old}`)).toBe(false);
        vi.advanceTimersByTime(60_001); expect(localStorage.getItem('tokenKey')).toBe(fresh);
        vi.advanceTimersByTime(60_000); expect(localStorage.getItem('tokenKey')).toBeNull();
    });
    it('rechecks on focus after background timer suspension', () => {
        vi.useFakeTimers(); vi.setSystemTime(1_000_000);
        localStorage.setItem('tokenKey', token(1060)); stop = startAuthExpiry();
        vi.setSystemTime(1_120_000); window.dispatchEvent(new Event('focus'));
        expect(localStorage.getItem('tokenKey')).toBeNull();
    });
});

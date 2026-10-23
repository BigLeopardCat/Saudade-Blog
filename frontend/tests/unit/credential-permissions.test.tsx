import {act, render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {canManageCredentials} from '../../src/utils/auth';
import {useAuthToken} from '../../src/utils/useAuthToken';
const token = (role: string, sub = 1, exp = Date.now() / 1000 + 60) => `test.${btoa(JSON.stringify({role, sub, exp}))}.signature`;
function Entry() {
    const credential = useAuthToken();
    return canManageCredentials(credential, {id: 2, role: 'admin'}) ? <button>修改密码</button> : null;
}
describe('credential management contract', () => {
    it.each(['admin', 'superadmin', 'user', 'zako', 'unknown'])('checks all targets for %s', operator => {
        for (const target of ['admin', 'superadmin', 'user', 'zako', 'unknown', null]) {
            const allowed = (operator === 'superadmin' && ['admin', 'user', 'zako'].includes(target || ''))
                || (operator === 'admin' && ['user', 'zako'].includes(target || ''));
            expect(canManageCredentials(token(operator), {id: 2, role: target})).toBe(allowed);
            expect(canManageCredentials(token(operator), {id: 1, role: target})).toBe(false);
        }
    });
    it('rejects missing, expired and malformed identities', () => {
        for (const credential of [null, 'bad', token('admin', 1, 1), token('admin', -1), token('admin', 1.5)])
            expect(canManageCredentials(credential, {id: 2, role: 'user'})).toBe(false);
        for (const id of [0, -1, NaN, 1.5]) expect(canManageCredentials(token('admin'), {id, role: 'user'})).toBe(false);
    });
    it('updates open UI after same-tab and cross-tab identity changes', () => {
        localStorage.setItem('tokenKey', token('superadmin'));
        render(<Entry />);
        expect(screen.queryByRole('button')).not.toBeNull();
        act(() => {localStorage.setItem('tokenKey', token('admin')); window.dispatchEvent(new Event('auth-change'));});
        expect(screen.queryByRole('button')).toBeNull();
        act(() => {localStorage.setItem('tokenKey', token('superadmin')); window.dispatchEvent(new Event('storage'));});
        expect(screen.queryByRole('button')).not.toBeNull();
    });
    it('revokes an open UI at expiry', () => {
        vi.useFakeTimers();
        localStorage.setItem('tokenKey', token('superadmin', 1, Date.now() / 1000 + 1));
        render(<Entry />);
        expect(screen.queryByRole('button')).not.toBeNull();
        act(() => vi.advanceTimersByTime(1001));
        expect(screen.queryByRole('button')).toBeNull();
    });
});

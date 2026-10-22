import {useEffect} from 'react';
import {act, render, screen} from '@testing-library/react';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {AuthRouter} from '../../src/components/AuthRouter';

const {navigate, notify, mount, unmount} = vi.hoisted(() => ({navigate: vi.fn(), notify: vi.fn(), mount: vi.fn(), unmount: vi.fn()}));
vi.mock('react-router-dom', () => ({useNavigate: () => navigate}));
vi.mock('antd', () => ({message: {error: notify}}));
function Protected() {
    useEffect(() => { mount(); return unmount; }, []);
    return <div>后台内容</div>;
}
const token = (role: string, exp = Date.now() / 1000 + 60) => `test.${btoa(JSON.stringify({role, exp}))}.signature`;
beforeEach(() => { localStorage.clear(); });
describe('console subtree admission', () => {
    it.each([null, 'malformed', token('user'), token('admin', 1)])('never mounts a rejected child: %s', credential => {
        if (credential) localStorage.setItem('tokenKey', credential);
        render(<AuthRouter><Protected /></AuthRouter>);
        expect(mount).not.toHaveBeenCalled();
        expect(screen.queryByText('后台内容')).toBeNull();
        expect(navigate).toHaveBeenCalledWith('/', {replace: true});
    });
    it.each(['admin', 'superadmin'])('admits a live %s token and unmounts on logout', role => {
        localStorage.setItem('tokenKey', token(role));
        render(<AuthRouter><Protected /></AuthRouter>);
        expect(mount).toHaveBeenCalledTimes(1);
        act(() => { localStorage.removeItem('tokenKey'); window.dispatchEvent(new Event('auth-change')); });
        expect(screen.queryByText('后台内容')).toBeNull();
        expect(unmount).toHaveBeenCalledTimes(1);
    });
    it('rechecks role changes from another tab', () => {
        localStorage.setItem('tokenKey', token('admin'));
        render(<AuthRouter><Protected /></AuthRouter>);
        act(() => { localStorage.setItem('tokenKey', token('user')); window.dispatchEvent(new Event('storage')); });
        expect(screen.queryByText('后台内容')).toBeNull();
        expect(unmount).toHaveBeenCalledTimes(1);
    });
    it('unmounts when the token expires while the page stays open', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-23T04:00:00Z'));
        localStorage.setItem('tokenKey', token('admin', Date.now() / 1000 + 2));
        render(<AuthRouter><Protected /></AuthRouter>);
        expect(mount).toHaveBeenCalledTimes(1);
        act(() => vi.advanceTimersByTime(2001));
        expect(screen.queryByText('后台内容')).toBeNull();
        expect(unmount).toHaveBeenCalledTimes(1);
    });
});

import {beforeAll, describe, expect, it, vi} from 'vitest';
import {act, fireEvent, render, screen} from '@testing-library/react';
import {StyleProvider} from '@ant-design/cssinjs/lib/index.js';
import Users from '../../src/pages/Dashboard/Users';
const {post} = vi.hoisted(() => ({post: vi.fn()}));
vi.mock('../../src/apis/axios.tsx', () => ({default: {post}}));
vi.mock('react-router-dom', () => ({useSearchParams: () => [new URLSearchParams()]}));
vi.mock('../../src/pages/Dashboard/BoardManage', () => ({default: () => null}));
vi.mock('../../src/pages/Dashboard/CommentManage', () => ({default: () => null}));
vi.mock('../../src/pages/Dashboard/QuotaManage', () => ({default: () => null}));
vi.mock('../../src/utils/liveRefresh.ts', () => ({useLiveRefresh: () => undefined}));
vi.mock('../../src/pages/Dashboard/Users/tempUsers.ts', () => ({
    useTempUsers: () => ({users: [
        {id: 1, username: '自己', role: 'admin'},
        {id: 2, username: '同级管理员', role: 'admin'},
        {id: 3, username: '普通账号', role: 'user'},
        {id: 4, username: '未知角色', role: 'unknown'},
    ], loading: false, error: null}),
    refreshTempUsers: vi.fn(), invalidateTempUsers: vi.fn(),
}));
const token = (role: string, sub = 1) => `test.${btoa(JSON.stringify({role, sub, exp: Date.now()/1000 + 60}))}.signature`;
beforeAll(() => {
    const computed = window.getComputedStyle.bind(window);
    window.getComputedStyle = element => computed(element);
    window.matchMedia = () => ({matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true});
    globalThis.ResizeObserver = class {observe() {} unobserve() {} disconnect() {}};
});
describe('account credential controls', () => {
    it('hides forbidden actions, allows managed users, and revokes an already open password dialog', async () => {
        localStorage.setItem('tokenKey', token('admin'));
        render(<StyleProvider mock="server" container={document.createElement('div')}><Users /></StyleProvider>);
        expect(screen.getAllByRole('button', {name: '修改密码'})).toHaveLength(1);
        expect(screen.getAllByRole('button', {name: '生成恢复码'})).toHaveLength(1);
        fireEvent.click(screen.getByRole('button', {name: '修改密码'}));
        expect(screen.getByRole('dialog', {name: '修改密码 - 普通账号'})).not.toBeNull();
        act(() => {localStorage.setItem('tokenKey', token('admin', 3)); window.dispatchEvent(new Event('auth-change'));});
        expect(screen.queryByRole('dialog', {name: '修改密码 - 普通账号'})).toBeNull();
        expect(post).not.toHaveBeenCalled();
    });
});

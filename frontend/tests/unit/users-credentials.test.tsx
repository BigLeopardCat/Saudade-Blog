import {beforeAll, describe, expect, it, vi} from 'vitest';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {StyleProvider} from '@ant-design/cssinjs/lib/index.js';
import Users from '../../src/pages/Dashboard/Users';
const {post} = vi.hoisted(() => ({post: vi.fn()}));
vi.mock('../../src/apis/axios.tsx', () => ({default: {post}}));
vi.mock('react-router-dom', () => ({useSearchParams: () => [new URLSearchParams()]}));
vi.mock('../../src/pages/Dashboard/BoardManage', () => ({default: () => <div>河灯审核面板</div>}));
vi.mock('../../src/pages/Dashboard/CommentManage', () => ({default: () => <div>文章评论审核面板</div>}));
vi.mock('../../src/pages/Dashboard/QuotaManage', () => ({default: () => <div>额度审批面板</div>}));
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
    it('does not duplicate recovery requests or reveal a late result after identity changes', async () => {
        localStorage.setItem('tokenKey', token('admin'));
        let resolve!: (value: unknown) => void;
        post.mockReturnValueOnce(new Promise(done => {resolve = done;}));
        render(<StyleProvider mock="server" container={document.createElement('div')}><Users /></StyleProvider>);
        const generate = screen.getByRole('button', {name: '生成恢复码'});
        fireEvent.click(generate);
        fireEvent.click(generate);
        expect(post).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledWith('/api/temp-users/3/password-reset-token');
        act(() => {localStorage.setItem('tokenKey', token('admin', 4)); window.dispatchEvent(new Event('auth-change'));});
        await act(async () => resolve({data: {code: 200, data: 'SECRET-RECOVERY'}}));
        await waitFor(() => expect(screen.queryByText('SECRET-RECOVERY')).toBeNull());
        expect(screen.queryByRole('dialog')).toBeNull();
    });
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


it('tab labels open their corresponding account, guestbook, comment, and quota panels', async () => {
    localStorage.setItem('tokenKey', token('admin'));
    render(<StyleProvider mock="server" container={document.createElement('div')}><Users /></StyleProvider>);
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
        '账号管理', '留言管理', '评论管理', '额度管理',
    ]);
    for (const [label, contents] of [['留言管理', '河灯审核面板'], ['评论管理', '文章评论审核面板'], ['额度管理', '额度审批面板']]) {
        const tab = screen.getByRole('tab', {name: label});
        fireEvent.click(tab);
        await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
        expect(screen.getByRole('tabpanel', {name: label}).textContent).toContain(contents);
    }
    fireEvent.click(screen.getByRole('tab', {name: '账号管理'}));
    expect(screen.getByRole('tabpanel', {name: '账号管理'}).textContent).toContain('普通账号');
});

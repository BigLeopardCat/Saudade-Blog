import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, getConfig, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { message } from 'antd';
import { StyleProvider } from '@ant-design/cssinjs/lib/index.js';
import AllCategorize from '../../src/pages/Dashboard/Notes/AllCategorize';
import { addCategory, delAllCategory, getCategories, updateCategory } from '../../src/apis/CategoryMethods';
import { deferred } from '../helpers/deferred';
vi.mock('../../src/apis/CategoryMethods', () => ({ addCategory: vi.fn(), delAllCategory: vi.fn(), getCategories: vi.fn(), updateCategory: vi.fn() }));
vi.mock('react-redux', () => ({ useDispatch: () => vi.fn() }));
vi.mock('../../src/store/components/categories', () => ({ fetchCategories: vi.fn() }));
vi.mock('../../src/utils/liveRefresh', () => ({ useLiveRefresh: vi.fn() }));
const originalAsyncTimeout = getConfig().asyncUtilTimeout;
// Scope the larger DOM-query budget to real Ant Design tests on the shared host.
beforeAll(() => configure({ asyncUtilTimeout: 5_000 }));
afterAll(() => configure({ asyncUtilTimeout: originalAsyncTimeout }));
let user: ReturnType<typeof userEvent.setup>;
const nativeGetComputedStyle = window.getComputedStyle.bind(window);
const success = { status: 200, data: { code: 200 } };
const rows = [
    { categoryKey: 4, categoryTitle: '技术札记', pathName: 'tech', introduce: '代码与架构', icon: 'fa-code', color: '#3975b8', noteCount: 3 },
    { categoryKey: 8, categoryTitle: '旅行', pathName: 'travel', introduce: '山川见闻', icon: 'fa-compass', color: '#4b8f81', noteCount: 0 },
];
beforeEach(() => {
    vi.resetAllMocks();
    user = userEvent.setup();
    // A resource-constrained host may spend seconds evaluating real Ant Design DOM.
    // Keep feedback visible until the test explicitly tears it down.
    message.config({ duration: 0 });
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => nativeGetComputedStyle(element));
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('min-width'), media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.mocked(getCategories).mockResolvedValue({ status: 200, data: { code: 200, data: rows } } as never);
    vi.mocked(addCategory).mockResolvedValue(success as never);
    vi.mocked(updateCategory).mockResolvedValue(success as never);
    vi.mocked(delAllCategory).mockResolvedValue(success as never);
});
afterEach(async () => {
    message.destroy();
    await waitFor(() => expect(document.querySelectorAll('.ant-message-notice')).toHaveLength(0));
    message.config({ duration: 3 });
});
async function show() { render(<StyleProvider mock="server" container={document.createElement('div')}><AllCategorize /></StyleProvider>); await screen.findByRole('button', { name: '编辑分类 技术札记' }); }
async function readyDialog() {
    // Feedback can commit before the parent's busy=false render. Await the actual
    // cancel control, whose disabled state reflects the shared mutation lock.
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('button', { name: /取\s*消/ })).toHaveProperty('disabled', false));
}
async function fill(input: HTMLElement, value: string) {
    await user.clear(input);
    await user.click(input);
    // Paste is one actual user input action; avoid per-character DOM/validation cost.
    await user.paste(value);
}
async function field(label: string, value: string) { await fill(screen.getByLabelText(label), value); }
async function create() {
    await user.click(screen.getByRole('button', { name: /新建分类/ }));
    await screen.findByRole('dialog');
    await readyDialog();
    await field('分类名称', '生活随记');
    await field('分类介绍（选填）', '日常生活记录');
}
describe('category manager real component', () => {
    it('searches the list and suggests a path until manually customized', async () => {
        await show();
        await fill(screen.getByRole('searchbox', { name: '搜索分类' }), '山川');
        expect(screen.queryByRole('button', { name: '编辑分类 技术札记' })).toBeNull();
        expect(screen.getByRole('button', { name: '编辑分类 旅行' })).toBeTruthy();
        await create();
        expect(screen.getByLabelText('访问路径')).toHaveProperty('value', '生活随记');
        await field('访问路径', 'daily-notes');
        await field('分类名称', '另一个名字');
        expect(screen.getByLabelText('访问路径')).toHaveProperty('value', 'daily-notes');
        expect(screen.getByRole('combobox', { name: '分类图标' })).toBeTruthy();
        await user.click(screen.getByRole('button', { name: '创建分类' }));
        await waitFor(() => expect(addCategory).toHaveBeenCalledWith({ categoryTitle: '另一个名字', pathName: 'daily-notes', introduce: '日常生活记录', icon: 'fa-folder-open', color: '#d94f9a' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }, 30_000);
    it('preserves input on business/network errors; closes only on confirmed success', async () => {
        vi.mocked(addCategory).mockResolvedValueOnce({ status: 200, data: { code: 500, message: '分类保存失败' } } as never).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(success as never);
        await show(); await create();
        await user.click(screen.getByRole('button', { name: '创建分类' }));
        await screen.findByText('分类保存失败');
        await readyDialog();
        expect(screen.getByLabelText('分类名称')).toHaveProperty('value', '生活随记');
        await user.click(screen.getByRole('button', { name: '创建分类' }));
        await screen.findByText('请求失败，请检查网络后重试');
        await readyDialog();
        expect(screen.getByLabelText('分类介绍（选填）')).toHaveProperty('value', '日常生活记录');
        await user.click(screen.getByRole('button', { name: '创建分类' }));
        await waitFor(() => expect(addCategory).toHaveBeenCalledTimes(3));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }, 30_000);
    it('single-flights edits and retains a custom existing icon', async () => {
        const pending = deferred<typeof success>();
        vi.mocked(updateCategory).mockReturnValue(pending.promise as never);
        await show(); await user.click(screen.getByRole('button', { name: '编辑分类 旅行' }));
        expect(await screen.findByText('当前图标')).toBeTruthy();
        const save = screen.getByRole('button', { name: '保存修改' });
        await user.click(save); await user.click(save);
        await waitFor(() => expect(updateCategory).toHaveBeenCalledTimes(1));
        expect(updateCategory).toHaveBeenCalledWith(expect.objectContaining({ icon: 'fa-compass', pathName: 'travel' }), 8);
        expect(screen.getByRole('button', { name: /取\s*消/ })).toHaveProperty('disabled', true);
        pending.resolve(success);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }, 30_000);
    it('retains edited values on business and network failure, then saves to the same category ID', async () => {
        vi.mocked(updateCategory).mockResolvedValueOnce({ status: 200, data: { code: 500, message: '更新分类失败' } } as never).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(success as never);
        await show();
        await user.click(screen.getByRole('button', { name: '编辑分类 技术札记' }));
        await field('分类名称', '技术与架构');
        await user.click(screen.getByRole('button', { name: '保存修改' }));
        await screen.findByText('更新分类失败');
        await readyDialog();
        expect(screen.getByLabelText('分类名称')).toHaveProperty('value', '技术与架构');
        expect(screen.getByLabelText('访问路径')).toHaveProperty('value', 'tech');
        await user.click(screen.getByRole('button', { name: '保存修改' }));
        await screen.findByText('请求失败，请检查网络后重试');
        await readyDialog();
        expect(screen.getByLabelText('分类名称')).toHaveProperty('value', '技术与架构');
        await user.click(screen.getByRole('button', { name: '保存修改' }));
        await waitFor(() => expect(updateCategory).toHaveBeenCalledTimes(3));
        expect(updateCategory).toHaveBeenLastCalledWith(expect.objectContaining({ categoryTitle: '技术与架构', pathName: 'tech' }), 4);
        expect(addCategory).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }, 30_000);

    it('explains deletion impact; cancel sends nothing and failure retains confirmation', async () => {
        vi.mocked(delAllCategory).mockResolvedValueOnce({ status: 200, data: { code: 500, message: '删除失败，请重试' } } as never).mockResolvedValueOnce(success as never);
        await show(); await user.click(screen.getByRole('button', { name: '删除分类 技术札记' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText(/文章会保留/)).toBeTruthy();
        expect(within(dialog).getByText(/当前统计涉及 3 篇文章/)).toBeTruthy();
        await user.click(within(dialog).getByRole('button', { name: /取\s*消/ }));
        expect(delAllCategory).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: '删除分类 技术札记' }));
        await user.click(screen.getByRole('button', { name: '确认删除分类' }));
        await screen.findByText('删除失败，请重试');
        await readyDialog();
        expect(screen.getByRole('dialog')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: '确认删除分类' }));
        await waitFor(() => expect(delAllCategory).toHaveBeenCalledTimes(2));
        expect(delAllCategory).toHaveBeenLastCalledWith([4]);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }, 30_000);
    it('retains selected IDs on failed bulk deletion; success clears only the confirmed targets', async () => {
        const pending = deferred<typeof success>();
        vi.mocked(delAllCategory).mockResolvedValueOnce({ status: 200, data: { code: 500, message: '批量删除失败' } } as never).mockReturnValueOnce(pending.promise as never);
        await show();
        await user.click(screen.getByRole('checkbox', { name: '选择分类 技术札记' }));
        await user.click(screen.getByRole('checkbox', { name: '选择分类 旅行' }));
        expect(screen.getByText('已选择 2 个分类')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: '删除所选分类' }));
        await user.click(screen.getByRole('button', { name: '确认删除分类' }));
        await screen.findByText('批量删除失败');
        await readyDialog();
        expect(screen.getByText('已选择 2 个分类')).toBeTruthy();
        expect(delAllCategory).toHaveBeenCalledWith([4, 8]);
        const confirm = screen.getByRole('button', { name: '确认删除分类' });
        await user.click(confirm); await user.click(confirm);
        await waitFor(() => expect(delAllCategory).toHaveBeenCalledTimes(2));
        expect(delAllCategory).toHaveBeenLastCalledWith([4, 8]);
        pending.resolve(success);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(screen.queryByText('已选择 2 个分类')).toBeNull();
    }, 30_000);

    it('validates required and duplicate fields before requesting', async () => {
        await show(); await user.click(screen.getByRole('button', { name: /新建分类/ }));
        await screen.findByRole('dialog');
        await readyDialog();
        await user.click(screen.getByRole('button', { name: '创建分类' }));
        await screen.findByText('请填写分类名称');
        await readyDialog();
        expect(addCategory).not.toHaveBeenCalled();
        await field('分类名称', '技术札记'); await field('访问路径', 'tech'); await field('分类介绍（选填）', '重复内容');
        await user.click(screen.getByRole('button', { name: '创建分类' }));
        await screen.findByText('已有同名分类，请换一个名称');
        expect(addCategory).not.toHaveBeenCalled();
    }, 30_000);
});

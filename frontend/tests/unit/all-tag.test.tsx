import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { message } from 'antd';
import { Provider } from 'react-redux';
import { createCatalogStore } from '../helpers/catalogStore';
import { StyleProvider } from '@ant-design/cssinjs/lib/index.js';
import AllTag from '../../src/pages/Dashboard/Notes/AllTag';
import { deferred } from '../helpers/deferred';

const api = vi.hoisted(() => ({ load: vi.fn(), addOne: vi.fn(), addTwo: vi.fn(), updateOne: vi.fn(), updateTwo: vi.fn(), del: vi.fn(), dispatch: vi.fn() }));
vi.mock('../../src/apis/catalogReads', () => ({ loadTags: api.load }));
vi.mock('../../src/apis/TagMethods', () => ({ addTagOne: api.addOne, addTagTwo: api.addTwo, updateTagOne: api.updateOne, updateTagTwo: api.updateTwo, delTag: api.del }));
const initial = [{ key: 7, title: '编程', level: 1, color: '#1677ff', children: [{ key: 7, title: 'TypeScript', level: 2, fatherKey: 7, fatherTag: '编程', color: '#52c41a' }] }];
const success = { status: 200, data: { code: 200, message: 'ok', data: '' } };

beforeAll(() => {
    const computedStyle = window.getComputedStyle.bind(window);
    window.getComputedStyle = element => computedStyle(element);
    window.matchMedia = () => ({ matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true });
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => message.destroy());
beforeEach(() => {
    api.load.mockResolvedValue(initial);
    for (const write of [api.addOne, api.addTwo, api.updateOne, api.updateTwo, api.del]) write.mockResolvedValue(success);
});
async function loaded() {
    render(<Provider store={createCatalogStore()}><StyleProvider mock="server" container={document.createElement('div')}><AllTag /></StyleProvider></Provider>);
    await screen.findByText('TypeScript');
}

describe('tag management through real React and Ant Design', () => {
    it('keeps checkbox deletion selection separate from single-target editing, including equal IDs', async () => {
        await loaded();
        fireEvent.click(screen.getByText('TypeScript'));
        expect((screen.getByLabelText('标签名称') as HTMLInputElement).value).toBe('TypeScript');
        const parent = screen.getAllByRole('treeitem').find(item => within(item).queryByText('编程'))!;
        fireEvent.click(parent.querySelector('.ant-tree-checkbox')!);
        expect((screen.getByLabelText('标签名称') as HTMLInputElement).value).toBe('TypeScript');
        expect((screen.getByRole('button', { name: '保存修改' }) as HTMLButtonElement).disabled).toBe(false);
        fireEvent.change(screen.getByLabelText('标签名称'), { target: { value: 'TS 新名字' } });
        fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
        await waitFor(() => expect(api.updateTwo).toHaveBeenCalledWith(7, { title: 'TS 新名字', color: '#52c41a' }));
        expect(api.updateOne).not.toHaveBeenCalled();
        expect(api.addOne).not.toHaveBeenCalled();
        expect(api.addTwo).not.toHaveBeenCalled();
    });
    it('retains typed values on HTTP-200 business failure and prevents overlapping writes', async () => {
        await loaded();
        fireEvent.click(screen.getByText('编程'));
        fireEvent.change(screen.getByLabelText('标签名称'), { target: { value: '保留这个名字' } });
        const pending = deferred<typeof success>();
        api.updateOne.mockReturnValueOnce(pending.promise);
        const save = screen.getByRole('button', { name: '保存修改' });
        fireEvent.click(save);
        fireEvent.click(save);
        await waitFor(() => expect(api.updateOne).toHaveBeenCalledTimes(1));
        pending.resolve({ status: 200, data: { code: 500, message: '名称已存在', data: '' } });
        await screen.findByText('名称已存在');
        expect((screen.getByLabelText('标签名称') as HTMLInputElement).value).toBe('保留这个名字');
        expect(screen.getByRole('heading', { name: '编辑主标签「编程」' })).toBeTruthy();
    });
    it('requires explicit child creation, inherits parent color and submits parent ID', async () => {
        await loaded();
        fireEvent.click(screen.getByText('编程'));
        fireEvent.click(screen.getByRole('button', { name: /在此主标签下新建子标签/ }));
        fireEvent.change(screen.getByLabelText('标签名称'), { target: { value: 'React' } });
        fireEvent.click(screen.getByRole('button', { name: '创建标签' }));
        await waitFor(() => expect(api.addTwo).toHaveBeenCalledWith({ title: 'React', color: '#1677ff', fatherTag: 7 }));
        expect(api.updateOne).not.toHaveBeenCalled();
    });
    it('warns about cascade deletion and sends a level-specific delete after confirmation', async () => {
        await loaded();
        const parent = screen.getAllByRole('treeitem').find(item => within(item).queryByText('编程'))!;
        fireEvent.click(parent.querySelector('.ant-tree-checkbox')!);
        fireEvent.click(screen.getByRole('button', { name: '删除所选标签' }));
        expect(api.del).not.toHaveBeenCalled();
        await screen.findByText(/主标签下的 1 个子标签也会删除：TypeScript/);
        fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
        await waitFor(() => expect(api.del).toHaveBeenCalledWith('one', [7]));
        expect(api.del).toHaveBeenCalledTimes(1);
    });
    it('keeps a missing edit target blocked instead of silently creating a new tag', async () => {
        await loaded();
        fireEvent.click(screen.getByText('TypeScript'));
        api.load.mockResolvedValueOnce([]);
        fireEvent.click(screen.getByRole('button', { name: /刷新标签/ }));
        await screen.findByText('此标签已不在列表中，不能保存。请另选标签或点击新建。');
        expect((screen.getByRole('button', { name: '保存修改' }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByLabelText('标签名称') as HTMLInputElement).value).toBe('TypeScript');
        expect(api.addOne).not.toHaveBeenCalled();
        expect(api.addTwo).not.toHaveBeenCalled();
    });

    it('deletes unrelated mixed-level selections through separate tables without deleting a same-ID child twice', async () => {
        api.load.mockResolvedValue([...initial, { key: 8, title: '生活', level: 1, color: '#a36b94', children: [{ key: 9, title: '随笔', level: 2, fatherKey: 8, fatherTag: '生活', color: '#a36b94' }] }]);
        await loaded();
        for (const title of ['编程', '随笔']) {
            const row = screen.getAllByRole('treeitem').find(item => within(item).queryByText(title))!;
            fireEvent.click(row.querySelector('.ant-tree-checkbox')!);
        }
        fireEvent.click(screen.getByRole('button', { name: '删除所选标签' }));
        fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));
        await waitFor(() => expect(api.del).toHaveBeenCalledTimes(2));
        expect(api.del).toHaveBeenNthCalledWith(1, 'two', [9]);
        expect(api.del).toHaveBeenNthCalledWith(2, 'one', [7]);
    });

});

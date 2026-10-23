import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { StyleProvider } from '@ant-design/cssinjs/lib/index.js';
import NoteTagSelect from '../../src/components/NoteTagSelect';
import { createCatalogStore } from '../helpers/catalogStore';
import { deferred } from '../helpers/deferred';
const api = vi.hoisted(() => ({ create: vi.fn(), http: vi.fn() }));
vi.mock('../../src/apis/axios', () => ({ default: api.http }));
vi.mock('../../src/apis/TagMethods', async original => ({ ...await original<typeof import('../../src/apis/TagMethods')>(), addTagOne: api.create }));
const reply = (code: number, data: unknown, message = '') => ({ status: 200, data: { code, data, message } });
beforeEach(() => {
    vi.resetAllMocks();
    const nativeStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => nativeStyle(element));
    vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
async function show() {
    const onChange = vi.fn();
    render(<Provider store={createCatalogStore()}><StyleProvider mock="server" container={document.createElement('div')}><NoteTagSelect value={[]} onChange={onChange} /></StyleProvider></Provider>);
    fireEvent.mouseDown(screen.getByRole('combobox').closest('.ant-select-selector')!);
    const input = await screen.findByPlaceholderText('新建一级标签，如「后端」');
    fireEvent.change(input, { target: { value: '新标签' } });
    return { input, onChange, button: screen.getByRole('button', { name: /新\s*建/ }) };
}
describe('inline tag creation distinguishes writes from following reads', () => {
    it('keeps input and rejects duplicate clicks while a business failure is pending', async () => {
        const pending = deferred<ReturnType<typeof reply>>();
        api.create.mockReturnValueOnce(pending.promise);
        const { input, button, onChange } = await show();
        fireEvent.click(button); fireEvent.click(button);
        expect(api.create).toHaveBeenCalledTimes(1);
        pending.resolve(reply(500, null, '同名标签已存在'));
        await screen.findByText('同名标签已存在');
        expect(input).toHaveProperty('value', '新标签');
        expect(api.http).not.toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();
    });
    it('does not report a confirmed creation as failed when refreshing the dictionary fails', async () => {
        api.create.mockResolvedValueOnce(reply(200, 8));
        api.http.mockRejectedValue(new Error('offline'));
        const { input, button, onChange } = await show();
        fireEvent.click(button);
        await screen.findByText('标签「新标签」已创建，列表刷新失败，请刷新后选择');
        expect(input).toHaveProperty('value', '');
        expect(api.create).toHaveBeenCalledTimes(1);
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.queryByText('新建失败（标签名可能已存在）')).toBeNull();
    });
    it('refreshes the shared dictionary and selects the confirmed new ID', async () => {
        api.create.mockResolvedValueOnce(reply(200, 8));
        api.http.mockResolvedValueOnce(reply(200, [{ tagKey: 8, title: '新标签', color: '#1677ff', level: 1 }])).mockResolvedValueOnce(reply(200, []));
        const { button, onChange } = await show();
        fireEvent.click(button);
        await waitFor(() => expect(onChange).toHaveBeenCalledWith([8]));
    });
});

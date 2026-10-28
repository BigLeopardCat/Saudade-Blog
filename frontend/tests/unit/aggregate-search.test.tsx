import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { StyleProvider } from '@ant-design/cssinjs/lib/index.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import AggregateSearch from '../../src/components/AggregateSearch';
import { createCatalogStore } from '../helpers/catalogStore';
import { deferred } from '../helpers/deferred';
import { allHits, hitTarget, hitsOf, TYPE_LABEL, TYPE_ORDER } from '../../src/frontHome/Head/aggregate';
import type { AggregateHit } from '../../src/frontHome/Head/aggregate';
import { highlightParts } from '../../src/components/AggregateSearch/highlight';
const api = vi.hoisted(() => vi.fn());
vi.mock('../../src/apis/axios', () => ({ default: api }));
const hit = (key: number, title: string, type: AggregateHit['type'] = 'note'): AggregateHit => ({ key, title, type, snippet: '<img src=x onerror=alert(1)> 部署 C++', author: '作者', createTime: '', noteId: 5 });
const response = (notes: AggregateHit[] = [], extra = {}) => ({ status: 200, data: { code: 200, message: '', data: { total: notes.length, counts: { note: notes.length, talk: 0, board: 0, comment: 0 }, notes, talks: [], board: [], comments: [], terms: ['部署', 'C++'], hasMore: false, ...extra } } });
function mount() {
    const onOpen = vi.fn();
    return { ...render(<Provider store={createCatalogStore()}><StyleProvider mock="server"><AggregateSearch onOpen={onOpen} /></StyleProvider></Provider>), onOpen };
}
function input(value: string) { fireEvent.change(screen.getByRole('combobox'), { target: { value } }); }
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(310); }); }
beforeAll(() => {
    window.matchMedia = () => ({ matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true });
    const computed = window.getComputedStyle.bind(window); window.getComputedStyle = element => computed(element);
});
beforeEach(() => api.mockReset());
afterEach(() => vi.useRealTimers());
describe('aggregate search model and literal highlighting', () => {
    it('preserves routes, type order and server ranking', () => {
        expect(TYPE_ORDER.map(type => TYPE_LABEL[type])).toEqual(['文章', '说说', '留言', '评论']);
        expect(TYPE_ORDER.map(type => hitTarget(hit(9, '', type)))).toEqual(['/article/9', '/talk?tk=9', '/guestbook?lid=9', '/article/5?cid=9']);
        expect(hitTarget({ ...hit(9, '', 'comment'), noteId: null })).toBe('/');
        const data = response([hit(2, ''), hit(1, '')]).data.data;
        expect(allHits(data).map(row => row.key)).toEqual([2, 1]); expect(hitsOf(data, 'board')).toEqual([]);
    });
    it('escapes regex metacharacters and leaves HTML as text', () => {
        const text = '<img> C++ [x] 部署 React';
        const parts = highlightParts(text, ['C++', '[x]', '部署', 'react', '', 'C++']);
        expect(parts.map(part => part.text).join('')).toBe(text);
        expect(parts.filter(part => part.match).map(part => part.text)).toEqual(['C++', '[x]', '部署', 'React']);
        expect(highlightParts('博客部署', ['博客', '博客部署']).filter(part => part.match).map(part => part.text)).toEqual(['博客部署']);
    });
});
describe('real React and RTK Query search', () => {
    it('hides obsolete rows, aborts requests and cancels on unmount', async () => {
        vi.useFakeTimers(); const first = deferred<ReturnType<typeof response>>(), second = deferred<ReturnType<typeof response>>();
        api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const view = mount(); input('旧查询'); await tick();
        const signal = api.mock.calls[0][0].signal as AbortSignal; input('新查询'); expect(signal.aborted).toBe(true);
        await act(async () => { first.resolve(response([hit(1, '旧结果')])); });
        expect(screen.queryByRole('option')).toBeNull(); await tick();
        expect(api.mock.calls[1][0].data.keyword).toBe('新查询'); view.unmount();
        expect(api.mock.calls[1][0].signal.aborted).toBe(true);
        await act(async () => { second.resolve(response([hit(2, '新结果')])); });
    });
    it('supports keyboard selection, safe markup and synchronous invalidation', async () => {
        api.mockResolvedValue(response([hit(1, '部署一'), hit(2, '部署二')]));
        const { onOpen } = mount(); input('部署'); fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
        await screen.findByRole('option', { name: /部署\s*一/ }); expect(document.querySelector('.search-item img')).toBeNull();
        expect(document.querySelectorAll('.search-item mark').length).toBeGreaterThan(0);
        fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' }); fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
        expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: 2 })); input('别的'); expect(screen.queryByRole('option')).toBeNull();
    });
    it('waits for Chinese composition and cancels debounce on close', async () => {
        vi.useFakeTimers(); const view = mount(); fireEvent.compositionStart(screen.getByRole('combobox')); input('博客'); await tick();
        fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', isComposing: true }); expect(api).not.toHaveBeenCalled();
        fireEvent.compositionEnd(screen.getByRole('combobox')); view.unmount(); await tick(); expect(api).not.toHaveBeenCalled();
    });
    it('paginates on server and resets page for type filters', async () => {
        api.mockResolvedValue(response([hit(1, '部署')], { total: 42, counts: { note: 42, talk: 0, board: 0, comment: 0 }, hasMore: true }));
        mount(); input('博客'); fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
        await screen.findByText('第 1 页，本页 1 条，共 42 条'); fireEvent.click(screen.getByRole('button', { name: '下一页' }));
        await waitFor(() => expect(api.mock.calls[api.mock.calls.length - 1]?.[0].data.page).toBe(2)); await screen.findByText('第 2 页，本页 1 条，共 42 条');
        fireEvent.click(screen.getByRole('button', { name: /评论（/ }));
        await waitFor(() => expect(api.mock.calls[api.mock.calls.length - 1]?.[0].data).toEqual({ keyword: '博客', page: 1, pageSize: 20, type: 'comment' }));
    });
    it('distinguishes business failure from no matches and retries', async () => {
        api.mockResolvedValueOnce({ status: 200, data: { code: 500, message: '搜索暂时不可用' } }).mockResolvedValue(response());
        mount(); input('博客'); fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
        expect((await screen.findByRole('alert')).textContent).toMatch(/搜索暂时不可用重\s*试/); expect(screen.queryByText('未找到相关内容')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /重\s*试/ })); await screen.findByText('未找到相关内容');
    });
});


it('reuses visited type pages without clearing the overview or searching again', async () => {
    api.mockResolvedValue(response([hit(1, '部署文章')], {talks: [hit(2, '部署说说', 'talk')], counts:{note:1,talk:1,board:0,comment:0},total:2}));
    mount(); input('部署'); fireEvent.keyDown(screen.getByRole('combobox'), {key:'Enter'});
    await screen.findByRole('option', {name:/部署\s*说说/});
    fireEvent.click(screen.getByRole('button', {name:/说说（/}));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    await screen.findByRole('option', {name:/部署\s*说说/});
    fireEvent.click(screen.getByRole('button', {name:'全部'}));
    await screen.findByRole('option', {name:/部署\s*文章/});
    expect(api).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', {name:/说说（/}));
    await screen.findByRole('option', {name:/部署\s*说说/});
    expect(api).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', {name:'清空搜索'}));
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('option')).toBeNull();
});

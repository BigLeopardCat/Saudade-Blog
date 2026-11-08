import { describe, expect, it } from 'vitest';
import * as S from '../../src/pages/Dashboard/Notes/AllNotes/listState';
import {normalizeNoteRows} from '../../src/utils/noteRows';

const defaults = S.DEFAULT_LIST_QUERY;

describe('article list URL state', () => {
    it('round-trips all filters without adding empty/default URL parameters', () => {
        expect(S.parseListQuery('')).toEqual(defaults);
        expect(S.parseListQuery('?')).toEqual(defaults);
        expect(S.buildListQuery(defaults)).toBe('');
        const full: S.ListQuery = { ...defaults, tab: '2', page: 3, size: 20, kw: '架构', title: '文档', cat: '技术', top: '1', from: '2026-01-01', to: '2026-02-02', tags: [3, 7] };
        expect(S.parseListQuery(S.buildListQuery(full))).toEqual(full);
        const params = new URLSearchParams(S.buildListQuery({ ...defaults, title: '', cat: '', top: '' }));
        for (const key of ['title', 'cat', 'top', 'tags', 'page', 'tab', 'size']) expect(params.has(key)).toBe(false);
        expect(S.mergeListQuery(full, { page: 4, title: '' })).toEqual({ ...full, page: 4, title: '' });
        expect(full.page).toBe(3);
    });

    it.each(['0', '-3', 'abc', '2.5'])('rejects invalid page %s', (page) => {
        expect(S.parseListQuery(`?page=${page}`).page).toBe(1);
    });
    it('validates tab, size, top and date shapes, preserving historical deep links', () => {
        expect(S.parseListQuery('?tab=9&size=7&top=7&from=2026-1-1')).toMatchObject({ tab: '1', size: S.LIST_PAGE_SIZE, top: '', from: '' });
        for (const size of [0, -5]) expect(S.parseListQuery(`?size=${size}`).size).toBe(S.LIST_PAGE_SIZE);
        for (const size of [20, 50]) expect(S.parseListQuery(S.buildListQuery({ ...defaults, size })).size).toBe(size);
        for (const tab of ['2', '3', '4'] as const) expect(S.parseListQuery(S.buildListQuery({ ...defaults, tab })).tab).toBe(tab);
        expect(S.parseListQuery('?from=2026-01-01').from).toBe('2026-01-01');
        expect(S.parseListQuery('?keyword=测试&tab=3&page=2')).toMatchObject({ kw: '测试', tab: '3', page: 2 });
        expect(S.parseListQuery('?kw=a&keyword=b').kw).toBe('a');
    });

    it('normalizes actual page rows and rejects failed response shapes', () => {
        const rows = normalizeNoteRows([{noteKey: 1, noteTags: '1,2'}, {noteKey: 2, noteTags: null}]);
        expect(rows.map(row => row.key)).toEqual([1, 2]);
        expect(rows.map(row => row.noteTags)).toEqual([[1, 2], []]);
        expect(() => normalizeNoteRows(null)).toThrow();
        expect(() => normalizeNoteRows({})).toThrow();
    });

    it('sends paging and every filter to the backend instead of filtering a partial page', () => {
        expect(S.listRequest({...defaults, page: 3, size: 50, tags: [1, 2]}))
            .toEqual({page: 3, page_size: 50, tags: '1,2'});
        expect(S.listRequest({...defaults, tab: '4', kw: '正文', title: '标题', cat: '分类',
            top: '0', from: '2026-01-01', to: '2026-01-31'})).toEqual({
            page: 1, page_size: 10, status: 'public', keyword: '正文', title: '标题',
            categories: '分类', is_top: 0, start_date: '2026-01-01', end_date: '2026-01-31',
        });
        expect(S.listRequest({...defaults, tab: '3'}).status).toBe('draft');
        expect(S.listRequest({...defaults, tab: '2'}).status).toBe('private');
        expect(S.listRequest({...defaults, page: 2}).page).toBe(2);
        expect(S.listRequest(defaults)).toEqual({page: 1, page_size: 10});
    });

    it('restores safe editor return tickets, including an empty query, and rejects URLs', () => {
        expect(S.readListReturn()).toBeNull();
        for (const ticket of ['?tab=2&page=3', '', 'tab=4']) {
            S.saveListReturn(ticket);
            expect(S.readListReturn()).toBe(ticket);
        }
        for (const bad of ['{"恶意":"对象"}', 'https://evil.example/']) {
            sessionStorage.setItem(S.LIST_RETURN_KEY, bad);
            expect(S.readListReturn()).toBeNull();
        }
    });
});

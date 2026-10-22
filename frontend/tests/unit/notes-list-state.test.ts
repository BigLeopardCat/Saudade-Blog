import { describe, expect, it } from 'vitest';
import * as S from '../../src/pages/Dashboard/Notes/AllNotes/listState';

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

    it.each([
        [5, 10, 8, 2], [1, 0, 8, 1], [3, 0, 8, 1], [2, 16, 8, 2],
        [9, 17, 8, 3], [0, 17, 8, 1], [NaN, 17, 8, 1], [2, 17, 0, 2],
    ])('clamps visible page %s for %s rows without mutating saved state', (page, total, size, expected) => {
        expect(S.clampPage(page, total, size)).toBe(expected);
        expect(defaults.page).toBe(1);
    });
    it('slices the clamped page and preserves row references', () => {
        const rows = Array.from({ length: 19 }, (_, i) => ({ key: i + 1 }));
        expect(S.pageSlice(rows, 1, 8).map(row => row.key)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(S.pageSlice(rows, 3, 8).map(row => row.key)).toEqual([17, 18, 19]);
        expect(S.pageSlice(rows, 9, 8)).toEqual(S.pageSlice(rows, 3, 8));
        expect(S.pageSlice(rows, 9, 8)[0]).toBe(rows[16]);
    });

    it('normalizes legacy tags, patches only the target, and filters by any selected tag', () => {
        const rows = S.normalizeNoteRows([
            { noteKey: 1, noteTags: '1,2', status: 'public' },
            { noteKey: 2, noteTags: '3,3,,5,' }, { noteKey: 3, noteTags: null },
            { noteKey: 4 }, { noteKey: 5, noteTags: [7, '8'] }, { noteKey: 6, noteTags: '' },
        ]);
        expect(rows.map(row => row.key)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(rows.map(row => row.noteTags)).toEqual([[1, 2], [3, 5], [], [], [7, 8], []]);
        expect(S.normalizeNoteRows(null)).toEqual([]);
        expect(S.normalizeNoteRows({})).toEqual([]);
        const next = S.patchRow(rows, 1, { status: 'private', isTop: 1, noteTags: [9] });
        expect(next[0]).toMatchObject({ key: 1, status: 'private', isTop: 1, noteTags: [9] });
        expect(next[1]).toBe(rows[1]);
        expect(rows[0].status).toBe('public');
        expect(S.patchRow(rows, 99, { status: 'private' })).toBe(rows);
        expect(S.filterRowsByTags(rows, [])).toBe(rows);
        expect(S.filterRowsByTags(rows, [3]).map(row => row.key)).toEqual([2]);
        expect(S.filterRowsByTags(rows, [1, 3]).map(row => row.key)).toEqual([1, 2]);
        expect(S.filterRowsByTags(rows, [99])).toEqual([]);
    });

    it.each<[Partial<S.ListQuery>, S.ListRequest]>([
        [{}, { mode: 'list' }], [{ tags: [1, 2], page: 5 }, { mode: 'list' }],
        [{ tab: '2' }, { mode: 'search', body: { status: 'private' } }],
        [{ tab: '3' }, { mode: 'search', body: { status: 'draft' } }],
        [{ tab: '4', page: 3 }, { mode: 'search', body: { only_public: true } }],
        [{ tab: '4', kw: '架构', cat: '技术' }, { mode: 'search', body: { only_public: true, keyword: '架构', categories: '技术' } }],
        [{ kw: '架构' }, { mode: 'search', body: { keyword: '架构' } }],
        [{ tab: '2', title: '文档' }, { mode: 'search', body: { title: '文档', status: 'private' } }],
        [{ top: '1' }, { mode: 'search', body: { is_top: 1 } }],
        [{ top: '0' }, { mode: 'search', body: { is_top: 0 } }],
        [{ cat: '技术', from: '2026-01-01', to: '2026-01-31' }, { mode: 'search', body: { categories: '技术', start_date: '2026-01-01', end_date: '2026-01-31' } }],
    ])('translates filters to backend request contracts: %j', (patch, expected) => {
        expect(S.listRequest({ ...defaults, ...patch })).toEqual(expected);
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

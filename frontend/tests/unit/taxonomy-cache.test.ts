import {describe, expect, it, vi} from 'vitest';
import {configureStore} from '@reduxjs/toolkit';
import categories, {fetchCategories, setCategories} from '../../src/store/components/categories';
import tags, {fetchTags, setTags} from '../../src/store/components/tags';
const {readCategory, http} = vi.hoisted(() => ({readCategory: vi.fn(), http: vi.fn()}));
vi.mock('../../src/apis/CategoryMethods.tsx', () => ({getCategories: readCategory}));
vi.mock('../../src/apis/axios.tsx', () => ({default: http}));
const envelope = (data: unknown, code = 200) => ({data: {code, data}});
describe('taxonomy reads preserve last good state', () => {
    it.each([envelope([], 500), envelope(null), Error('offline')])('preserves categories on failure: %s', async response => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const store = configureStore({reducer: categories});
        store.dispatch(setCategories([{key: 1, categoryTitle: '已有分类'}] as never));
        if (response instanceof Error) readCategory.mockRejectedValueOnce(response);
        else readCategory.mockResolvedValueOnce(response);
        expect(await store.dispatch(fetchCategories())).toBe(false);
        expect(store.getState().categories).toHaveLength(1);
    });
    it.each(['parents', 'children', 'network'])('commits neither tags nor count after %s fails', async failure => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const store = configureStore({reducer: tags});
        store.dispatch(setTags([{key: 9, title: '已有标签', children: []}] as never));
        if (failure === 'network') http.mockRejectedValueOnce(Error('offline'));
        else if (failure === 'parents') http.mockResolvedValueOnce(envelope([], 500));
        else http.mockResolvedValueOnce(envelope([{tagKey: 1, title: '父标签'}])).mockResolvedValueOnce(envelope([], 500));
        expect(await store.dispatch(fetchTags())).toBe(false);
        expect(store.getState().tag[0].key).toBe(9);
        expect(store.getState().tagCount).toBe(0);
    });
    it('joins by stable parent ID without mutating response objects and accepts a real empty result', async () => {
        const parent = Object.freeze({tagKey: 1, title: '已改名'});
        const child = {fatherKey: 1, fatherTag: '旧名称', tagKey: 2};
        const store = configureStore({reducer: tags});
        http.mockResolvedValueOnce(envelope([parent])).mockResolvedValueOnce(envelope([child]));
        expect(await store.dispatch(fetchTags())).toBe(true);
        expect(store.getState().tag[0].children).toHaveLength(1);
        expect(store.getState().tagCount).toBe(2);
        http.mockResolvedValueOnce(envelope([])).mockResolvedValueOnce(envelope([]));
        expect(await store.dispatch(fetchTags())).toBe(true);
        expect(store.getState().tag).toEqual([]);
        readCategory.mockResolvedValueOnce(envelope([]));
        const categoryStore = configureStore({reducer: categories});
        expect(await categoryStore.dispatch(fetchCategories())).toBe(true);
        expect(categoryStore.getState().categoryCount).toBe(0);
    });
});

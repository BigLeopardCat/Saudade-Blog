import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCategories } from '../../src/store/components/categories';
import { fetchTags } from '../../src/store/components/tags';
import { catalogApi } from '../../src/store/catalogApi';
import { createCatalogStore } from '../helpers/catalogStore';
import { deferred } from '../helpers/deferred';
const { readCategory, http } = vi.hoisted(() => ({ readCategory: vi.fn(), http: vi.fn() }));
vi.mock('../../src/apis/CategoryMethods', () => ({ getCategories: readCategory }));
vi.mock('../../src/apis/axios', () => ({ default: http }));
const envelope = (data: unknown, code = 200) => ({ status: 200, data: { code, data } });
const category = { categoryKey: 1, categoryTitle: '已有分类' };
beforeEach(() => vi.resetAllMocks());

describe('shared taxonomy queries and compatible Redux consumers', () => {
    it.each([envelope([], 500), envelope(null), Error('offline')])('retains last confirmed categories on failed refresh: %s', async failure => {
        const store = createCatalogStore();
        readCategory.mockResolvedValueOnce(envelope([category]));
        await store.dispatch(fetchCategories()).unwrap();
        if (failure instanceof Error) readCategory.mockRejectedValueOnce(failure);
        else readCategory.mockResolvedValueOnce(failure);
        await expect(store.dispatch(fetchCategories(true)).unwrap()).rejects.toBeTruthy();
        expect(store.getState().categories.categories[0].categoryTitle).toBe('已有分类');
        expect(catalogApi.endpoints.categories.select()(store.getState()).data).toHaveLength(1);
    });
    it('deduplicates concurrent initialization and reuses cached data across consumers', async () => {
        const store = createCatalogStore();
        const pending = deferred<ReturnType<typeof envelope>>();
        readCategory.mockReturnValueOnce(pending.promise);
        const first = store.dispatch(fetchCategories());
        const second = store.dispatch(fetchCategories());
        expect(readCategory).toHaveBeenCalledTimes(1);
        pending.resolve(envelope([category]));
        await Promise.all([first.unwrap(), second.unwrap()]);
        await store.dispatch(fetchCategories()).unwrap();
        expect(readCategory).toHaveBeenCalledTimes(1);
        expect(store.getState().categories.categories[0].key).toBe(1);
    });
    it('revalidates after a write even when an older read was already pending', async () => {
        const store = createCatalogStore();
        const oldRead = deferred<ReturnType<typeof envelope>>();
        readCategory.mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(envelope([{ ...category, categoryTitle: '写入后的新分类' }]));
        const subscription = store.dispatch(catalogApi.endpoints.categories.initiate());
        store.dispatch(catalogApi.util.invalidateTags(['Categories']));
        oldRead.resolve(envelope([category]));
        await subscription.unwrap();
        await vi.waitFor(() => expect(store.getState().categories.categories[0].categoryTitle).toBe('写入后的新分类'));
        expect(readCategory).toHaveBeenCalledTimes(2);
        subscription.unsubscribe();
    });
    it.each(['parents', 'children', 'network'])('keeps both tag levels and counts when %s refresh fails', async failure => {
        const store = createCatalogStore();
        const parent = Object.freeze({ tagKey: 1, title: '改名后的主标签', level: 1, color: '#123456' });
        http.mockResolvedValueOnce(envelope([parent])).mockResolvedValueOnce(envelope([{ tagKey: 2, fatherKey: 1, fatherTag: '旧名称', title: '子标签', level: 2 }]));
        await store.dispatch(fetchTags()).unwrap();
        expect(store.getState().tags.tag[0].children[0].key).toBe(2);
        expect(store.getState().tags.tagCount).toBe(2);
        if (failure === 'network') http.mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(envelope([]));
        else http.mockResolvedValueOnce(envelope([], failure === 'parents' ? 500 : 200)).mockResolvedValueOnce(envelope([], failure === 'children' ? 500 : 200));
        await expect(store.dispatch(fetchTags(true)).unwrap()).rejects.toBeTruthy();
        expect(store.getState().tags.tag[0].key).toBe(1);
        expect(store.getState().tags.tagCount).toBe(2);
    });
    it('commits a confirmed empty taxonomy rather than retaining deleted entries', async () => {
        const store = createCatalogStore();
        readCategory.mockResolvedValueOnce(envelope([category])).mockResolvedValueOnce(envelope([]));
        await store.dispatch(fetchCategories()).unwrap();
        await store.dispatch(fetchCategories(true)).unwrap();
        expect(store.getState().categories.categories).toEqual([]);
        expect(store.getState().categories.categoryCount).toBe(0);
        http.mockResolvedValueOnce(envelope([])).mockResolvedValueOnce(envelope([]));
        await store.dispatch(fetchTags()).unwrap();
        expect(store.getState().tags.tag).toEqual([]);
        expect(store.getState().tags.tagCount).toBe(0);
    });
});

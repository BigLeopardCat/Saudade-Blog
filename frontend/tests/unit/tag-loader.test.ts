import { beforeEach, describe, expect, it, vi } from 'vitest';
const { http } = vi.hoisted(() => ({ http: vi.fn() }));
vi.mock('../../src/apis/axios', () => ({ default: http }));
import { loadTags } from '../../src/apis/catalogReads';
const wrap = (data: unknown, code = 200) => ({ status: 200, data: { code, message: '', data } });
beforeEach(() => http.mockReset());
describe('strict tag tree loading', () => {
    it('uses parent IDs across renamed or same-name groups, preserving level-specific IDs', async () => {
        http.mockResolvedValueOnce(wrap([{ tagKey: 7, title: '改名主标签', level: 1 }, { tagKey: 8, title: '改名主标签', level: 1 }]))
            .mockResolvedValueOnce(wrap([{ tagKey: 7, title: '子标签', level: 2, fatherKey: 7, fatherTag: '旧名字' }]));
        const tree = await loadTags();
        expect(tree[0].children.map(child => child.key)).toEqual([7]);
        expect(tree[1].children).toEqual([]);
        expect(tree[0].key).toBe(7);
    });
    it.each([wrap([], 500), wrap({ unexpected: true })])('rejects failed or malformed envelope %j instead of returning a misleading empty tree', async failure => {
        http.mockResolvedValueOnce(wrap([])).mockResolvedValueOnce(failure);
        await expect(loadTags()).rejects.toThrow();
    });
    it('rejects network failure', async () => {
        http.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(wrap([]));
        await expect(loadTags()).rejects.toThrow('offline');
    });
});

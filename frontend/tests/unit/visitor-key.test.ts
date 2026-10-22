import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageKey = 'saudade.visitorKey';
async function fresh() {
    vi.resetModules();
    return import('../../src/utils/visitorKey');
}

beforeEach(() => vi.resetModules());

describe('anonymous visitor identity', () => {
    it('persists a random valid key across calls and module reloads', async () => {
        const { getVisitorKey, isValidVisitorKey } = await fresh();
        const key = getVisitorKey();
        expect(isValidVisitorKey(key)).toBe(true);
        expect(localStorage.getItem(storageKey)).toBe(key);
        expect(getVisitorKey()).toBe(key);
        expect((await fresh()).getVisitorKey()).toBe(key);
    });
    it.each(['', 'short', 'abc', 'has space', 'a'.repeat(65), '汉字不是合法字符集', '<script>'])('replaces invalid stored value %j', async (bad) => {
        localStorage.setItem(storageKey, bad);
        const { getVisitorKey, isValidVisitorKey } = await fresh();
        const key = getVisitorKey();
        expect(isValidVisitorKey(key)).toBe(true);
        expect(key).not.toBe(bad);
        expect(localStorage.getItem(storageKey)).toBe(key);
    });
    it('keeps one ephemeral identity per page when storage throws', async () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked'); });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
        const module = await fresh();
        const first = module.getVisitorKey();
        expect(module.isValidVisitorKey(first)).toBe(true);
        expect(module.getVisitorKey()).toBe(first);
        expect((await fresh()).getVisitorKey()).not.toBe(first);
    });
    it.each(['01234567', 'a'.repeat(64), 'aBcD-123_xyz', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'])('accepts backend whitelist key %j', async (value) => {
        expect((await fresh()).isValidVisitorKey(value)).toBe(true);
    });
    it.each(['a'.repeat(7), 'a'.repeat(65), 'has space', '中文', 'semi;colon', '', 'a.b'])('rejects invalid key %j', async (value) => {
        expect((await fresh()).isValidVisitorKey(value)).toBe(false);
    });
    it('uses secure random bytes where randomUUID is unavailable', async () => {
        vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(171) });
        expect((await fresh()).getVisitorKey()).toBe('ab'.repeat(16));
    });
    it('can still supply a valid stable identifier on old browsers with no crypto', async () => {
        vi.stubGlobal('crypto', undefined);
        const module = await fresh();
        const key = module.getVisitorKey();
        expect(module.isValidVisitorKey(key)).toBe(true);
        expect(module.getVisitorKey()).toBe(key);
    });
});

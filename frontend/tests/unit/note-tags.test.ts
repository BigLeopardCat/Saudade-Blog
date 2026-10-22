import { describe, expect, it } from 'vitest';
import { joinNoteTags, parseNoteTags, sameTagSet } from '../../src/utils/noteTags';

describe('legacy note tag serialization', () => {
    it.each([
        ['1,2,3', [1, 2, 3]], ['1,1,2,', [1, 2]], ['', []], [null, []], [undefined, []],
        [' 4 , 5 ', [4, 5]], ['12abc,0,-3,NaN', []], [[1, '2', 2], [1, 2]],
    ])('normalizes %j without accepting partially numeric IDs', (raw, expected) => {
        expect(parseNoteTags(raw)).toEqual(expected);
    });
    it('writes explicit empty selections and preserves chosen order while deduplicating', () => {
        expect(joinNoteTags([3, 1, 3])).toBe('3,1');
        expect(joinNoteTags([])).toBe('');
        expect(joinNoteTags(null)).toBe('');
        expect(sameTagSet([1, 2], [2, 1])).toBe(true);
        expect(sameTagSet([1, 2], [1, 2, 3])).toBe(false);
    });
});

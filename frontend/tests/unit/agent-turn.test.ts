import {describe, expect, it} from 'vitest'
import {hasArticleInvalidation} from '../../src/components/UserCenter/agentTurn'

describe('article invalidation hints', () => {
    it('ignores chat, read-only and prepare-only turns, and malformed IDs', () => {
        expect(hasArticleInvalidation(new Event('agent-turn-done'))).toBe(false)
        for (const detail of [undefined, {}, {confirmationAttempted: false, articleIdsToRefresh: [1]},
            {confirmationAttempted: true, articleIdsToRefresh: []},
            {confirmationAttempted: true, articleIdsToRefresh: ['1', -1, 0, 1.5, NaN]}]) {
            expect(hasArticleInvalidation(new CustomEvent('agent-turn-done', {detail}))).toBe(false)
        }
    })
    it('revalidates a confirmed attempt without treating the hint as execution proof', () => {
        expect(hasArticleInvalidation(new CustomEvent('agent-turn-done', {detail: {
            confirmationAttempted: true, articleIdsToRefresh: [42],
        }}))).toBe(true)
    })
})

import { describe, expect, it, vi } from 'vitest'
import { createArticleFeed, requireArticleRows } from '../../src/frontHome/Content/ContentHome/articleFeed'

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}
function setup(request: (page: number, size: number) => Promise<string[]>) {
    const commit = vi.fn()
    const feed = createArticleFeed(request, { items: ['cached'], page: 1, pageSize: 2, hasMore: true, loaded: true }, commit)
    return { feed, commit }
}

describe('homepage API envelope', () => {
    it('accepts confirmed empty results and rejects business errors or malformed payloads', () => {
        expect(requireArticleRows({ data: { code: 200, data: [] } })).toEqual([])
        expect(() => requireArticleRows({ data: { code: 500, data: [] } })).toThrow()
        expect(() => requireArticleRows({ data: { code: 200, data: null } })).toThrow()
        expect(() => requireArticleRows({})).toThrow()
    })
})

describe('homepage paging', () => {
    it('keeps data, offset, hasMore and cache unchanged on failure; retries the exact failed page', async () => {
        const request = vi.fn<(page: number, size: number) => Promise<string[]>>()
            .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(['next'])
        const { feed, commit } = setup(request)
        await feed.more()
        expect(feed.snapshot()).toMatchObject({ items: ['cached'], page: 1, pageSize: 2, hasMore: true, pending: false, error: expect.any(String) })
        expect(commit).not.toHaveBeenCalled()
        await feed.retry()
        expect(request.mock.calls).toEqual([[2, 2], [2, 2]])
        expect(feed.snapshot()).toMatchObject({ items: ['cached', 'next'], page: 2, hasMore: false, error: null })
        expect(commit).toHaveBeenCalledTimes(1)
    })

    it('does not cache a failed first page as an empty successful result', async () => {
        const request = vi.fn().mockResolvedValue({ data: { code: 500, data: [] } })
        const { feed, commit } = setup(async () => requireArticleRows(await request()) as string[])
        await feed.first(4)
        expect(feed.snapshot()).toMatchObject({ items: ['cached'], pageSize: 2, hasMore: true, error: expect.any(String) })
        expect(commit).not.toHaveBeenCalled()
    })

    it('deduplicates rapid More clicks before React can commit a render', async () => {
        const pending = deferred<string[]>()
        const request = vi.fn(() => pending.promise)
        const { feed } = setup(request)
        const first = feed.more()
        const second = feed.more()
        expect(first).toBe(second)
        pending.resolve(['b', 'c'])
        await first
        expect(request).toHaveBeenCalledTimes(1)
        expect(feed.snapshot()).toMatchObject({ items: ['cached', 'b', 'c'], page: 2 })
    })

    it('discards a late More response after a grid resize starts replacing the first page', async () => {
        const more = deferred<string[]>()
        const replace = deferred<string[]>()
        const { feed, commit } = setup((page) => page === 1 ? replace.promise : more.promise)
        const old = feed.more()
        const fresh = feed.first(4)
        replace.resolve(['fresh'])
        await fresh
        more.resolve(['stale'])
        await old
        expect(feed.snapshot()).toMatchObject({ items: ['fresh'], page: 1, pageSize: 4, hasMore: false })
        expect(commit).toHaveBeenCalledTimes(1)
    })

    it('keeps the newer resize pending when an older first-page request fails late', async () => {
        const old = deferred<string[]>()
        const fresh = deferred<string[]>()
        const { feed, commit } = setup((_page, size) => size === 2 ? old.promise : fresh.promise)
        const first = feed.first(2)
        const second = feed.first(4)
        old.reject(new Error('old failure'))
        await first
        expect(feed.snapshot()).toMatchObject({ pending: true, loading: true, error: null, items: ['cached'] })
        fresh.resolve(['latest'])
        await second
        expect(feed.snapshot()).toMatchObject({ pending: false, loading: false, pageSize: 4, items: ['latest'], error: null })
        expect(commit).toHaveBeenCalledTimes(1)
    })

    it('keeps a failed initial request retryable until a confirmed empty response arrives', async () => {
        const request = vi.fn<(page: number, size: number) => Promise<string[]>>()
            .mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce([])
        const commit = vi.fn()
        const feed = createArticleFeed(request, { items: [], page: 1, pageSize: 2, hasMore: true, loaded: false }, commit)
        await feed.first(2)
        expect(feed.snapshot()).toMatchObject({ loaded: false, hasMore: true, error: expect.any(String) })
        expect(commit).not.toHaveBeenCalled()
        await feed.retry()
        expect(feed.snapshot()).toMatchObject({ loaded: true, hasMore: false, error: null, items: [] })
        expect(commit).toHaveBeenCalledTimes(1)
    })

    it('retries failed resize before More, without mixing offsets from two page sizes', async () => {
        const request = vi.fn<(page: number, size: number) => Promise<string[]>>()
            .mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(['a', 'b', 'c', 'd']).mockResolvedValueOnce([])
        const { feed } = setup(request)
        await feed.first(4)
        await feed.more()
        await feed.more()
        expect(request.mock.calls).toEqual([[1, 4], [1, 4], [2, 4]])
        expect(feed.snapshot()).toMatchObject({ items: ['a', 'b', 'c', 'd'], page: 2, hasMore: false })
    })

    it('invalidates unmounted requests before they can mutate the session cache', async () => {
        const pending = deferred<string[]>()
        const { feed, commit } = setup(() => pending.promise)
        const first = feed.first(4)
        feed.invalidate()
        pending.resolve(['old mount'])
        await first
        expect(feed.snapshot()).toMatchObject({ items: ['cached'], pending: false })
        expect(commit).not.toHaveBeenCalled()
    })

    it('deduplicates first-page refresh and tracks silent requests without a spinner', async () => {
        const pending = deferred<string[]>()
        const { feed } = setup(() => pending.promise)
        const first = feed.first(2, true)
        expect(feed.first(2, true)).toBe(first)
        expect(feed.snapshot()).toMatchObject({ pending: true, loading: false })
        pending.resolve([])
        await first
        expect(feed.snapshot()).toMatchObject({ items: [], page: 1, loaded: true, hasMore: false })
    })
})

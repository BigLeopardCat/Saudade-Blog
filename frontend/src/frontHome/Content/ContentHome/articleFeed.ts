/** Only confirmed cursor responses may advance the feed or its session cache. */
export interface ArticlePage<T> { items: T[]; nextCursor: string | null }
export interface FeedState<T> {
    items: T[]
    page: number
    pageSize: number
    nextCursor: string | null
    hasMore: boolean
    loaded: boolean
    pending: boolean
    loading: boolean
    error: string | null
}

export function createArticleFeed<T>(
    request: (cursor: string | null, pageSize: number) => Promise<ArticlePage<T>>,
    initial: Pick<FeedState<T>, 'items' | 'page' | 'pageSize' | 'nextCursor' | 'hasMore' | 'loaded'>,
    commit: (state: FeedState<T>) => void,
    keyOf: (item: T) => PropertyKey,
) {
    let state: FeedState<T> = { ...initial, pending: false, loading: false, error: null }
    let generation = 0
    let active: { first: boolean; size: number; promise: Promise<void> } | null = null
    let failed: { first: boolean; size: number; refresh: boolean } | null = null
    let pendingRefresh: Promise<void> | null = null
    const listeners = new Set<(state: FeedState<T>) => void>()
    const update = (patch: Partial<FeedState<T>>) => {
        state = { ...state, ...patch }
        listeners.forEach(listener => listener(state))
    }
    const unique = (items: T[]) => [...new Map(items.map(item => [keyOf(item), item])).values()]
    const run = (first: boolean, size: number, silent = false, refresh = false): Promise<void> => {
        if (active && (!first || (active.first && active.size === size))) return active.promise
        const current = ++generation
        const loadedPages = refresh ? state.page : 1
        const after = first ? null : state.nextCursor
        failed = null
        update({ pending: true, loading: !silent, error: null })
        const promise = Promise.resolve().then(async () => {
            let cursor = after
            const items: T[] = []
            let pages = 0
            const visited = new Set<string>()
            for (; pages < loadedPages;) {
                const result = await request(cursor, size)
                if (current !== generation) return null
                if (result.nextCursor !== null && (result.nextCursor === cursor || visited.has(result.nextCursor))) {
                    throw new Error('Article cursor did not advance')
                }
                items.push(...result.items)
                ++pages
                cursor = result.nextCursor
                if (cursor === null) break
                visited.add(cursor)
            }
            return { items, cursor, pages }
        }).then(result => {
            if (current !== generation || result === null) return
            update({ items: unique(first ? result.items : [...state.items, ...result.items]),
                page: first ? result.pages : state.page + result.pages, pageSize: size,
                nextCursor: result.cursor, hasMore: result.cursor !== null, loaded: true })
            commit(state)
        }).catch(() => {
            if (current !== generation) return
            failed = { first, size, refresh }
            update({ error: first ? '文章加载失败，请重试' : '更多文章加载失败，请重试' })
        }).finally(() => {
            if (current !== generation) return
            active = null
            update({ pending: false, loading: false })
        })
        active = { first, size, promise }
        return promise
    }
    return {
        snapshot: () => state,
        subscribe: (listener: (state: FeedState<T>) => void) => {
            listeners.add(listener)
            listener(state)
            return () => { listeners.delete(listener) }
        },
        first: (size: number, silent = false) => run(true, size, silent),
        more: () => {
            if (failed?.first) return run(true, failed.size, false, failed.refresh)
            if (!state.loaded) return run(true, state.pageSize)
            return state.hasMore ? run(false, state.pageSize) : Promise.resolve()
        },
        refresh: () => {
            if (pendingRefresh) return pendingRefresh
            const current = generation
            const wait = active?.promise ?? Promise.resolve()
            pendingRefresh = wait.then(() => current === generation
                ? run(true, state.pageSize, true, true) : undefined)
                .finally(() => { pendingRefresh = null })
            return pendingRefresh
        },
        retry: () => failed ? run(failed.first, failed.size, false, failed.refresh) : Promise.resolve(),
        invalidate: () => { ++generation; active = null; update({ pending: false, loading: false }) },
    }
}

/** The legacy array envelope is still used by the independent pinned-article list. */
export function requireArticleRows(response: { data?: { code?: unknown; data?: unknown } }): unknown[] {
    if (response.data?.code !== 200 || !Array.isArray(response.data.data)) throw new Error('Invalid article response')
    return response.data.data
}
export function requireArticlePage(response: { data?: { code?: unknown; data?: unknown } }): ArticlePage<unknown> {
    const page = response.data?.data as Partial<ArticlePage<unknown>> | null | undefined
    if (response.data?.code !== 200 || !page || !Array.isArray(page.items)
        || !(page.nextCursor === null || (typeof page.nextCursor === 'string' && page.nextCursor.length > 0))) {
        throw new Error('Invalid article page')
    }
    return page as ArticlePage<unknown>
}

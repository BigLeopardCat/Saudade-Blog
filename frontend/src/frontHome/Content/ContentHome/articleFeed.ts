/** Homepage paging state. Only confirmed responses may advance the page or cache. */
export interface FeedState<T> {
    items: T[]
    page: number
    pageSize: number
    hasMore: boolean
    loaded: boolean
    pending: boolean
    loading: boolean
    error: string | null
}

export function createArticleFeed<T>(
    request: (page: number, pageSize: number) => Promise<T[]>,
    initial: Pick<FeedState<T>, 'items' | 'page' | 'pageSize' | 'hasMore' | 'loaded'>,
    commit: (state: FeedState<T>) => void,
) {
    let state: FeedState<T> = { ...initial, pending: false, loading: false, error: null }
    let generation = 0
    let active: { page: number; size: number; promise: Promise<void> } | null = null
    let failed: { first: boolean; size: number; refresh?: boolean } | null = null
    let pendingRefresh: Promise<void> | null = null
    const listeners = new Set<(state: FeedState<T>) => void>()
    const update = (patch: Partial<FeedState<T>>) => {
        state = { ...state, ...patch }
        listeners.forEach(listener => listener(state))
    }
    const run = (first: boolean, size: number, silent = false, refresh = false): Promise<void> => {
        const page = refresh ? state.page : first ? 1 : state.page + 1
        if (active && (!first || (active.page === page && active.size === size))) return active.promise
        const current = ++generation
        failed = null
        update({ pending: true, loading: !silent, error: null })
        // Defer transport invocation so the single-flight lock is installed before it runs.
        const promise = Promise.resolve().then(async () => {
            if (!refresh) return request(page, size)
            const items: T[] = []
            // Refresh loaded pages at their existing offsets; do not discard the reader's position.
            for (let currentPage = 1; currentPage <= page; currentPage++) {
                const rows = await request(currentPage, size)
                if (current !== generation) return []
                items.push(...rows)
                if (rows.length < size) break
            }
            return items
        }).then(items => {
            if (current !== generation) return
            update({
                items: first ? items : [...state.items, ...items],
                page: refresh ? Math.max(1, Math.ceil(items.length / size)) : page,
                pageSize: size, hasMore: items.length === size * (refresh ? page : 1), loaded: true,
            })
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
        active = { page, size, promise }
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
            // A failed resize replacement must be retried before continuing at another offset.
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
        invalidate: () => {
            ++generation
            active = null
            update({ pending: false, loading: false })
        },
    }
}

/** HTTP 200 is insufficient: backend errors are carried by the API envelope. */
export function requireArticleRows(response: { data?: { code?: unknown; data?: unknown } }): unknown[] {
    if (response.data?.code !== 200 || !Array.isArray(response.data.data)) {
        throw new Error('Invalid article response')
    }
    return response.data.data
}

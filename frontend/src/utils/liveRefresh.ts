import { useEffect, useRef } from 'react'
import { AGENT_TURN_DONE_EVENT } from '../components/UserCenter/agentTurn.ts'

export const DEFAULT_POLL_MS = 20 * 1000
export const MIN_GAP_MS = 2000

export type LiveRefreshOptions = {
    pollMs?: number
    poll?: boolean
    skip?: () => boolean
    agentEvent?: (event: Event) => boolean
}

type Consumer = { fire: (invalidate?: boolean, event?: Event) => void; poll: boolean }

const consumers = new Set<Consumer>()
let timer: ReturnType<typeof setInterval> | null = null
let pollMs = DEFAULT_POLL_MS

function visible(): boolean {
    return typeof document === 'undefined' || !document.hidden
}

function fanout(pollersOnly: boolean, invalidate = false, event?: Event): void {
    consumers.forEach((c) => {
        if (pollersOnly && !c.poll) return
        try {
            c.fire(invalidate, event)
        } catch { /* Isolate subscriber failures. */
        }
    })
}

function syncTimer(): void {
    const want = Array.from(consumers).some((c) => c.poll)
    if (want && timer === null) {
        timer = setInterval(() => {
            if (visible()) fanout(true)
        }, pollMs)
    } else if (!want && timer !== null) {
        clearInterval(timer)
        timer = null
        pollMs = DEFAULT_POLL_MS
    }
}

if (typeof window !== 'undefined') {
    window.addEventListener(AGENT_TURN_DONE_EVENT, event => { fanout(false, true, event) })
    window.addEventListener('focus', () => { fanout(false) })
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) fanout(false)
    })
}

export function retainLive(
    reload: (invalidate?: boolean) => void | Promise<void>,
    opts: LiveRefreshOptions = {},
): () => void {
    let last = 0
    let inflight = false
    let alive = true
    let pendingInvalidation = false

    const fire = (invalidate = false, event?: Event): void => {
        if (!alive) return
        if (event && opts.agentEvent && !opts.agentEvent(event)) return
        if (inflight) {
            pendingInvalidation ||= invalidate
            return
        }
        if (opts.skip && opts.skip()) return
        const now = Date.now()
        if (!invalidate && now - last < MIN_GAP_MS) return
        last = now
        const out = reload(invalidate)

        if (out && typeof (out as Promise<void>).then === 'function') {
            inflight = true
            Promise.resolve(out)
                .catch(() => { /* The subscriber reports its request failure. */ })
                .then(() => {
                    inflight = false
                    if (pendingInvalidation) {
                        pendingInvalidation = false
                        fire(true)
                    }
                })
        }
    }

    const c: Consumer = { fire, poll: opts.poll !== false }

    if (c.poll && opts.pollMs && !Array.from(consumers).some((x) => x.poll)) {
        pollMs = opts.pollMs
    }
    consumers.add(c)
    syncTimer()

    return () => {
        alive = false
        consumers.delete(c)
        syncTimer()
    }
}

export function useLiveRefresh(
    reload: (invalidate?: boolean) => void | Promise<void>,
    opts: LiveRefreshOptions = {},
): void {
    const reloadRef = useRef(reload)
    reloadRef.current = reload
    const skipRef = useRef(opts.skip)
    skipRef.current = opts.skip
    const agentEventRef = useRef(opts.agentEvent)
    agentEventRef.current = opts.agentEvent
    const { pollMs: ms, poll } = opts
    useEffect(() => retainLive(invalidate => reloadRef.current(invalidate), {
        pollMs: ms,
        poll,
        skip: () => (skipRef.current ? skipRef.current() : false),
        agentEvent: event => agentEventRef.current ? agentEventRef.current(event) : true,
    }), [ms, poll])
}

export function liveRefreshDebug(): { consumers: number; polling: boolean; pollMs: number } {
    return { consumers: consumers.size, polling: timer !== null, pollMs }
}

export const AGENT_TURN_DONE_EVENT = 'agent-turn-done'

export interface AgentTurnDetail {
    confirmationAttempted: boolean
    articleIdsToRefresh: number[]
}

export function isConfirmationAttempt(event: Event): boolean {
    return (event as CustomEvent<Partial<AgentTurnDetail> | undefined>).detail?.confirmationAttempted === true
}

/** Invalidation hints request a read; they never assert that a write succeeded. */
export function hasArticleInvalidation(event: Event): boolean {
    const detail = (event as CustomEvent<Partial<AgentTurnDetail> | undefined>).detail
    return detail?.confirmationAttempted === true
        && Array.isArray(detail.articleIdsToRefresh)
        && detail.articleIdsToRefresh.some(id => Number.isSafeInteger(id) && id > 0)
}

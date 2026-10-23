import { useEffect } from 'react';
import { AGENT_TURN_DONE_EVENT } from '../components/UserCenter/agentTurn';

// Agent writes are a product-specific invalidation signal. Focus, visibility
// and polling are handled by RTK Query rather than a second timer registry.
export function useCatalogRefresh(refetch: () => unknown, paused: boolean) {
    useEffect(() => {
        const refresh = () => { if (!paused) refetch(); };
        window.addEventListener(AGENT_TURN_DONE_EVENT, refresh);
        return () => window.removeEventListener(AGENT_TURN_DONE_EVENT, refresh);
    }, [refetch, paused]);
}

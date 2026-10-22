/** A mounted resource owns a scope. Each channel accepts only its latest response.
 * Cancellation saves read traffic; the identity check also covers transports that
 * ignore AbortSignal and mutations that must finish on the server. */
export function createRequestScope() {
    let active = true
    const channels = new Map<string, AbortController>()
    const cancel = (channel: string) => {
        channels.get(channel)?.abort()
        channels.delete(channel)
    }
    const begin = (channel: string) => {
        cancel(channel)
        const controller = new AbortController()
        channels.set(channel, controller)
        return {
            signal: controller.signal,
            current: () => active && !controller.signal.aborted && channels.get(channel) === controller,
        }
    }
    return {
        begin,
        cancel,
        activate: () => { active = true },
        dispose: () => {
            active = false
            for (const controller of channels.values()) controller.abort()
            channels.clear()
        },
        async run<T>(channel: string, request: (signal: AbortSignal) => Promise<T>, handlers: {
            success: (value: T) => void,
            error?: (error: unknown) => void,
            settled?: () => void,
        }) {
            const token = begin(channel)
            try {
                const value = await request(token.signal)
                if (token.current()) handlers.success(value)
            } catch (error) {
                if (token.current()) handlers.error?.(error)
            } finally {
                if (token.current()) handlers.settled?.()
            }
        },
    }
}

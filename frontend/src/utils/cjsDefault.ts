export function cjsDefault<T>(mod: T): T {
    const m = mod as unknown as { default?: { default?: unknown } }
    return (m?.default?.default ?? m?.default ?? mod) as T
}

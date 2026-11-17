import {useCallback, useEffect, useRef, useState, type PointerEvent} from 'react'

const IDLE = 3000
const LEAVE_GRACE = 700
const EDGE_INTENT = 300
const TOP = 24

/** Scroll intent reveals a temporary bar; using the bar pauses its lifetime. */
export function useAutoHideHeader(route: string, locked: boolean) {
    const [hidden, setHidden] = useState(false)
    const bar = useRef<HTMLDivElement>(null)
    const held = useRef(false)
    const lockedRef = useRef(locked)
    lockedRef.current = locked
    const actions = useRef({show: () => {}, release: () => {}, edge: () => {}, cancelEdge: () => {}})
    useEffect(() => {
        let previous = Math.max(0, window.scrollY), direction = 0, distance = 0, frame = 0
        let idle: ReturnType<typeof setTimeout> | undefined
        let edge: ReturnType<typeof setTimeout> | undefined
        const keyboard = () => {
            const focused = document.activeElement
            return focused instanceof HTMLElement && bar.current?.contains(focused) && focused.matches(':focus-visible')
        }
        const protectedBar = () => lockedRef.current || held.current || keyboard() || window.scrollY <= TOP
        const hide = () => { if (!protectedBar()) setHidden(true) }
        const arm = (delay = IDLE) => {
            clearTimeout(idle)
            if (!protectedBar()) idle = setTimeout(hide, delay)
        }
        const show = () => { setHidden(false); arm() }
        const cancelEdge = () => clearTimeout(edge)
        actions.current = {show, release: () => arm(LEAVE_GRACE),
            edge: () => { cancelEdge(); edge = setTimeout(show, EDGE_INTENT) }, cancelEdge}
        const measure = () => {
            frame = 0
            const max = Math.max(0, document.documentElement.scrollHeight - innerHeight)
            const y = Math.max(0, Math.min(window.scrollY, max)), delta = y - previous
            previous = y
            if (protectedBar()) {
                clearTimeout(idle); distance = direction = 0; setHidden(false); return
            }
            if (Math.abs(delta) < 2) return
            const next = Math.sign(delta)
            distance = next === direction ? distance + Math.abs(delta) : Math.abs(delta)
            direction = next
            if (direction > 0 && distance >= 56) { clearTimeout(idle); hide(); distance = 0 }
            if (direction < 0 && distance >= 20) { show(); distance = 0 }
            // Leaving the always-visible top region also starts an idle lifetime.
            if (y > TOP && y - delta <= TOP) arm()
        }
        const scroll = () => { if (!frame) frame = requestAnimationFrame(measure) }
        window.addEventListener('scroll', scroll, {passive: true})
        show()
        return () => {
            window.removeEventListener('scroll', scroll); cancelAnimationFrame(frame)
            clearTimeout(idle); clearTimeout(edge)
        }
    }, [route])
    useEffect(() => { actions.current.show() }, [locked])
    const reveal = useCallback(() => actions.current.show(), [])
    return {
        hidden: hidden && !locked, bar, reveal,
        onEdgeEnter: (event: PointerEvent) => { if (event.pointerType === 'mouse') actions.current.edge() },
        onEdgeLeave: () => actions.current.cancelEdge(),
        onPointerEnter: (event: PointerEvent) => {
            if (event.pointerType === 'mouse') { held.current = true; reveal() }
        },
        onPointerLeave: () => { held.current = false; actions.current.release() },
        onFocusCapture: () => { if ((document.activeElement as HTMLElement | null)?.matches(':focus-visible')) reveal() },
        onBlurCapture: () => actions.current.release(),
    }
}

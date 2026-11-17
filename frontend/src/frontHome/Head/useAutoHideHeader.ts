import {useCallback, useEffect, useRef, useState, type PointerEvent} from 'react'

/** Hysteresis keeps touchpad jitter from toggling the navigation. */
export function useAutoHideHeader(route: string, locked: boolean) {
    const [hidden, setHidden] = useState(false)
    const bar = useRef<HTMLDivElement>(null)
    const held = useRef(false)
    const reveal = useCallback(() => setHidden(false), [])
    useEffect(() => {
        setHidden(false)
        let previous = Math.max(0, window.scrollY), direction = 0, distance = 0, frame = 0
        const measure = () => {
            frame = 0
            const max = Math.max(0, document.documentElement.scrollHeight - innerHeight)
            const y = Math.max(0, Math.min(window.scrollY, max))
            const delta = y - previous
            previous = y
            const focused = document.activeElement
            const keyboard = focused instanceof HTMLElement && bar.current?.contains(focused) && focused.matches(':focus-visible')
            if (locked || held.current || keyboard || y < 120) {
                distance = direction = 0
                setHidden(false)
                return
            }
            if (Math.abs(delta) < 2) return
            const next = Math.sign(delta)
            distance = next === direction ? distance + Math.abs(delta) : Math.abs(delta)
            direction = next
            if (direction > 0 && distance >= 56) { setHidden(true); distance = 0 }
            if (direction < 0 && distance >= 20) { setHidden(false); distance = 0 }
        }
        const scroll = () => { if (!frame) frame = requestAnimationFrame(measure) }
        window.addEventListener('scroll', scroll, {passive: true})
        return () => { window.removeEventListener('scroll', scroll); cancelAnimationFrame(frame) }
    }, [route, locked])
    return {
        hidden: hidden && !locked,
        bar,
        reveal,
        onPointerEnter: (event: PointerEvent) => {
            if (event.pointerType === 'mouse') { held.current = true; reveal() }
        },
        onPointerLeave: () => { held.current = false },
        onFocusCapture: () => {
            if ((document.activeElement as HTMLElement | null)?.matches(':focus-visible')) reveal()
        },
    }
}

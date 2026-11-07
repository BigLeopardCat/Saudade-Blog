import {useRef} from 'react'
import {useInView, useReducedMotion} from 'framer-motion'
import sprite from './assets/sweep.webp'
import './index.sass'

/** Decorative pending artwork; its owner controls loading, errors and lifetime. */
export default function SweepLoading({className = ''}: {className?: string}) {
    const stage = useRef<HTMLSpanElement>(null)
    const visible = useInView(stage)
    const reducedMotion = useReducedMotion()
    return <span ref={stage} className={`sweep-loading ${className}`.trim()}
        data-paused={!visible || !!reducedMotion} aria-hidden="true">
        <span className="sweep-loading__sprite" style={{backgroundImage: `url(${sprite})`}}/>
    </span>
}

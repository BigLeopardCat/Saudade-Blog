import {useEffect, useRef, useState, type CSSProperties} from 'react'
import {Link} from 'react-router-dom'
import {useAutoThemeSwitch, useIsDarkMode} from '../../theme'
import './index.sass'

const asset = (name: string) => `/mascot-404/${name}.webp`
const bumps = ['small', 'medium', 'large']
const sprites = ['neutral', 'pain', 'cry', ...bumps.map(size => `bump-${size}`)]

const NotFound = () => {
    useAutoThemeSwitch()
    const isDark = useIsDarkMode()
    const [run, setRun] = useState(0)
    const [ready, setReady] = useState(false)
    const [reduced, setReduced] = useState(false)
    const [hits, setHits] = useState(0)
    const [expression, setExpression] = useState('neutral')
    const timer = useRef<ReturnType<typeof setTimeout>>()

    useEffect(() => {
        const media = window.matchMedia('(prefers-reduced-motion: reduce)')
        const sync = () => setReduced(media.matches)
        sync()
        media.addEventListener('change', sync)
        return () => media.removeEventListener('change', sync)
    }, [])

    useEffect(() => {
        let cancelled = false
        clearTimeout(timer.current)
        setReady(false)
        setHits(reduced ? 3 : 0)
        setExpression(reduced ? 'cry' : 'neutral')
        // Decode every layer before starting so a late image cannot skip an expression.
        Promise.all(sprites.map(name => new Promise<void>(resolve => {
            const image = new Image()
            image.onload = () => { image.decode().catch(() => {}).then(() => resolve()) }
            image.onerror = () => resolve()
            image.src = asset(name)
        }))).then(() => { if (!cancelled) setReady(true) })
        return () => { cancelled = true; clearTimeout(timer.current) }
    }, [run, reduced])

    const impact = (index: number) => {
        clearTimeout(timer.current)
        setHits(index + 1)
        setExpression('pain')
        timer.current = setTimeout(() => setExpression(index === 2 ? 'cry' : 'neutral'), 360)
    }

    return <main className={`mascot-error${isDark ? ' frontDark' : ''}`} aria-labelledby="mascot-error-title">
        <div className="mascot-error__scene" data-ready={ready} data-reduced={reduced}
             data-expression={expression} aria-hidden="true">
            <div className="mascot-error__shadow" />
            <div className="mascot-error__character">
                {['neutral', 'pain', 'cry'].map(face => <img key={face} src={asset(face)} alt=""
                    width="960" height="640" decoding="async" draggable={false}
                    className={`mascot-error__sprite${expression === face ? ' is-visible' : ''}`} />)}
                {bumps.map((size, index) => <span key={`${run}-${size}`}
                    className={`mascot-error__bump mascot-error__bump--${size}${hits > index ? ' is-visible' : ''}`}
                    style={{backgroundImage: `url(${asset(`bump-${size}`)})`}} />)}
            </div>
            {ready && ['4', '0', '4'].map((digit, index) => <span key={`${run}-${index}`}
                className={`mascot-error__digit mascot-error__digit--${index}`}
                style={{'--drop-delay': `${550 + index * 950}ms`} as CSSProperties}
                onAnimationEnd={event => {
                    if (event.animationName === 'mascotDigitFall') impact(index)
                }}><span>{digit}</span></span>)}
        </div>
        <div className="mascot-error__copy">
            <p className="mascot-error__eyebrow">404 · PAGE NOT FOUND</p>
            <h1 id="mascot-error-title">呜…页面不见了</h1>
            <p>找遍了这里，也没找到你要的那一页。<br />陪泠月喵回首页看看吧。</p>
            <div className="mascot-error__actions">
                <Link to="/" className="mascot-error__home">带她回首页</Link>
                {!reduced && <button type="button" disabled={!ready || expression !== 'cry'}
                    onClick={() => setRun(value => value + 1)}>再看一次</button>}
            </div>
        </div>
    </main>
}

export default NotFound

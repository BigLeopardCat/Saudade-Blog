import SeoHelmet from '../SeoHelmet'
import {useEffect, useRef, useState, type CSSProperties} from 'react'
import {Link} from 'react-router-dom'
import {useAutoThemeSwitch, useIsDarkMode} from '../../theme'
import neutral from './assets/neutral.webp'
import neutralSmall from './assets/neutral-672.webp'
import pain from './assets/pain.webp'
import painSmall from './assets/pain-672.webp'
import cry from './assets/cry.webp'
import crySmall from './assets/cry-672.webp'
import bumpSmall from './assets/bump-small.webp'
import bumpMedium from './assets/bump-medium.webp'
import bumpLarge from './assets/bump-large.webp'
import './index.sass'

const faces = [
    {name: 'neutral', full: neutral, small: neutralSmall},
    {name: 'pain', full: pain, small: painSmall},
    {name: 'cry', full: cry, small: crySmall},
]
const bumps = [
    {name: 'small', image: bumpSmall},
    {name: 'medium', image: bumpMedium},
    {name: 'large', image: bumpLarge},
]

const NotFound = () => {
    useAutoThemeSwitch()
    const isDark = useIsDarkMode()
    const [run, setRun] = useState(0)
    const [decodedFaces, setDecodedFaces] = useState<string[]>([])
    const [reduced, setReduced] = useState(false)
    const [hits, setHits] = useState(0)
    const [expression, setExpression] = useState('neutral')
    const timer = useRef<ReturnType<typeof setTimeout>>()
    const ready = decodedFaces.includes('neutral')
    const visibleFace = decodedFaces.includes(expression) ? expression : 'neutral'

    const decodeFace = (face: string, image: HTMLImageElement) => {
        void image.decode().then(() => {
            setDecodedFaces(current => current.includes(face) ? current : [...current, face])
        }).catch(() => {})
    }

    useEffect(() => {
        const media = window.matchMedia('(prefers-reduced-motion: reduce)')
        const sync = () => setReduced(media.matches)
        sync()
        media.addEventListener('change', sync)
        return () => media.removeEventListener('change', sync)
    }, [])

    useEffect(() => {
        clearTimeout(timer.current)
        setHits(reduced ? 3 : 0)
        setExpression(reduced ? 'cry' : 'neutral')
        return () => clearTimeout(timer.current)
    }, [run, reduced])

    const impact = (index: number) => {
        clearTimeout(timer.current)
        setHits(index + 1)
        setExpression('pain')
        timer.current = setTimeout(() => setExpression(index === 2 ? 'cry' : 'neutral'), 360)
    }

    return <main className={`mascot-error${isDark ? ' frontDark' : ''}`} aria-labelledby="mascot-error-title">
        <SeoHelmet title="页面不存在" noindex />
        <div className="mascot-error__scene" data-ready={ready} data-reduced={reduced}
             data-expression={expression} aria-hidden="true">
            <div className="mascot-error__shadow" />
            <div className="mascot-error__character">
                {faces.map(face => <img key={face.name}
                    srcSet={`${face.small} 672w, ${face.full} 960w`}
                    sizes="(max-width: 700px) calc(100vw - 40px), 660px" src={face.full} alt=""
                    width="960" height="640" decoding="async" draggable={false}
                    fetchPriority={face.name === 'neutral' ? 'high' : 'low'}
                    onLoad={event => decodeFace(face.name, event.currentTarget)}
                    className={`mascot-error__sprite${visibleFace === face.name ? ' is-visible' : ''}`} />)}
                {bumps.map((size, index) => <span key={`${run}-${size.name}`}
                    className={`mascot-error__bump mascot-error__bump--${size.name}${hits > index ? ' is-visible' : ''}`}
                    style={{backgroundImage: `url(${size.image})`}} />)}
            </div>
            {['4', '0', '4'].map((digit, index) => <span key={`${run}-${index}`}
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

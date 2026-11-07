import {useState, type ImgHTMLAttributes, type ReactNode} from 'react'
import {resolveApiAssetUrl} from '../../utils/runtimeApi'
import './index.css'

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {src?: string; pending?: ReactNode}

function ImageAttempt({src, className, alt = '', loading = 'lazy', decoding = 'async', pending,
    onError, onLoad, ...props}: Props & {src: string}) {
    const [failed, setFailed] = useState(false)
    const [waiting, setWaiting] = useState(true)
    const [attempt, setAttempt] = useState(0)
    return <span className={`asset-image ${className || ''}`} aria-busy={waiting && !failed}>
        {failed ? <span className="asset-image-failure" role="status">
            <span>图片加载失败</span>
            <button type="button" aria-label={alt ? `重新加载图片：${alt}` : '重新加载图片'}
                onClick={event => {event.stopPropagation(); setAttempt(value => value + 1); setWaiting(true); setFailed(false)}}
                onKeyDown={event => event.stopPropagation()}>重试</button>
        </span> : <img {...props} key={attempt} src={src} alt={alt} loading={loading} decoding={decoding}
            onLoad={event => {setWaiting(false); onLoad?.(event)}}
            onError={event => {setWaiting(false); setFailed(true); onError?.(event)}} />}
        {waiting && !failed && pending && <span className="asset-image-pending">{pending}</span>}
    </span>
}

/** Retry the same URL without changing signed parameters or fetching through JavaScript. */
export default function AssetImage({src, ...props}: Props) {
    const resolved = resolveApiAssetUrl(src)
    return resolved ? <ImageAttempt key={resolved} {...props} src={resolved} /> : null
}

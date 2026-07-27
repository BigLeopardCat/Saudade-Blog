import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react'

export interface Live2dAgentHandle {
    setMouthOpen: (open: boolean) => void
    setMouthValue: (value: number) => void
}

const Live2dAgent = forwardRef<Live2dAgentHandle>((_props, ref) => {
    const iframeRef = useRef<HTMLIFrameElement>(null)

    useImperativeHandle(ref, () => ({
        setMouthOpen(open: boolean) {
            iframeRef.current?.contentWindow?.postMessage({ type: 'mouth', value: open ? 1 : 0 }, '*')
        },
        setMouthValue(value: number) {
            iframeRef.current?.contentWindow?.postMessage({ type: 'mouth', value }, '*')
        }
    }))

    return (
        <iframe
            ref={iframeRef}
            src="/live2d-viewer.html"
            style={{
                position: 'fixed',
                bottom: 0,
                right: 0,
                width: 250,
                height: 400,
                border: 'none',
                zIndex: 1000,
                pointerEvents: 'none',
                background: 'transparent',
            }}
            title="Live2D Agent"
        />
    )
})

Live2dAgent.displayName = 'Live2dAgent'
export default Live2dAgent

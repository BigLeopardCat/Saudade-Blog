import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react'

const CUBISM_CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'

export interface Live2dAgentHandle {
    setMouthOpen: (open: boolean) => void
    setMouthValue: (value: number) => void
}

const Live2dAgent = forwardRef<Live2dAgentHandle>((_props, ref) => {
    const canvasRef = useRef<HTMLDivElement>(null)
    const blinkRef = useRef<number>(0)
    const tailTimeRef = useRef<number>(0)
    const hairTimeRef = useRef<number>(0)
    const speakTargetRef = useRef<number>(0)
    const speakCurrentRef = useRef<number>(0)

    useImperativeHandle(ref, () => ({
        setMouthOpen(open: boolean) {
            speakTargetRef.current = open ? 1 : 0
        },
        setMouthValue(value: number) {
            speakTargetRef.current = Math.max(0, Math.min(1, value))
        }
    }))

    useEffect(() => {
        if (!canvasRef.current) return
        let destroyed = false

        async function init() {
            // 1. 加载 Cubism Core
            if (!(window as any).Live2DCubismCore) {
                await new Promise<void>((resolve, reject) => {
                    const s = document.createElement('script')
                    s.src = CUBISM_CORE_URL
                    s.async = true
                    s.onload = () => resolve()
                    s.onerror = () => reject(new Error('Failed to load Cubism Core'))
                    document.head.appendChild(s)
                })
            }

            // 2. 动态导入 pixi-live2d-display（必须在 Core 加载之后）
            const PIXI = await import('pixi.js')
            const { Live2DModel } = await import('pixi-live2d-display')
            await import('pixi-live2d-display/cubism4')

            if (destroyed) return

            // 3. 创建 PIXI 应用
            const app = new PIXI.Application({
                width: 250,
                height: 400,
                transparent: true,
                antialias: true,
                backgroundAlpha: 0,
            })
            canvasRef.current!.appendChild(app.view as HTMLCanvasElement)

            // 4. 加载模型
            const model = await Live2DModel.from('/Live2d_agent/agent_2.model3.json', { motionPreload: 'IDLE' })
            if (destroyed) { model.destroy(); return }

            model.anchor.set(0.5, 1)
            model.position.set(app.screen.width / 2, app.screen.height)
            model.scale.set(0.22)
            app.stage.addChild(model)

            const cm = model.internalModel.coreModel as any
            const eyeLIdx = cm.getParameterIndex('ParamEyeLOpen')
            const eyeRIdx = cm.getParameterIndex('ParamEyeROpen')

            // 5. Tick 循环
            app.ticker.add(() => {
                // 眨眼
                blinkRef.current += app.ticker.deltaMS / 1000
                if (blinkRef.current > 3 + Math.random() * 2) {
                    blinkRef.current = 0
                    let t = 0
                    const close = () => {
                        t += 0.05
                        const v = Math.min(t / 0.1, 1)
                        cm.setParameterValueByIndex(eyeLIdx, 1 - v, 1)
                        cm.setParameterValueByIndex(eyeRIdx, 1 - v, 1)
                        if (t < 0.1) requestAnimationFrame(close)
                        else {
                            let t2 = 0
                            const open = () => {
                                t2 += 0.04
                                const v2 = Math.min(t2 / 0.12, 1)
                                cm.setParameterValueByIndex(eyeLIdx, v2, 1)
                                cm.setParameterValueByIndex(eyeRIdx, v2, 1)
                                if (t2 < 0.12) requestAnimationFrame(open)
                            }
                            requestAnimationFrame(open)
                        }
                    }
                    requestAnimationFrame(close)
                }

                // 尾巴
                tailTimeRef.current += app.ticker.deltaMS / 1000
                cm.setParameterValueById('ParamTail', Math.sin(tailTimeRef.current * 2.5) * 30, 1)

                // 呆毛 / 头发 / 耳朵
                hairTimeRef.current += app.ticker.deltaMS / 1000
                cm.setParameterValueById('ParamDaiMao', Math.sin(hairTimeRef.current * 1.8) * 20, 1)
                cm.setParameterValueById('ParamHairFront', Math.sin(hairTimeRef.current * 1.2 + 1) * 5, 1)
                cm.setParameterValueById('Param3', Math.sin(hairTimeRef.current * 3.5 + 2) * 8, 1)

                // 嘴部
                const diff = speakTargetRef.current - speakCurrentRef.current
                if (Math.abs(diff) > 0.01) {
                    speakCurrentRef.current += diff * 0.08
                    cm.setParameterValueById('ParamSpeak', speakCurrentRef.current, 1)
                    cm.setParameterValueById('ParamMouthOpenY', speakCurrentRef.current * 0.8, 1)
                }
            })
        }

        init().catch(err => console.error('Live2D init failed:', err))

        return () => { destroyed = true }
    }, [])

    return (
        <div ref={canvasRef} style={{
            position: 'fixed',
            bottom: 0,
            right: 0,
            zIndex: 1000,
            pointerEvents: 'none',
        }} />
    )
})

Live2dAgent.displayName = 'Live2dAgent'
export default Live2dAgent

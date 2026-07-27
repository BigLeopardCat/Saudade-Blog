import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import * as PIXI from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display'

const CUBISM_CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'

function loadCubismCore(): Promise<void> {
    return new Promise((resolve, reject) => {
        if ((window as any).Live2DCubismCore) { resolve(); return }
        const script = document.createElement('script')
        script.src = CUBISM_CORE_URL
        script.async = true
        script.onload = () => {
            import('pixi-live2d-display/cubism4').then(() => resolve()).catch(reject)
        }
        script.onerror = () => reject(new Error('Failed to load Live2D Cubism Core'))
        document.head.appendChild(script)
    })
}

export interface Live2dAgentHandle {
    setMouthOpen: (open: boolean) => void
    setMouthValue: (value: number) => void
}

const Live2dAgent = forwardRef<Live2dAgentHandle>((_props, ref) => {
    const canvasRef = useRef<HTMLDivElement>(null)
    const appRef = useRef<PIXI.Application | null>(null)
    const modelRef = useRef<Live2DModel | null>(null)
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

        loadCubismCore().then(() => {
            if (destroyed) return

            const app = new PIXI.Application({
                width: 250,
                height: 400,
                transparent: true,
                antialias: true,
                backgroundAlpha: 0,
            })
            appRef.current = app
            canvasRef.current!.appendChild(app.view as HTMLCanvasElement)

            Live2DModel.from('/Live2d_agent/agent_2.model3.json', { motionPreload: 'IDLE' }).then(model => {
                if (destroyed) { model.destroy(); return }
                modelRef.current = model
                model.anchor.set(0.5, 1)
                model.position.set(app.screen.width / 2, app.screen.height)
                model.scale.set(0.22)
                app.stage.addChild(model)

                const cm = model.internalModel.coreModel
                const eyeLIdx = cm.getParameterIndex('ParamEyeLOpen')
                const eyeRIdx = cm.getParameterIndex('ParamEyeROpen')

                app.ticker.add(() => {
                    if (!modelRef.current) return

                    // 1. 眨眼
                    blinkRef.current += app.ticker.deltaMS / 1000
                    if (blinkRef.current > 3 + Math.random() * 2) {
                        blinkRef.current = 0
                        let t = 0
                        const step = () => {
                            t += 0.05
                            const v = Math.min(t / 0.1, 1)
                            cm.setParameterValueByIndex(eyeLIdx, 1 - v, 1)
                            cm.setParameterValueByIndex(eyeRIdx, 1 - v, 1)
                            if (t < 0.1) { requestAnimationFrame(step) }
                            else {
                                let t2 = 0
                                const step2 = () => {
                                    t2 += 0.04
                                    const v2 = Math.min(t2 / 0.12, 1)
                                    cm.setParameterValueByIndex(eyeLIdx, v2, 1)
                                    cm.setParameterValueByIndex(eyeRIdx, v2, 1)
                                    if (t2 < 0.12) requestAnimationFrame(step2)
                                }
                                requestAnimationFrame(step2)
                            }
                        }
                        requestAnimationFrame(step)
                    }

                    // 2. 尾巴
                    tailTimeRef.current += app.ticker.deltaMS / 1000
                    cm.setParameterValueById('ParamTail', Math.sin(tailTimeRef.current * 2.5) * 30, 1)

                    // 3. 呆毛/头发
                    hairTimeRef.current += app.ticker.deltaMS / 1000
                    cm.setParameterValueById('ParamDaiMao', Math.sin(hairTimeRef.current * 1.8) * 20, 1)
                    cm.setParameterValueById('ParamHairFront', Math.sin(hairTimeRef.current * 1.2 + 1) * 5, 1)

                    // 4. 耳朵
                    cm.setParameterValueById('Param3', Math.sin(hairTimeRef.current * 3.5 + 2) * 8, 1)

                    // 5. 嘴部
                    const diff = speakTargetRef.current - speakCurrentRef.current
                    if (Math.abs(diff) > 0.01) {
                        speakCurrentRef.current += diff * 0.08
                        cm.setParameterValueById('ParamSpeak', speakCurrentRef.current, 1)
                        cm.setParameterValueById('ParamMouthOpenY', speakCurrentRef.current * 0.8, 1)
                    }
                })
            })
        }).catch(err => {
            console.error('Live2D 模型加载失败:', err)
        })

        return () => {
            destroyed = true
            if (modelRef.current) modelRef.current.destroy()
            if (appRef.current) appRef.current.destroy(true)
        }
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

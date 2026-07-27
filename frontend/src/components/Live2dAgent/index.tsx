import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import * as PIXI from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display'
import 'pixi-live2d-display/cubism4'

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

    // 暴露给父组件的控制接口
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

        const app = new PIXI.Application({
            width: 250,
            height: 400,
            transparent: true,
            antialias: true,
            backgroundAlpha: 0,
        })
        appRef.current = app
        canvasRef.current.appendChild(app.view as HTMLCanvasElement)

        let destroyed = false

        Live2DModel.from('/Live2d_agent/agent_2.model3.json', {
            motionPreload: 'IDLE',
        }).then(model => {
            if (destroyed) { model.destroy(); return }

            modelRef.current = model
            model.anchor.set(0.5, 1)
            model.position.set(app.screen.width / 2, app.screen.height)
            model.scale.set(0.22)
            app.stage.addChild(model)

            // 启用自动眨眼
            const cm = model.internalModel.coreModel
            const eyeLIdx = cm.getParameterIndex('ParamEyeLOpen')
            const eyeRIdx = cm.getParameterIndex('ParamEyeROpen')

            // 自定义 Tick 循环动画
            app.ticker.add(() => {
                if (!modelRef.current) return

                // 1. 眨眼（随机间隔，平滑闭合/睁开）
                blinkRef.current += app.ticker.deltaMS / 1000
                const blinkInterval = 3 + Math.random() * 2 // 3~5秒
                if (blinkRef.current > blinkInterval) {
                    blinkRef.current = 0
                    // 闭眼动画
                    let closeTime = 0
                    const closeStep = () => {
                        closeTime += 0.05
                        const val = Math.min(closeTime / 0.1, 1)
                        cm.setParameterValueByIndex(eyeLIdx, 1 - val, 1)
                        cm.setParameterValueByIndex(eyeRIdx, 1 - val, 1)
                        if (closeTime < 0.1) {
                            requestAnimationFrame(closeStep)
                        } else {
                            // 睁眼动画
                            let openTime = 0
                            const openStep = () => {
                                openTime += 0.04
                                const val = Math.min(openTime / 0.12, 1)
                                cm.setParameterValueByIndex(eyeLIdx, val, 1)
                                cm.setParameterValueByIndex(eyeRIdx, val, 1)
                                if (openTime < 0.12) requestAnimationFrame(openStep)
                            }
                            requestAnimationFrame(openStep)
                        }
                    }
                    requestAnimationFrame(closeStep)
                }

                // 2. 尾巴摇动（循环正弦）
                tailTimeRef.current += app.ticker.deltaMS / 1000
                const tailVal = Math.sin(tailTimeRef.current * 2.5) * 30
                cm.setParameterValueById('ParamTail', tailVal, 1)

                // 3. 呆毛/头发自然晃动
                hairTimeRef.current += app.ticker.deltaMS / 1000
                const daiMao = Math.sin(hairTimeRef.current * 1.8) * 20
                cm.setParameterValueById('ParamDaiMao', daiMao, 1)
                const hairFront = Math.sin(hairTimeRef.current * 1.2 + 1) * 5
                cm.setParameterValueById('ParamHairFront', hairFront, 1)

                // 5. 耳朵抖动（周期性小幅度）
                const earVal = Math.sin(hairTimeRef.current * 3.5 + 2) * 8
                cm.setParameterValueById('Param3', earVal, 1)

                // 4. 平滑过渡嘴部参数
                const diff = speakTargetRef.current - speakCurrentRef.current
                if (Math.abs(diff) > 0.01) {
                    speakCurrentRef.current += diff * 0.08
                    cm.setParameterValueById('ParamSpeak', speakCurrentRef.current, 1)
                    cm.setParameterValueById('ParamMouthOpenY', speakCurrentRef.current * 0.8, 1)
                }
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

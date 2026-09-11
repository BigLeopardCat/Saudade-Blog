/**
 * 封面裁剪弹窗（焦点 + 缩放），零新依赖纯手写。
 *
 * 与 GitHub 选头像同思路：主编辑区是一个方形裁剪窗，窗内图片可拖拽移动、滚轮/滑块/捏合缩放，
 * 右侧两个预览窗用**与线上完全相同的一段 CSS**（object-fit:cover + coverCropStyle）实时渲染，
 * 保证「预览即所得」——展示位比例各不相同（1:1 轮播 / ≈1.82:1 卡片 / ≈3.5:1 详情横幅），
 * 但参数里不含比例，故同一组参数在各处自动适配（见 utils/coverCrop.ts 的推导）。
 *
 * 确认时只回传参数 {x,y,z}，不烘焙新图；取消由父组件还原快照。
 */

import React, { useEffect, useRef, useState } from 'react'
import { Button, Modal, Slider } from 'antd'
import { resolveApiAssetUrl } from '../../utils/runtimeApi'
import {
    CARD_ASPECT,
    CAROUSEL_ASPECT,
    DEFAULT_CROP,
    MAX_ZOOM,
    MIN_ZOOM,
    coverCropStyle,
    panCrop,
    zoomCrop,
    type CoverCrop,
} from '../../utils/coverCrop'
import './index.sass'

interface CoverCropModalProps {
    open: boolean
    /** 封面原始 URL（后端返回形态），显示时经 resolveApiAssetUrl 解析 */
    src: string
    /** 打开时的初始参数；null/缺省 = 默认（居中，不放大） */
    initial?: CoverCrop | null
    onCancel: () => void
    onConfirm: (crop: CoverCrop) => void
}

const CoverCropModal: React.FC<CoverCropModalProps> = ({ open, src, initial, onCancel, onConfirm }) => {
    const [crop, setCrop] = useState<CoverCrop>(DEFAULT_CROP)
    const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
    const [loadErr, setLoadErr] = useState(false)
    const [stageSize, setStageSize] = useState(360)

    const stageRef = useRef<HTMLDivElement>(null)
    // 指针状态：拖拽平移 + 双指捏合（与 zoomOverlay 同套路）
    const pointers = useRef(new Map<number, { x: number; y: number }>())
    const pinchDist = useRef(0)
    // initial 用 ref 取最新值，避免父组件每次渲染换对象把初始化 effect 反复触发
    const initialRef = useRef(initial)
    initialRef.current = initial

    const displaySrc = resolveApiAssetUrl(src)
    const W = natural?.w ?? 0
    const H = natural?.h ?? 0

    // 打开时：重置参数（取 initial）+ 预载图片拿自然尺寸
    useEffect(() => {
        if (!open) return
        let cancelled = false
        setCrop({ ...(initialRef.current ?? DEFAULT_CROP) })
        setNatural(null)
        setLoadErr(false)
        if (!src) return
        const img = new Image()
        img.onload = () => {
            if (cancelled) return
            if (img.naturalWidth > 0 && img.naturalHeight > 0) setNatural({ w: img.naturalWidth, h: img.naturalHeight })
            else setLoadErr(true)
        }
        img.onerror = () => { if (!cancelled) setLoadErr(true) }
        img.src = resolveApiAssetUrl(src)
        return () => { cancelled = true }
    }, [open, src])

    // 舞台实测边长（响应式：窄屏会变小），几何换算全部实时依赖它
    useEffect(() => {
        const el = stageRef.current
        if (!el || !open) return
        const measure = () => setStageSize(el.getBoundingClientRect().width || 360)
        measure()
        const ro = new ResizeObserver(measure)
        ro.observe(el)
        return () => ro.disconnect()
    }, [open])

    // 滚轮缩放：必须原生监听并 passive:false —— React 18 在根容器把 wheel 注册为 passive，
    // onWheel 里 preventDefault() 无效（页面会跟着滚）。同 zoomOverlay.ts 的处理。
    useEffect(() => {
        const el = stageRef.current
        if (!el || !open || !natural) return
        const onWheel = (e: WheelEvent) => {
            e.preventDefault()
            const r = el.getBoundingClientRect()
            const ax = e.clientX - r.left
            const ay = e.clientY - r.top
            const factor = Math.exp(-e.deltaY * 0.0016)
            setCrop(prev => zoomCrop(prev, factor, ax, ay, natural.w, natural.h, r.width))
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return () => el.removeEventListener('wheel', onWheel)
    }, [open, natural])

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!natural) return
        const el = stageRef.current
        el?.setPointerCapture(e.pointerId)
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()]
            pinchDist.current = Math.hypot(a.x - b.x, a.y - b.y)
        }
    }

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const p = pointers.current.get(e.pointerId)
        if (!p || !natural) return
        const dx = e.clientX - p.x
        const dy = e.clientY - p.y
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
        const el = stageRef.current
        const r = el?.getBoundingClientRect()
        const S = r?.width ?? stageSize
        if (pointers.current.size === 1) {
            setCrop(prev => panCrop(prev, dx, dy, natural.w, natural.h, S))
        } else if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()]
            const d = Math.hypot(a.x - b.x, a.y - b.y)
            if (pinchDist.current > 0 && d > 0) {
                const ax = (a.x + b.x) / 2 - (r?.left ?? 0)
                const ay = (a.y + b.y) / 2 - (r?.top ?? 0)
                setCrop(prev => zoomCrop(prev, d / pinchDist.current, ax, ay, natural.w, natural.h, S))
            }
            pinchDist.current = d
        }
    }

    const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        pointers.current.delete(e.pointerId)
        if (pointers.current.size === 0) pinchDist.current = 0
    }

    // 舞台内绘制：把裁剪窗（图片像素坐标）放大到舞台像素坐标直接定位，不做 transform（更精确、无子像素误差）
    const winSide = natural ? Math.min(natural.w, natural.h) / crop.z : 0
    const win = natural ? { w: winSide, h: winSide } : null
    const k = win && W > 0 ? stageSize / win.w : 1
    const imgLeft = win ? -(crop.x * (W - win.w) * k) : 0
    const imgTop = win ? -(crop.y * (H - win.h) * k) : 0

    const previewImgStyle: React.CSSProperties = {
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        display: 'block',
        ...coverCropStyle(crop),
    }

    const handleConfirm = () => {
        onConfirm({
            x: Number(crop.x.toFixed(3)),
            y: Number(crop.y.toFixed(3)),
            z: Number(crop.z.toFixed(3)),
        })
    }

    return (
        <Modal
            open={open}
            onCancel={onCancel}
            title="调整封面裁剪"
            width={760}
            centered
            destroyOnHidden
            className="CoverCropModal"
            footer={[
                <Button key="reset" onClick={() => setCrop({ ...DEFAULT_CROP })}>重置</Button>,
                <Button key="cancel" onClick={onCancel}>取消</Button>,
                <Button key="ok" type="primary" disabled={!natural} onClick={handleConfirm}>确定</Button>,
            ]}
        >
            <div className="ccBody">
                <div className="ccEditor">
                    <div
                        className="ccStage"
                        ref={stageRef}
                        onPointerDown={onPointerDown}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerCancel={onPointerUp}
                        onDoubleClick={() => setCrop({ ...DEFAULT_CROP })}
                    >
                        {natural && (
                            <img
                                className="ccStageImg"
                                src={displaySrc}
                                draggable={false}
                                style={{
                                    left: imgLeft,
                                    top: imgTop,
                                    width: W * k,
                                    height: H * k,
                                    maxWidth: 'none',
                                    maxHeight: 'none',
                                }}
                            />
                        )}
                        <div className="ccGrid" />
                        {!natural && <div className="ccStageTip">{loadErr ? '图片加载失败' : '图片加载中…'}</div>}
                    </div>
                    <div className="ccHint">拖拽移动 · 滚轮 / 滑块缩放 · 双击还原</div>
                    <div className="ccZoom">
                        <span>缩放</span>
                        <Slider
                            min={MIN_ZOOM}
                            max={MAX_ZOOM}
                            step={0.01}
                            value={crop.z}
                            disabled={!natural}
                            onChange={(v: number) => {
                                const S = stageSize
                                setCrop(prev => zoomCrop(prev, v / prev.z, S / 2, S / 2, W, H, S))
                            }}
                        />
                        <span className="ccZoomVal">{crop.z.toFixed(2)}×</span>
                    </div>
                    <div className="ccNote">
                        建议使用长边 ≥1200px 的图片，放大后更清晰（上传时会压缩到 800×600）。
                    </div>
                </div>

                <div className="ccPreviews">
                    <div className="ccPreviewItem">
                        <div className="ccPreviewLabel">首页置顶轮播</div>
                        <div className="ccPreviewFrame" style={{ aspectRatio: CAROUSEL_ASPECT }}>
                            <img src={displaySrc} style={previewImgStyle} />
                        </div>
                    </div>
                    <div className="ccPreviewItem">
                        <div className="ccPreviewLabel">首页文章卡片</div>
                        <div className="ccPreviewFrame" style={{ aspectRatio: CARD_ASPECT }}>
                            <img src={displaySrc} style={previewImgStyle} />
                        </div>
                    </div>
                    <div className="ccPreviewNote">预览与线上使用同一段裁剪样式；详情页横幅（更宽）同样套用该参数。</div>
                </div>
            </div>
        </Modal>
    )
}

export default CoverCropModal

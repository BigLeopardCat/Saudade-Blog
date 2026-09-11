/**
 * 封面裁剪弹窗（焦点 + 缩放），零新依赖纯手写。
 *
 * 与 GitHub 选头像同思路：编辑区就是裁剪窗本身（比例 = 线上该展示位的比例），
 * 窗内图片可拖拽移动、滚轮/滑块/捏合缩放，右侧预览窗用**与线上完全相同的一段 CSS**
 * （object-fit:cover + coverCropStyle）实时渲染，保证「预览即所得」——参数里不含比例，
 * 同一组参数在各处自动适配（见 utils/coverCrop.ts 的推导）。
 *
 * 20260912 拆两套参数：置顶轮播（1:1）与文章卡片（16:9）各占一个页签。两个页签各挂一个
 * 独立的受控子组件 CropStage，**aspect 只作为 prop 存在于自己的实例里** —— 从类型上杜绝
 * 「在交互回调里读到另一个页签的比例」这类错。确认时回传两套参数 + 各自的 dirty 标记
 * （dirty = 用户在这次打开里动过这一套），由父组件决定哪些字段真正回传后端。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal, Slider, Tabs } from 'antd'
import { resolveApiAssetUrl } from '../../utils/runtimeApi'
import {
    CARD_ASPECT,
    CAROUSEL_ASPECT,
    DEFAULT_CROP,
    MAX_ZOOM,
    MIN_ZOOM,
    coverCropStyle,
    cropWindowInImage,
    panCrop,
    zoomCrop,
    type CoverCrop,
    type CropViewport,
} from '../../utils/coverCrop'
import './index.sass'

/** 详情页顶部横幅的比例（≈3.5:1，随视口在 2:1~4:1 间漂移，仅作预览示意） */
const BANNER_ASPECT = 3.5

export interface CoverCropResult {
    /** 置顶轮播那套 */
    carousel: CoverCrop
    /** 文章卡片那套（详情页横幅同用） */
    card: CoverCrop
    /** 本次打开中用户是否动过某一套（未动 = 父组件不必回传，保持后端原值/回退链） */
    dirty: { carousel: boolean; card: boolean }
}

interface CoverCropModalProps {
    open: boolean
    /** 封面原始 URL（后端返回形态），显示时经 resolveApiAssetUrl 解析 */
    src: string
    /** 打开时置顶轮播那套的初值；null/缺省 = 默认（居中，不放大） */
    initialCarousel?: CoverCrop | null
    /** 打开时文章卡片那套的初值 */
    initialCard?: CoverCrop | null
    onCancel: () => void
    onConfirm: (result: CoverCropResult) => void
}

type TabKey = 'carousel' | 'card'

const round3 = (c: CoverCrop): CoverCrop => ({
    x: Number(c.x.toFixed(3)),
    y: Number(c.y.toFixed(3)),
    z: Number(c.z.toFixed(3)),
})

/** 预览图片的样式：与线上同一段 CSS（coverCropStyle） */
const previewImgStyle = (crop: CoverCrop): React.CSSProperties => ({
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
    ...coverCropStyle(crop),
})

interface CropStageProps {
    /** 裁剪窗的宽高比（= 线上该展示位的比例） */
    aspect: number
    crop: CoverCrop
    onChange: (next: CoverCrop) => void
    /** 已解析的图片 URL */
    src: string
    /** 图片自然尺寸（父组件预载一次，两个页签共用一份） */
    natural: { w: number; h: number } | null
    loadErr: boolean
}

/**
 * 单个页签的编辑舞台（受控）。
 * 交互只用 cropRef/sizeRef/onChangeRef 读最新值——原生 wheel 监听一旦订阅就长期有效，
 * 若闭包捕获 crop，滚轮会出现「跳」；把 crop 放进依赖又会让每次缩放都重订阅。
 */
const CropStage: React.FC<CropStageProps> = React.memo(({ aspect, crop, onChange, src, natural, loadErr }) => {
    const stageRef = useRef<HTMLDivElement>(null)
    // 舞台实测尺寸（css 像素），几何换算全部实时依赖它
    const [size, setSize] = useState({ width: 0, height: 0 })
    const cropRef = useRef(crop)
    cropRef.current = crop
    const sizeRef = useRef(size)
    sizeRef.current = size
    const onChangeRef = useRef(onChange)
    onChangeRef.current = onChange
    // 指针状态：拖拽平移 + 双指捏合（与 zoomOverlay 同套路）
    const pointers = useRef(new Map<number, { x: number; y: number }>())
    const pinchDist = useRef(0)

    // 舞台实测尺寸。两个坑：
    //  1) 用 ResizeObserverEntry.contentRect — getBoundingClientRect 会被 antd 弹窗入场
    //     的 transform: scale() 污染（上一轮踩过）；
    //  2) 非激活页签被 antd Tabs 以 display:none 隐藏，量到 0 必须丢弃，
    //     否则切回来之前图片会消失一帧。
    useEffect(() => {
        const el = stageRef.current
        if (!el) return
        const ro = new ResizeObserver(([entry]) => {
            const cr = entry?.contentRect
            if (!cr || cr.width <= 0 || cr.height <= 0) return
            setSize(prev =>
                Math.abs(prev.width - cr.width) < 0.5 && Math.abs(prev.height - cr.height) < 0.5
                    ? prev
                    : { width: cr.width, height: cr.height },
            )
        })
        ro.observe(el)
        return () => ro.disconnect()
    }, [])

    const W = natural?.w ?? 0
    const H = natural?.h ?? 0
    // 舞台像素 → 变换用的视口（宽高须与 aspect 自洽：height ≈ width / aspect，由 CSS 保证）
    const viewOf = (): CropViewport => ({ width: sizeRef.current.width, height: sizeRef.current.height, aspect })

    // 滚轮缩放：必须原生监听并 passive:false —— React 18 在根容器把 wheel 注册为 passive，
    // onWheel 里 preventDefault() 无效（页面会跟着滚）。同 zoomOverlay.ts 的处理。
    useEffect(() => {
        const el = stageRef.current
        if (!el || !natural) return
        const onWheel = (e: WheelEvent) => {
            e.preventDefault()
            const r = el.getBoundingClientRect()
            const ax = e.clientX - r.left
            const ay = e.clientY - r.top
            const factor = Math.exp(-e.deltaY * 0.0016)
            onChangeRef.current(zoomCrop(cropRef.current, factor, ax, ay, natural.w, natural.h, viewOf()))
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return () => el.removeEventListener('wheel', onWheel)
        // viewOf/cropRef/onChangeRef 读的都是 ref，无需进依赖
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [natural, aspect])

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
        if (pointers.current.size === 1) {
            onChange(panCrop(crop, dx, dy, natural.w, natural.h, viewOf()))
        } else if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()]
            const d = Math.hypot(a.x - b.x, a.y - b.y)
            const r = stageRef.current?.getBoundingClientRect()
            if (pinchDist.current > 0 && d > 0) {
                const ax = (a.x + b.x) / 2 - (r?.left ?? 0)
                const ay = (a.y + b.y) / 2 - (r?.top ?? 0)
                onChange(zoomCrop(crop, d / pinchDist.current, ax, ay, natural.w, natural.h, viewOf()))
            }
            pinchDist.current = d
        }
    }

    const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        pointers.current.delete(e.pointerId)
        if (pointers.current.size === 0) pinchDist.current = 0
    }

    // 舞台内绘制：把裁剪窗（图片像素坐标）按 kx/ky 放大到舞台像素坐标直接定位，不做 transform
    // （更精确、无子像素误差）。非方舞台下 kx/ky 不再相等——用 9/16 的卡片窗给方形舞台的
    // 老公式会画歪。
    const win = natural ? cropWindowInImage(W, H, aspect, crop) : null
    const kx = win && win.w > 0 && size.width > 0 ? size.width / win.w : 1
    const ky = win && win.h > 0 && size.height > 0 ? size.height / win.h : 1

    return (
        <>
            <div
                className="ccStage"
                ref={stageRef}
                style={{ aspectRatio: aspect }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onDoubleClick={() => onChange({ ...DEFAULT_CROP })}
            >
                {natural && win && (
                    <img
                        className="ccStageImg"
                        src={src}
                        draggable={false}
                        style={{
                            left: -win.x * kx,
                            top: -win.y * ky,
                            width: W * kx,
                            height: H * ky,
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
                        const c = cropRef.current
                        onChange(zoomCrop(c, v / c.z, sizeRef.current.width / 2, sizeRef.current.height / 2, W, H, viewOf()))
                    }}
                />
                <span className="ccZoomVal">{crop.z.toFixed(2)}×</span>
            </div>
        </>
    )
})
CropStage.displayName = 'CropStage'

const CoverCropModal: React.FC<CoverCropModalProps> = ({
    open,
    src,
    initialCarousel,
    initialCard,
    onCancel,
    onConfirm,
}) => {
    const [activeKey, setActiveKey] = useState<TabKey>('carousel')
    const [carousel, setCarouselCrop] = useState<CoverCrop>(DEFAULT_CROP)
    const [card, setCardCrop] = useState<CoverCrop>(DEFAULT_CROP)
    const [dirty, setDirty] = useState<{ carousel: boolean; card: boolean }>({ carousel: false, card: false })
    const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
    const [loadErr, setLoadErr] = useState(false)

    // initial* 用 ref 取最新值，避免父组件每次渲染换对象把初始化 effect 反复触发
    const initialRef = useRef({ carousel: initialCarousel, card: initialCard })
    initialRef.current = { carousel: initialCarousel, card: initialCard }

    const displaySrc = resolveApiAssetUrl(src)

    // 打开时：两套参数各自取初值（重置 dirty）+ 预载图片拿自然尺寸
    useEffect(() => {
        if (!open) return
        let cancelled = false
        setActiveKey('carousel')
        setCarouselCrop({ ...(initialRef.current.carousel ?? DEFAULT_CROP) })
        setCardCrop({ ...(initialRef.current.card ?? DEFAULT_CROP) })
        setDirty({ carousel: false, card: false })
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

    // 页签回调一律 useCallback 稳定引用：否则 React.memo 的 CropStage 每次都照样重渲染
    const changeCarousel = useCallback((next: CoverCrop) => {
        setCarouselCrop(next)
        setDirty(d => (d.carousel ? d : { ...d, carousel: true }))
    }, [])
    const changeCard = useCallback((next: CoverCrop) => {
        setCardCrop(next)
        setDirty(d => (d.card ? d : { ...d, card: true }))
    }, [])

    // 重置只作用于当前页签；这是用户显式动作 → 计 dirty（否则 0.5/0.5/1 传不出去）
    const handleReset = () => {
        if (activeKey === 'carousel') changeCarousel({ ...DEFAULT_CROP })
        else changeCard({ ...DEFAULT_CROP })
    }

    const handleConfirm = () => {
        onConfirm({ carousel: round3(carousel), card: round3(card), dirty })
    }

    const stageAndPreview = (
        aspect: number,
        value: CoverCrop,
        onChange: (next: CoverCrop) => void,
        previews: React.ReactNode,
    ) => (
        <div className="ccBody">
            <div className="ccEditor">
                <CropStage
                    aspect={aspect}
                    crop={value}
                    onChange={onChange}
                    src={displaySrc}
                    natural={natural}
                    loadErr={loadErr}
                />
            </div>
            <div className="ccPreviews">{previews}</div>
        </div>
    )

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
                <Button key="reset" onClick={handleReset} disabled={!natural}>重置</Button>,
                <Button key="cancel" onClick={onCancel}>取消</Button>,
                <Button key="ok" type="primary" disabled={!natural} onClick={handleConfirm}>确定</Button>,
            ]}
        >
            <Tabs
                className="ccTabs"
                activeKey={activeKey}
                onChange={k => setActiveKey(k as TabKey)}
                items={[
                    {
                        key: 'carousel',
                        label: '首页置顶轮播',
                        children: stageAndPreview(
                            CAROUSEL_ASPECT,
                            carousel,
                            changeCarousel,
                            <>
                                <div className="ccPreviewItem">
                                    <div className="ccPreviewLabel">首页置顶轮播（1:1）</div>
                                    <div className="ccPreviewFrame" style={{ aspectRatio: CAROUSEL_ASPECT }}>
                                        <img src={displaySrc} style={previewImgStyle(carousel)} />
                                    </div>
                                </div>
                                <div className="ccPreviewNote">
                                    这一套只影响首页顶部的置顶轮播。没在这里调过也不影响：线上会跟随「文章卡片」那套参数。
                                </div>
                            </>,
                        ),
                    },
                    {
                        key: 'card',
                        label: '文章卡片 / 详情页',
                        children: stageAndPreview(
                            CARD_ASPECT,
                            card,
                            changeCard,
                            <>
                                <div className="ccPreviewItem">
                                    <div className="ccPreviewLabel">首页文章卡片（16:9）</div>
                                    <div className="ccPreviewFrame" style={{ aspectRatio: CARD_ASPECT }}>
                                        <img src={displaySrc} style={previewImgStyle(card)} />
                                    </div>
                                </div>
                                <div className="ccPreviewItem">
                                    <div className="ccPreviewLabel">文章详情页顶部横幅（≈{BANNER_ASPECT}:1）</div>
                                    <div className="ccPreviewFrame" style={{ aspectRatio: BANNER_ASPECT }}>
                                        <img src={displaySrc} style={previewImgStyle(card)} />
                                    </div>
                                </div>
                                <div className="ccPreviewNote">
                                    这一套用于首页文章卡片与文章详情页顶部横幅（移动端卡片更窄更长，同一组参数自动适配）。
                                </div>
                            </>,
                        ),
                    },
                ]}
            />
            <div className="ccNote">
                建议使用长边 ≥1200px 的图片，放大后更清晰（上传时会压缩到 800×600）。
            </div>
        </Modal>
    )
}

export default CoverCropModal

/**
 * 头像裁剪弹窗（20260922 个人中心一期）。
 *
 * 「按 GitHub 来」= 选图 → **方形裁剪**（拖动/滚轮缩放）→ 确认 → 上传**裁切后的成品**。
 * 所以这里与封面裁剪弹窗（CoverCropModal）的取向不同：封面存的是**参数**（同一组参数要在
 * 1:1 轮播 / 16:9 卡片 / 横幅三处自适应，见 utils/coverCrop.ts 头注），头像只有一个展示位、
 * 且要落到 `user.avatar` 一个 URL 上，所以这里**烘焙成方图**再上传。
 *
 * 复用 utils/coverCrop 的那套几何——它是比例无关的，方形只是一个 aspect=1 的实例：
 *   · 编辑区 = 正方形舞台里的 `<img>` + coverCropStyle(crop)：**预览即所得**（与导出同一套公式）
 *   · 导出   = cropWindowInImage(W, H, 1, crop) 取方形窗在图片里的像素框，drawImage 到方画布
 * 二者同源，不存在"看着在中间、导出来偏了"。
 *
 * 输出固定 JPEG（画布烘焙天然是静态图——GIF 会丢掉动画，这是有意的：头像不需要动图，
 * 后端也只当普通图片下发）。后端仍会按字节头校验类型与 2MiB 上限（见 routes/profile.rs）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal, Slider } from 'antd'
import {
    DEFAULT_CROP,
    MAX_ZOOM,
    MIN_ZOOM,
    clampZoom,
    coverCropStyle,
    cropWindowInImage,
    panCrop,
    zoomCrop,
    type CoverCrop,
} from '../../utils/coverCrop'
import './index.sass'

/** 导出边长（px）。头像最大展示位是个人中心的 96px 与头部的 40px，512 足够、体积也小 */
const OUT_SIZE = 512
/** 原始文件上限：手机上随手一张照片就可能 8-10MB，超过这个数直接劝退（裁完也只有几百 KB） */
const MAX_SOURCE_BYTES = 12 * 1024 * 1024

interface AvatarCropModalProps {
    open: boolean
    /** 用户选中的原始文件（父组件持有这份状态，见 onPickFile） */
    file: File | null
    /** 用户在弹窗里点了「换一张」并选好了文件——父组件更新 file（弹窗随 effect 复位重裁） */
    onPickFile: (f: File) => void
    /** 确认：回传裁切后的成品（JPEG） */
    onConfirm: (blob: Blob) => void
    onCancel: () => void
    /** 父组件上传中：禁用确认按钮，防重复提交 */
    uploading?: boolean
    /** 夜间：弹窗挂在 body 下拿不到 .frontDark 祖先，主题类名要由 rootClassName 自带 */
    dark?: boolean
}

const AvatarCropModal = ({ open, file, onPickFile, onConfirm, onCancel, uploading, dark }: AvatarCropModalProps) => {
    const [crop, setCrop] = useState<CoverCrop>(DEFAULT_CROP)
    const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
    /** 图片本身读不出来（加载失败/尺寸为 0/画布烘焙失败）——此时舞台没有可用内容 */
    const [loadErr, setLoadErr] = useState('')
    /** 选中的文件不合格（类型/体积）——**不碰当前正在裁的图**，只在下面提示一句 */
    const [pickErr, setPickErr] = useState('')
    const [url, setUrl] = useState('')
    /** 导出失败（画布不可用等）时的兜底提示——不静默失败 */
    const [baking, setBaking] = useState(false)

    const stageRef = useRef<HTMLDivElement>(null)
    const imgRef = useRef<HTMLImageElement>(null)
    const cropRef = useRef(crop)
    cropRef.current = crop

    // objectURL 生命周期：每次换文件新建、卸载/关闭时释放（不释放会一直占着原图内存）
    useEffect(() => {
        if (!file) {
            setUrl('')
            setNatural(null)
            return
        }
        setLoadErr('')
        setCrop(DEFAULT_CROP)
        setNatural(null)
        const u = URL.createObjectURL(file)
        setUrl(u)
        return () => URL.revokeObjectURL(u)
    }, [file])

    // 打开即重置（上次拖到边上的焦点不该带到下一张图上）
    useEffect(() => {
        if (open) {
            setCrop(DEFAULT_CROP)
            setLoadErr('')
            setPickErr('')
        }
    }, [open, file])

    /** 舞台像素尺寸 + aspect=1（coverCrop 的交互几何要求自洽：height ≈ width/aspect） */
    const viewport = useCallback(() => {
        const el = stageRef.current
        if (!el) return null
        const r = el.getBoundingClientRect()
        if (r.width <= 0) return null
        return { width: r.width, height: r.height, aspect: 1 }
    }, [])

    // 滚轮缩放：原生监听（React 的 onWheel 是被动监听，preventDefault 无效，页面会跟着滚）
    useEffect(() => {
        const el = stageRef.current
        if (!el || !open || !natural) return
        const onWheel = (e: WheelEvent) => {
            e.preventDefault()
            const v = viewport()
            if (!v) return
            const r = el.getBoundingClientRect()
            const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08
            setCrop((c) =>
                zoomCrop(c, factor, e.clientX - r.left, e.clientY - r.top, natural.w, natural.h, v),
            )
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return () => el.removeEventListener('wheel', onWheel)
    }, [open, natural, viewport])

    // 拖动：pointer capture（手指/鼠标同一套；离开舞台也不丢）
    const dragRef = useRef<{ id: number; x: number; y: number } | null>(null)
    const onPointerDown = (e: React.PointerEvent) => {
        if (!natural) return
        dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    }
    const onPointerMove = (e: React.PointerEvent) => {
        const d = dragRef.current
        const v = viewport()
        if (!d || d.id !== e.pointerId || !natural || !v) return
        const dx = e.clientX - d.x
        const dy = e.clientY - d.y
        dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
        setCrop((c) => panCrop(c, dx, dy, natural.w, natural.h, v))
    }
    const endDrag = (e: React.PointerEvent) => {
        if (dragRef.current?.id === e.pointerId) dragRef.current = null
    }

    /** 烘焙：把方形裁剪窗那一块画进方画布 → JPEG Blob */
    const bake = async (): Promise<Blob | null> => {
        const img = imgRef.current
        if (!img || !natural) return null
        const win = cropWindowInImage(natural.w, natural.h, 1, cropRef.current)
        const canvas = document.createElement('canvas')
        canvas.width = OUT_SIZE
        canvas.height = OUT_SIZE
        const ctx = canvas.getContext('2d')
        if (!ctx) return null
        // 白底打底：PNG 透明区域转 JPEG 会变黑，头像位上是深色页背景，白底更自然
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, OUT_SIZE, OUT_SIZE)
        ctx.drawImage(img, win.x, win.y, win.w, win.h, 0, 0, OUT_SIZE, OUT_SIZE)
        return await new Promise<Blob | null>((resolve) =>
            canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9),
        )
    }

    const handleConfirm = async () => {
        setBaking(true)
        try {
            const blob = await bake()
            if (!blob) {
                setLoadErr('图片处理失败，请换一张试试')
                return
            }
            onConfirm(blob)
        } finally {
            setBaking(false)
        }
    }

    const handlePickChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0]
        e.target.value = '' // 让同一个文件能再次触发 change
        if (!f) return
        if (!f.type.startsWith('image/')) {
            setPickErr('请选择图片文件')
            return
        }
        if (f.size > MAX_SOURCE_BYTES) {
            setPickErr('原图太大了（最大 12MB），请先压缩或换一张')
            return
        }
        setPickErr('')
        // 文件状态归父组件持有（它还要在确认后负责上传）
        onPickFile(f)
    }

    return (
        <Modal
            open={open}
            onCancel={onCancel}
            title="裁剪头像"
            width={520}
            centered
            maskClosable={!uploading}
            footer={null}
            rootClassName={dark ? 'avatarCropRoot ucDark' : 'avatarCropRoot'}
            destroyOnClose
        >
            <div className="avatarCrop">
                <div
                    className="acStage"
                    ref={stageRef}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                >
                    {url && !loadErr && (
                        <img
                            ref={imgRef}
                            className="acImg"
                            src={url}
                            alt="待裁剪的头像"
                            draggable={false}
                            style={coverCropStyle(crop)}
                            onLoad={(e) => {
                                const el = e.currentTarget
                                if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                                    setNatural({ w: el.naturalWidth, h: el.naturalHeight })
                                } else {
                                    setLoadErr('这张图读不出尺寸，请换一张')
                                }
                            }}
                            onError={() => setLoadErr('图片加载失败，请换一张')}
                        />
                    )}
                    {/* 方框角标：提示"这是裁切边界"，也压住图片边缘（拖动时不至于看不出范围） */}
                    <span className="acCorner acCornerTl" />
                    <span className="acCorner acCornerTr" />
                    <span className="acCorner acCornerBl" />
                    <span className="acCorner acCornerBr" />
                </div>

                {loadErr ? (
                    <p className="acErr">{loadErr}</p>
                ) : (
                    <>
                        <div className="acZoom">
                            <span>缩放</span>
                            <Slider
                                min={MIN_ZOOM}
                                max={MAX_ZOOM}
                                step={0.01}
                                value={crop.z}
                                disabled={!natural}
                                onChange={(z) => setCrop((c) => ({ ...c, z: clampZoom(z) }))}
                            />
                        </div>
                        <p className="acTip">拖动图片调整位置，滚轮或滑块缩放</p>
                    </>
                )}

                <div className="acActions">
                    <label className="acRepick">
                        换一张
                        <input type="file" accept="image/*" onChange={handlePickChange} />
                    </label>
                    {pickErr && <span className="acPickErr">{pickErr}</span>}
                    <div className="acActionsRight">
                        <Button onClick={onCancel} disabled={uploading}>
                            取消
                        </Button>
                        <Button
                            type="primary"
                            onClick={handleConfirm}
                            loading={uploading || baking}
                            disabled={!natural || !!loadErr}
                        >
                            确定
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    )
}

export default AvatarCropModal

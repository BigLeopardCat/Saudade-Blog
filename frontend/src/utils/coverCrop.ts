/**
 * 文章封面裁剪参数（焦点 + 缩放）
 *
 * 后端 note 表存三个可空列：
 *   cover_focus_x / cover_focus_y : 焦点在图片内的归一化坐标，0..1（0.5 = 居中）
 *   cover_zoom                    : 在 object-fit:cover 基准之上的额外放大倍数，1..4
 * 三者全为 null = 从未设置 ⇒ 不输出任何样式，渲染与改造前逐像素一致（老文章零回归）。
 *
 * 渲染等价关系（任意窗口 w×h，图片 W×H，cover 缩放比 s = max(w/W, h/H)）：
 *   object-position: x% y%; transform-origin: x% y%; transform: scale(z)
 *   ⇔ 图片按 cover 放大 z 倍后，图片 (x,y) 点对齐窗口 (x,y) 点 —— 焦点永不偏移、窗口无空隙。
 *   推导：object-position:x% 使图片内容点 u 落在 X(u) = (u−x)·W·s + x·w；
 *        再以窗口内 x·w 为原点放大 z 倍 ⇒ X'(u) = x·w + (u−x)·W·s·z，等价于 cover 比 s·z 且对齐相同。
 * 关键性质：窗口比例 a = w/h 不出现在参数里 ⇒ 同一组参数在 1:1 轮播 / ≈1.82:1 卡片 /
 *          ≈3.5:1 详情横幅自动适配，这也是「存参数」而非「烘焙新图」的原因。
 */

import type { CSSProperties } from 'react'
import type { MotionStyle } from 'framer-motion'

export interface CoverCrop {
    x: number
    y: number
    z: number
}

/** 后端 DTO 里的三个字段（可选，null = 未设置） */
export interface CoverCropRow {
    coverFocusX?: number | null
    coverFocusY?: number | null
    coverZoom?: number | null
}

/** 默认参数：渲染结果与改造前的居中 cover 完全一致 */
export const DEFAULT_CROP: CoverCrop = { x: 0.5, y: 0.5, z: 1 }

/** 首页置顶轮播窗口比例 */
export const CAROUSEL_ASPECT = 1
/** 首页文章卡片窗口比例（真实桌面宽下 ≈1.82:1，预览取 16:9 近似） */
export const CARD_ASPECT = 16 / 9

export const MIN_ZOOM = 1
export const MAX_ZOOM = 4

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
export const clamp01 = (v: number): number => clamp(v, 0, 1)
export const clampZoom = (v: number): number => clamp(v, MIN_ZOOM, MAX_ZOOM)

/** 是否为默认参数（等价于不输出样式） */
export const isDefaultCrop = (crop: CoverCrop): boolean =>
    crop.x === DEFAULT_CROP.x && crop.y === DEFAULT_CROP.y && crop.z === DEFAULT_CROP.z

/** 焦点百分比字符串，供 object-position / transform-origin 共用 */
const posPair = (crop: CoverCrop): string => `${crop.x * 100}% ${crop.y * 100}%`

/**
 * 后端 DTO → 裁剪参数。三字段任一缺失/非有限数 → null（= 未设置，按居中 cover 渲染）。
 * 越界值夹回合法范围（服务端也夹，这里兜住历史脏数据）。
 */
export const cropFromRow = (row?: CoverCropRow | null): CoverCrop | null => {
    if (!row) return null
    const { coverFocusX: x, coverFocusY: y, coverZoom: z } = row
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
    return { x: clamp01(x), y: clamp01(y), z: clampZoom(z) }
}

/**
 * 普通 <img>(object-fit: cover) 的裁剪样式。无参数/默认参数 → {}（不产生任何渲染差异）。
 */
export const coverCropStyle = (crop: CoverCrop | null): CSSProperties => {
    if (!crop || isDefaultCrop(crop)) return {}
    return {
        objectPosition: posPair(crop),
        transform: `scale(${crop.z})`,
        transformOrigin: posPair(crop),
    }
}

/**
 * framer-motion <motion.img> 的裁剪样式。
 * 必须走 motion 的变换值体系：motion 自己写 style.transform，内联 transform 字符串会被覆盖；
 * 且 transformOrigin 属性会被 motion 用默认 50% 50% 覆写，只能用 originX/originY
 * （framer-motion 11 的 transformValueTypes 里 originX/originY = progressPercentage，0..1 恰好转成百分比，
 *  正好等于归一化焦点）。
 */
export const coverCropMotionStyle = (crop: CoverCrop | null): MotionStyle => {
    if (!crop || isDefaultCrop(crop)) return {}
    return {
        objectPosition: posPair(crop),
        scale: crop.z,
        originX: crop.x,
        originY: crop.y,
    }
}

/**
 * 裁剪窗在图片像素坐标中的几何（编辑器绘制用）。
 * aspect = 窗口宽高比 a = w/h。
 */
export const cropWindowInImage = (
    W: number,
    H: number,
    aspect: number,
    crop: CoverCrop,
): { w: number; h: number; x: number; y: number } => {
    const w = Math.min(W, aspect * H) / crop.z
    const h = Math.min(W / aspect, H) / crop.z
    return { w, h, x: crop.x * (W - w), y: crop.y * (H - h) }
}

/** 焦点可移动的余量（图片尺寸 − 裁剪窗尺寸）；为 0 时该轴无需平移 */
export const freeSpace = (W: number, H: number, aspect: number, crop: CoverCrop): { x: number; y: number } => {
    const win = cropWindowInImage(W, H, aspect, crop)
    return { x: W - win.w, y: H - win.h }
}

/**
 * 裁剪编辑器（方形裁剪窗，aspect = 1）的交互几何。
 * dx/dy = 指针屏幕位移(px)；ax/ay = 锚点相对舞台左上角的像素坐标；S = 舞台边长(px)。
 */

/** 拖拽平移：图片右移 ⇔ 裁剪窗在图片内左移 ⇒ 焦点 x 减小。k = 图片像素→屏幕像素 */
export const panCrop = (crop: CoverCrop, dx: number, dy: number, W: number, H: number, S: number): CoverCrop => {
    const win = cropWindowInImage(W, H, 1, crop)
    const k = S / win.w
    const free = freeSpace(W, H, 1, crop)
    return {
        z: crop.z,
        x: free.x > 1e-6 ? clamp01(crop.x - dx / k / free.x) : crop.x,
        y: free.y > 1e-6 ? clamp01(crop.y - dy / k / free.y) : crop.y,
    }
}

/** 以舞台内 (ax, ay) 为锚缩放：锚点下的图片内容点缩放前后停在同一屏幕位置 */
export const zoomCrop = (crop: CoverCrop, factor: number, ax: number, ay: number, W: number, H: number, S: number): CoverCrop => {
    const z = clampZoom(crop.z * factor)
    if (z === crop.z) return crop
    const w0 = cropWindowInImage(W, H, 1, crop)
    const w1 = cropWindowInImage(W, H, 1, { ...crop, z })
    const fx = clamp01(ax / S)
    const fy = clamp01(ay / S)
    const x1 = w0.x + fx * (w0.w - w1.w)
    const y1 = w0.y + fy * (w0.h - w1.h)
    const free = freeSpace(W, H, 1, { ...crop, z })
    return {
        z,
        x: free.x > 1e-6 ? clamp01(x1 / free.x) : 0.5,
        y: free.y > 1e-6 ? clamp01(y1 / free.y) : 0.5,
    }
}

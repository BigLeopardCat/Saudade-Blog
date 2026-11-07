import type { CSSProperties } from 'react'
import type { MotionStyle } from 'framer-motion'

export interface CoverCrop {
    x: number
    y: number
    z: number
    fit?: 'cover' | 'contain'
}

export interface CoverCropRow {
    coverFocusX?: number | null
    coverFocusY?: number | null
    coverZoom?: number | null
    coverFit?: 'cover' | 'contain' | null
    carouselFocusX?: number | null
    carouselFocusY?: number | null
    carouselZoom?: number | null
    carouselFit?: 'cover' | 'contain' | null
}

export const DEFAULT_CROP: CoverCrop = { x: 0.5, y: 0.5, z: 1 }
export const COMPLETE_COVER: CoverCrop = { ...DEFAULT_CROP, fit: 'contain' }

export const CAROUSEL_ASPECT = 1
export const CARD_ASPECT = 16 / 9
export const DETAIL_ASPECT = 3.5

export const MIN_ZOOM = 1
export const MAX_ZOOM = 4

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
export const clamp01 = (v: number): number => clamp(v, 0, 1)
export const clampZoom = (v: number): number => clamp(v, MIN_ZOOM, MAX_ZOOM)

export const isDefaultCrop = (crop: CoverCrop): boolean =>
    crop.x === DEFAULT_CROP.x && crop.y === DEFAULT_CROP.y && crop.z === DEFAULT_CROP.z

const posPair = (crop: CoverCrop): string => `${crop.x * 100}% ${crop.y * 100}%`

export const cropFromRow = (row?: CoverCropRow | null): CoverCrop | null => {
    if (!row) return null
    if (row.coverFit === 'contain') return { ...COMPLETE_COVER }
    const { coverFocusX: x, coverFocusY: y, coverZoom: z } = row
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
    return { x: clamp01(x), y: clamp01(y), z: clampZoom(z) }
}

export const carouselCropFromRow = (row?: CoverCropRow | null): CoverCrop | null => {
    if (!row) return null
    if (row.carouselFit === 'contain') return { ...COMPLETE_COVER }
    const fallback = row.carouselFit === 'cover' ? { ...DEFAULT_CROP } : null
    const { carouselFocusX: x, carouselFocusY: y, carouselZoom: z } = row
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return fallback
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return fallback
    return { x: clamp01(x), y: clamp01(y), z: clampZoom(z) }
}

export const carouselCropOf = (row?: CoverCropRow | null): CoverCrop | null =>
    carouselCropFromRow(row) ?? cropFromRow(row)

export const coverCropStyle = (crop: CoverCrop | null): CSSProperties => {
    if (crop?.fit === 'contain') return { objectFit: 'contain', objectPosition: 'center', transform: 'none' }
    if (!crop || isDefaultCrop(crop)) return {}
    return {
        objectPosition: posPair(crop),
        // z=1 时缩放是恒等变换，不输出（免得平白多一个合成层/包含块）
        ...(crop.z === 1 ? {} : { transform: `scale(${crop.z})`, transformOrigin: posPair(crop) }),
    }
}

export const coverCropMotionStyle = (crop: CoverCrop | null): MotionStyle => {
    if (crop?.fit === 'contain') return { objectFit: 'contain', objectPosition: 'center', scale: 1 }
    if (!crop || isDefaultCrop(crop)) return {}
    return {
        objectPosition: posPair(crop),
        ...(crop.z === 1 ? {} : { scale: crop.z, originX: crop.x, originY: crop.y }),
    }
}

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

export const freeSpace = (W: number, H: number, aspect: number, crop: CoverCrop): { x: number; y: number } => {
    const win = cropWindowInImage(W, H, aspect, crop)
    return { x: W - win.w, y: H - win.h }
}

export interface CropViewport {
    width: number
    height: number
    aspect: number
}

export const panCrop = (crop: CoverCrop, dx: number, dy: number, W: number, H: number, view: CropViewport): CoverCrop => {
    const win = cropWindowInImage(W, H, view.aspect, crop)
    const kx = view.width > 0 && win.w > 0 ? view.width / win.w : 1
    const ky = view.height > 0 && win.h > 0 ? view.height / win.h : 1
    const free = freeSpace(W, H, view.aspect, crop)
    return {
        z: crop.z,
        x: free.x > 1e-6 ? clamp01(crop.x - dx / kx / free.x) : crop.x,
        y: free.y > 1e-6 ? clamp01(crop.y - dy / ky / free.y) : crop.y,
    }
}

export const zoomCrop = (crop: CoverCrop, factor: number, ax: number, ay: number, W: number, H: number, view: CropViewport): CoverCrop => {
    const z = clampZoom(crop.z * factor)
    if (z === crop.z) return crop
    const w0 = cropWindowInImage(W, H, view.aspect, crop)
    const w1 = cropWindowInImage(W, H, view.aspect, { ...crop, z })
    // Normalize the zoom anchor within the preview viewport.
    const fx = view.width > 0 ? clamp01(ax / view.width) : 0.5
    const fy = view.height > 0 ? clamp01(ay / view.height) : 0.5
    const x1 = w0.x + fx * (w0.w - w1.w)
    const y1 = w0.y + fy * (w0.h - w1.h)
    const free = freeSpace(W, H, view.aspect, { ...crop, z })
    return {
        z,
        x: free.x > 1e-6 ? clamp01(x1 / free.x) : 0.5,
        y: free.y > 1e-6 ? clamp01(y1 / free.y) : 0.5,
    }
}

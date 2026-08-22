#!/usr/bin/env python3
"""真实月球照片 → 月面反照率纹理采样（第 34 轮）

用法:
    python3 sample_moon_tex.py <照片路径> [--out moon_tex.ts] [--size 192] [--flip-x]

原理:
1. 月盘检测：亮度阈值找亮圆，质心 + 90 分位半径，再迭代微调圆心
2. 光照归一化：月盘内每像素亮度 ÷ 大邻域均值（uniform_filter，核≈月盘半径 28%）。
   照片的明暗是「光照 shading × 表面反照率」，大邻域均值近似光照梯度，
   除法后留下反照率（月海暗、高地亮、环形山暗坑+亮缘）——与月相光照无关，
   任何月相下都能直接用
3. 重投影：反照率图映射到 192×192 正方形（月盘外 alpha=0，nx 右=月面东、ny 上=北）
4. 输出：base64 PNG 到 moon_tex.ts + 三张诊断图（原图 ROI / 反照率全图 / 采样纹理）

输出文件（均在脚本同目录）:
- moon_tex.ts           前端引入的纹理数据（export const MOON_TEX = "data:image/png;base64,..."）
- moon_diag1_roi.png    原图月盘裁剪
- moon_diag2_albedo.png 光照归一化后的反照率全图（应无全局明暗渐变，只有表面纹理）
- moon_diag3_tex.png    192×192 采样纹理（月盘外透明）
"""
import argparse
import base64
import io
import math
import os

import numpy as np
from PIL import Image, ImageFilter


def find_moon(gray: np.ndarray):
    """返回 (cx, cy, r)：亮圆质心与半径（像素坐标，y 向下）"""
    h, w = gray.shape
    th = max(40, float(gray.max()) * 0.45)
    ys, xs = np.nonzero(gray > th)
    if len(xs) < 100:
        raise RuntimeError("未检测到月盘：亮区域过小（照片里月亮应占较大面积且偏亮）")
    cx, cy = float(xs.mean()), float(ys.mean())
    r = float(np.percentile(np.hypot(xs - cx, ys - cy), 90))
    # 圆心迭代：以当前 r 为界，取盘内较亮像素重新算质心（3 次收敛）
    yy, xx = np.indices((h, w))
    for _ in range(3):
        m = (xx - cx) ** 2 + (yy - cy) ** 2 < (r * 0.98) ** 2
        band = gray[m]
        if band.size < 50:
            break
        m2 = m & (gray > float(band.mean()) * 0.55)
        if m2.sum() < 50:
            break
        cx, cy = float(xx[m2].mean()), float(yy[m2].mean())
    return cx, cy, r


def albedo_map(gray: np.ndarray, r: float) -> np.ndarray:
    """光照归一化：局部亮度 ÷ 大邻域均值 → 反照率（0..1）
    用 PIL BoxBlur 近似均匀核（半径 ≈ 月盘半径的 14%，平滑光照渐变）"""
    rad = max(2, int(r * 0.14))
    low = np.asarray(Image.fromarray(gray.astype(np.uint8)).filter(ImageFilter.BoxBlur(rad)),
                     dtype=np.float64)
    low = np.maximum(low, 1.0)
    alb = np.clip(gray / low, 0.0, 2.0)
    lo, hi = float(alb.min()), float(alb.max())
    alb = (alb - lo) / max(1e-6, hi - lo)
    # 第 34 轮补丁：轻度平滑去噪（照片高 ISO 噪点会在小月亮上形成"老人脸"麻点）
    # + 对比度拉伸（×1.35 围绕中位，让月海/环形山结构清晰）再裁剪回 0..1
    med = float(np.median(alb))
    alb = np.clip((alb - med) * 1.35 + med, 0.0, 1.0)
    img = Image.fromarray(np.clip(alb * 255, 0, 255).astype(np.uint8))
    alb = np.asarray(img.filter(ImageFilter.BoxBlur(1)), dtype=np.float64) / 255.0
    return alb


def build_tex(gray: np.ndarray, alb: np.ndarray, cx: float, cy: float, r: float,
              size: int, flip_x: bool) -> np.ndarray:
    """重投影反照率到 size×size 纹理（RGBA，月盘外透明）"""
    out = np.zeros((size, size, 4), dtype=np.uint8)
    yy, xx = np.mgrid[0:size, 0:size]
    nx = (xx + 0.5) / size * 2 - 1  # 右=月面东
    ny = (yy + 0.5) / size * 2 - 1  # 上=月面北（图像 y 向下，映射时取反）
    inside = nx * nx + ny * ny <= 1
    if flip_x:
        nx = -nx
    px = np.clip(((nx[inside] * r) + cx).astype(int), 0, gray.shape[1] - 1)
    py = np.clip((cy - ny[inside] * r).astype(int), 0, gray.shape[0] - 1)
    a = alb[py, px]
    v = np.round(a * 255).astype(np.uint8)
    out[..., 0][inside] = v
    out[..., 1][inside] = v
    out[..., 2][inside] = v
    out[..., 3][inside] = 255
    return out


def main():
    ap = argparse.ArgumentParser(description="真实月球照片 → 反照率纹理")
    ap.add_argument("photo", help="月亮照片路径（月盘应占画面较大面积）")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "moon_tex.ts"))
    ap.add_argument("--size", type=int, default=192, help="纹理边长（默认 192）")
    ap.add_argument("--flip-x", action="store_true", help="左右镜像（望远镜/镜像照片用）")
    args = ap.parse_args()

    img = Image.open(args.photo).convert("L")
    gray = np.asarray(img, dtype=np.float64)
    if gray.shape[0] > 2000 or gray.shape[1] > 2000:  # 降采样加速
        s = min(2000 / gray.shape[0], 2000 / gray.shape[1])
        gray = np.asarray(img.resize((int(gray.shape[1] * s), int(gray.shape[0] * s)), Image.LANCZOS),
                          dtype=np.float64)
    cx, cy, r = find_moon(gray)
    alb = albedo_map(gray, r)
    tex = build_tex(gray, alb, cx, cy, r, args.size, args.flip_x)

    # 输出 TS（base64 PNG）
    png = Image.fromarray(tex)
    buf = io.BytesIO()
    png.save(buf, "PNG", optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode()
    ts = (
        "// 由 sample_moon_tex.py 从真实月球照片采样生成（第 34 轮）——勿手改。\n"
        f"// 照片: {os.path.basename(args.photo)}  纹理: {args.size}×{args.size}  反照率灰度,月盘外透明\n"
        'export const MOON_TEX = "data:image/png;base64,' + b64 + '";\n'
    )
    with open(args.out, "w") as f:
        f.write(ts)
    print(f"OK: {args.out} ({len(b64) // 1024} KiB base64)")

    # 诊断图
    d = os.path.dirname(os.path.abspath(__file__))
    lo = int(cx - r - 4), int(cy - r - 4)
    hi = int(cx + r + 4), int(cy + r + 4)
    Image.fromarray(np.clip(gray[int(lo[1]):int(hi[1]), int(lo[0]):int(hi[0])], 0, 255).astype(np.uint8)).save(
        os.path.join(d, "moon_diag1_roi.png"))
    Image.fromarray(np.clip(alb * 255, 0, 255).astype(np.uint8)).save(os.path.join(d, "moon_diag2_albedo.png"))
    Image.fromarray(tex).save(os.path.join(d, "moon_diag3_tex.png"))
    print(f"diag: moon_diag1_roi.png / moon_diag2_albedo.png / moon_diag3_tex.png（月盘中心 ({cx:.0f},{cy:.0f}) 半径 {r:.0f}px）")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""真实月球照片 → 月面反照率纹理采样（第 34 轮）

⚠️ **20260926 起本脚本不再被引用**——线上那条路已换成程序化绘制
（`moon_surface.ts`，同目录）。换掉的原因有两条：① 它的产物是一张**固定 192×192**
的采样表，而月盘的设备像素数随屏幕走（1080p ≈ 130、retina ≈ 260），192 被放大本身就是
糊的；② 源照片已丢，这张表既不能再采样也无法重做。

**留着它的唯一理由是配方**：万一哪天源照片回来了、且想要"真照片的月面"而不是程序化
的，跑一遍这个脚本就能重采样出纹理，前端把 `moon_surface.ts` 的 `moonAlbedo()` 换成
读纹理即可（渲染侧不需要动——月盘 sprite 与设备整像素落位都与反照率来源无关）。

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
    # 第 36 轮：麻点根治。前版 BoxBlur(1)+×1.35 拉伸后，照片高频细节在
    # 108px 小月亮上仍呈逐像素随机波动（2px 邻域差方均值 67，视觉=麻子）：
    # ① 平滑半径加大到 3（7×7 核，特征尺度 ≈8px，月海/环形山形状保留，
    #    逐像素噪声被抹平）；
    # 第 37 轮：平滑后低频对比放开——拉伸 ×1.8（围绕中位），月海/高地
    # 明暗差接近真实月球反照率（0.07-0.18），且不产生逐像素麻点
    med = float(np.median(alb))
    alb = np.clip((alb - med) * 1.8 + med, 0.0, 1.0)
    img = Image.fromarray(np.clip(alb * 255, 0, 255).astype(np.uint8))
    alb = np.asarray(img.filter(ImageFilter.BoxBlur(3)), dtype=np.float64) / 255.0
    return alb


def denoise_tex(a: np.ndarray, inside: np.ndarray) -> np.ndarray:
    """纹理域去噪（第 38 轮，20260905 用户反馈"噪声太多，只留明显深坑"）

    前版在照片全分辨率域做 7×7 平滑后最近邻重投影——照片上千像素月盘上
    7px 核≈无，重投影又无预滤波，tex 上仍是逐像素颗粒。本函数改在纹理域
    （192×192，1 tex px ≈ 若干屏幕 px）处理：
    1. a1 = BoxBlur(1)（3×3）：单像素颗粒先与邻域融合——颗粒会失掉大半
       对比度，而 2px 以上的真环形山基本保形（只蚀掉 1px 缘）
    2. s = BoxBlur(5)（11×11 结构层）：月海级大暗区/高地渐变归入 s，抹平
       细碎反照率起伏
    3. d = s − a1 逐像素偏离；|d| ≤ th 的像素是"颗粒/浅纹"→ 归平到结构层
       s（彻底消除麻点）；|d| > th 的像素是真实月貌的大尺度偏离（深坑暗
       部与它的亮缘都保留）→ 原样 a1（坑壁/缘口仍锐利）
    阈值 th 按噪声幅度自适应：d 的绝对中位差 MAD ×1.4826 ≈ σ（对颗粒型
    噪声稳健），3.0σ 以上才算"明显深坑"（高斯噪声超 3σ 概率仅 ~0.27%，
    残存孤立亮点极少，且被步骤 1 压过的颗粒到不了这个幅度）。半径/阈值由
    20260905 调参扫描定稿：blur5 + 3σ → keep≈5%（明显环形山 + 月海/高地
    过渡缘），平坦区颗粒均值 ≈0.003（255 级下不足 1 级）；半径更大/阈值
    更高收益趋平，只多蚀掉真实环形山
    """
    med = float(np.median(a))
    pad = np.where(inside, a, med)  # 盘外填盘内中位：BoxBlur 不吞盘外暗边
    arr = np.clip(pad * 255, 0, 255).astype(np.uint8)
    im = Image.fromarray(arr)
    a1 = np.asarray(im.filter(ImageFilter.BoxBlur(1)), dtype=np.float64) / 255.0
    s = np.asarray(im.filter(ImageFilter.BoxBlur(5)), dtype=np.float64) / 255.0
    d = s - a1
    sig = 1.4826 * float(np.median(np.abs(d[inside] - np.median(d[inside]))))
    th = max(0.02, 3.0 * sig)  # 下限 0.02：tex 域 255 级下 ≈5 级，防 MAD≈0 全平
    keep = np.abs(d) > th
    return np.where(keep, a1, s), keep, float(th)


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
    a = np.full((size, size), np.nan)  # 盘外 NaN
    a[inside] = alb[py, px]
    a, _keep, _th = denoise_tex(a, inside)
    a = np.where(inside, a, 0.0)  # 盘外归 0（alpha 已透明，值仅防 NaN 脏数据）
    v = np.round(a * 255).astype(np.uint8)
    out[..., 0] = v
    out[..., 1] = v
    out[..., 2] = v
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

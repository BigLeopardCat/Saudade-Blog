#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""月面反照率配方：真实月球照片 → 256×256 的 8 位反照率表（20261001，第 42 轮）。

    python3 build_moon_albedo.py              # 用同目录的 moon_source.jpg
    python3 build_moon_albedo.py --fetch      # 重新从 NASA SVS 下载源图再跑
    python3 build_moon_albedo.py --size 192   # 换网格边长（默认 256，见下）

产物：`moon_albedo_data.ts`（**生成文件，勿手改**）+ `/tmp/moon_albedo_*.png` 诊断图。

## 它替代了什么

第 34–37 轮那张照片纹理（`sample_moon_tex.py` → `moon_tex.ts`，固定 192×192 的 base64
PNG）有两个致命处：**源照片丢了**（既不能再采样也改不动参数），以及 PNG 必须过
`<img>`/canvas **异步解码**——于是有了 `loadMoonTex` + `texApplied` 那一整套"纹理就绪后
补画静态层"，第 37 轮的病灶正出在那里。第 40 轮把它整个换成了程序化生成。

第 42 轮（用户：「留言板月亮采用贴图渲染实现逼真效果」）回到照片，但换个装法：
**直接把反照率表编成 base64 的 8 位灰度字节，同步 `atob` 解出来**。没有 PNG、没有
canvas、没有异步，`moon_surface.ts` 的 `moonAlbedo()` 仍是**同步纯函数**（node 里可直接
测）。`sample_moon_tex.py` 已删除（它的产物形态不再存在；要看旧实现 `git show` 取）。

## 管线（每一步都是"照片不是反照率"的补偿）

1. **找月盘**：亮度阈值（`max(30, 0.5·峰值)`）取质心 + 95 分位半径，再按 97 分位半径
   迭代 4 轮收敛（照片是满月、盘外纯黑，这一套足够稳）。
2. **消光照 = 反照率**：除以**盘内大核 box blur 的局部均值**（半径 0.42·r）。
   这一步去的是**照明**（月球正面的光照梯度 / 边缘限暗），留下**反射率**。模糊核比月海还大，
   所以月海/高地的对比不会被它抹掉；`low` 只在盘内求（分母是掩膜加权和），盘外不参与。
   ⚠️ 这正是"反照率里不许再有光照项"的那条纪律——渲染侧 `buildMoonSprite` 已经按光方向
   做过一次，照片里再带一份就是两次（第 40 轮的程序化生成器头注里写着同一条）。
3. **重投影到月盘空间**：目标网格 nx∈[-1,1]（右 = 月面东）、ny∈[-1,1]（上 = 月面北），
   每个 texel 取照片里**对应那一像素**。采样前先按 texel 步长做一次 box 预模糊
   （**抗锯齿**：不然是最近邻点采样，细纹理全变摩尔纹）。采样半径夹在 0.985·r 以内
   ——掩膜边缘外 `low→0`，除下去反照率会爆表，夹一下最省事。
4. **盘外四角**：按方向的**径向投影**填（把 (nx,ny) 投到 0.99·r 的圆上取色）。渲染侧只采
   内切圆、本来用不到，但表里留着 0/NaN 迟早被别的消费方读出脏值（旧版留的就是"0.5"）。
5. **编码**：按盘内中位数归一（中位 = 1.0，纯为可读）→ 线性窗口 `ALB_LO..ALB_HI` → 0..255。
   **刻意不做对比拉伸**：渲染侧 `ensureMoonAlbedo` 会按盘内 p5/p95 自适应标定到
   `0.45..1.28`，任何写在这一侧的线性拉伸都会被它原样抵消（第 40 轮的教训）。这一侧只
   负责"别削顶"：窗口取实测分位数的外侧一点，把极值夹住而不是拉深。

## 源图（已随本轮入库：`moon_source.jpg`）

NASA SVS 5048《Moon Phase and Libration, 2023》的满月帧（Dial-A-Moon），
<https://svs.gsfc.nasa.gov/vis/a000000/a005000/a005048/phase_full.1571_print.jpg>
（1024×1024，第 1571 帧 = 满月）。数据来自 LRO 的 LOLA/LROC。

    Credit: NASA's Scientific Visualization Studio
    Visualizer: Ernie Wright (USRA) / Producer: David Ladd (USRA) / Scientist: Noah Petro (NASA/GSFC)
    https://svs.gsfc.nasa.gov/5048/

选它的三个理由：① 是**正面受光**（观者视角的圆盘，不带相位阴影，第 2 步的除法才不会
把明暗交界一起除掉）；② 北在上、东在右（危海那团小暗斑在右上、第谷的亮辐射纹在下方——
与站点用的 `nx 右=东 / ny 上=北` 一致，**不需要翻转**）；③ NASA 影像是公有领域，
可以入库、可以随仓库公开。

⚠️ 换源图=换月亮。若日后要换，**必须重跑本脚本并重新目检**（见"验证"一节），
别只替换 jpg——`--fetch` 只认上面那一个 URL。
"""

import argparse
import base64
import math
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SRC = os.path.join(HERE, "moon_source.jpg")
DEFAULT_OUT = os.path.join(HERE, "moon_albedo_data.ts")
SRC_URL = ("https://svs.gsfc.nasa.gov/vis/a000000/a005000/a005048/"
           "phase_full.1571_print.jpg")

# 存储窗口：归一化反照率线性映射到 0..255。取在实测 p1/p99 的外侧（本版 p1=0.618、
# p99=1.488）——两头都留出余量，被夹住的是极少数像素、不是月海。
#
# 触顶的那一撮（实测 1136 px ≈ 盘内 2.2%）**永远不会以平台的样子上屏**：渲染侧
# `ensureMoonAlbedo` 按盘内 p95（实测 1.377）做自适应标定，而 p95 < ALB_HI ⇒ 屏幕上
# 的峰值由 p95 决定、夹顶在它上面还留着余量。所以这里不必为了"零夹取"去抬 ALB_HI
# （抬了只会让 99% 的像素少掉几档量化），只要保证夹住的是一小撮即可。
ALB_LO, ALB_HI = 0.60, 1.45

# 采样半径上限：掩膜是 0.995·r，采到掩膜外的话 `low→0` ⇒ 反照率爆表
SRC_R_SAFE = 0.985
# 盘外四角的径向投影半径
SRC_R_FILL = 0.99


def box_blur(a, rad):
    """可分离 box blur（cumsum 实现），边界按边界值扩展。O(N²) 与核大小无关。"""
    if rad < 1:
        return a.copy()
    k = 2 * rad + 1
    p = np.pad(a, ((rad, rad), (0, 0)), mode="edge")
    c = np.cumsum(p, axis=0)
    out = (c[k - 1:, :] - np.concatenate([np.zeros((1, a.shape[1])), c[:-k, :]], axis=0)) / k
    p = np.pad(out, ((0, 0), (rad, rad)), mode="edge")
    c = np.cumsum(p, axis=1)
    out = (c[:, k - 1:] - np.concatenate([np.zeros((a.shape[0], 1)), c[:, :-k]], axis=1)) / k
    return out


def detect_disc(g):
    """亮度阈值 + 质心/半径迭代。返回 (cx, cy, r)，单位是源图像素。"""
    h, w = g.shape
    yy, xx = np.indices((h, w))
    th = max(30.0, float(g.max()) * 0.5)
    ys, xs = np.nonzero(g > th)
    if xs.size == 0:
        raise SystemExit("源图里找不到月亮（没有像素亮过阈值）")
    cx, cy = float(xs.mean()), float(ys.mean())
    r = float(np.percentile(np.hypot(xs - cx, ys - cy), 95))
    for _ in range(4):
        m = (xx - cx) ** 2 + (yy - cy) ** 2 < (r * 0.99) ** 2
        cx, cy = float(xx[m].mean()), float(yy[m].mean())
        r = float(np.percentile(np.hypot(xx[m] - cx, yy[m] - cy), 97))
    return cx, cy, r


def smooth1d(a, rad):
    """一维 box 平滑（两端按边界值扩展，避免把月心/月缘的剖面拉偏）。"""
    if rad < 1:
        return a.copy()
    k = 2 * rad + 1
    p = np.pad(a, (rad, rad), mode="edge")
    c = np.cumsum(p)
    return (c[k - 1:] - np.concatenate([[0.0], c[:-k]])) / k


def albedo_map(g, cx, cy, r):
    """照片 → 反照率（消掉照明）：除以**按半径分箱的中位亮度剖面**。

    满月照片里的照明是**径向对称**的（太阳在盘心正后方 ⇒ 入射角=反射角=离盘心的张角），
    所以限暗/光照梯度恰好是一条 `p(radial)` 曲线。取每个半径环上的**中位**亮度（月海只占
    少数，中位被高地占住）当这条曲线，除一下就把照明去干净了。

    为什么不用局部均值（第 34 轮的老做法，大核 box blur）：核半径一大就变成**高通滤波**，
    把尺度与核相当的月海（雨海半径 0.28·r，与 0.42·r 的核同量级）连反照率一起抹掉——
    实测雨海只比周围暗 1%、静海反而更亮，月海对比全丢。径向剖面法只动"随半径变化"的那
    一部分，**月海/辐射纹的地物对比一个不少**（本版实测归一化：雨海 1.070、澄海 0.698、
    危海 0.764、第谷辐射纹 1.234，高地普遍 1.0~1.15）。

    ⚠️ 上面这组数只当"有没有把月海抹平"的普查看。`FEATURES` 那张表按日心坐标正交投影摆框
    取均值，而源图是**某一时刻的真实视角**——天平动可达 ±8°，投影到盘上约 0.15 个盘半径，
    比 0.07 半宽的取样框还大。具体某个海的位置会**挪出框**（实测静海/澄海的框就落在邻区
    上），**别拿单点数值写测试**。要写判据请用半球尺度的统计量（东西/南北不对称、最亮最暗
    百分位的质心方位），那些事实尺度足够大，天平动挪不动。
    """
    h, w = g.shape
    yy, xx = np.indices((h, w))
    d = np.hypot(xx - cx, yy - cy)
    inside = d <= r * 0.995
    idx = np.clip(np.round(d).astype(int), 0, int(np.ceil(r)))

    def profile(keep):
        out = np.zeros(idx.max() + 1)
        for i in range(idx.max() + 1):
            sel = keep & (idx == i)
            if sel.any():
                out[i] = np.median(g[sel])
        for i in range(1, len(out)):          # 空箱沿用内圈值，免得除出 0
            if out[i] == 0:
                out[i] = out[i - 1]
        return smooth1d(out, 4)

    # 中位剖面会被**第谷辐射纹**这类大尺度亮区抬高（它的尺度与"随半径变化"那一部分重叠，
    # 是径向剖面法唯一会误伤的东西）：抬高后的剖面在南部高原那一带偏高 ⇒ 除下来辐射纹
    # 几乎消失（实测第一版 1.19，和普通高地分不开）。迭代加权：每轮只用"上一轮残差在
    # ±12% 以内"的像素重新拟合——被排除的是辐射纹（亮）与最深处的月海（暗），
    # 剩下的正是"典型月面"，3 轮足够收敛。
    keep = inside.copy()
    res = np.ones_like(g)
    for it in range(4):
        prof = profile(keep)
        res = g / np.maximum(prof[idx], 1.0)
        if it < 3:
            keep = inside & (res >= 0.88) & (res <= 1.12)
    return res


def resample(alb, cx, cy, r, n):
    """反照率全图 → n×n 月盘空间（nx 右=东、ny 上=北）。返回 (tex, mask)。"""
    step = 2 * r / n
    pre = box_blur(alb, max(1, int(round(step / 2))))     # 抗锯齿预模糊（一个 texel 宽）
    h, w = alb.shape
    tex = np.zeros((n, n), np.float64)
    mask = np.zeros((n, n), bool)
    for py in range(n):
        ny = 1 - ((py + 0.5) / n) * 2
        for px in range(n):
            nx = ((px + 0.5) / n) * 2 - 1
            rho = math.hypot(nx, ny)
            if rho <= 1.0:
                f = min(1.0, SRC_R_SAFE / max(rho, 1e-9))    # 盘内：夹在掩膜以内
                mask[py, px] = True
            else:
                f = SRC_R_FILL / max(rho, 1e-9)              # 盘外四角：径向投影填
            sx = int(round(cx + nx * f * r))
            sy = int(round(cy - ny * f * r))
            if 0 <= sx < w and 0 <= sy < h:
                tex[py, px] = pre[sy, sx]
    return tex, mask


# 诊断用：几个地物的日心坐标（纬度 φ、经度 λ，东正西负）→ 正交投影 (cosφ·sinλ, sinφ)。
# 只用来**打印**实测亮度，不进产物。⚠️ 因天平动（见 `albedo_map` 尾注）单点数值会挪框，
# **别据此写测试**——它只用于"整体看一遍月海有没有被抹平"。
FEATURES = [
    ("风暴洋 Procellarum", 18.4, -57.4),
    ("雨海 Imbrium", 32.8, -15.6),
    ("静海 Tranquillitatis", 8.5, 31.4),
    ("澄海 Serenitatis", 28.0, 17.5),
    ("危海 Crisium", 17.0, 59.1),
    ("丰富海 Fecunditatis", -7.8, 51.3),
    ("云海 Nubium", -21.3, -16.5),
    ("湿海 Humorum", -24.4, -38.6),
    ("第谷 Tycho（亮纹）", -43.3, -11.4),
    ("南部高地 60°S", -60.0, 0.0),
]


def seleno_to_disc(lat_deg, lon_deg):
    """(纬度, 经度) → 月盘归一化坐标 (nx 右=东 / ny 上=北)。"""
    la, lo = math.radians(lat_deg), math.radians(lon_deg)
    return math.cos(la) * math.sin(lo), math.sin(la)


def box_mean(tex, mask, nx, ny, half):
    n = tex.shape[0]
    x0 = int(max(0, math.floor(((nx - half + 1) / 2) * n)))
    x1 = int(min(n, math.ceil(((nx + half + 1) / 2) * n)))
    y0 = int(max(0, math.floor(((1 - (ny + half)) / 2) * n)))
    y1 = int(min(n, math.ceil(((1 - (ny - half)) / 2) * n)))
    box = tex[y0:y1, x0:x1]
    m = mask[y0:y1, x0:x1]
    return float(box[m].mean()) if m.any() else float("nan")


def emit_ts(path, n, q, stats):
    payload = base64.b64encode(q.reshape(-1).tobytes()).decode("ascii")
    lines = [payload[i:i + 96] for i in range(0, len(payload), 96)]
    # ⚠️ 必须写成**数组字面量 + join("")**，不能写成 `"a" + "b" + …` 的连加：连加在语法树上
    # 是 900 多层左嵌套的 BinaryExpression，`eslint . --ext ts,tsx`（CI 质量闸里那一步）解析
    # 它的时候会**爆调用栈**（实测 "Parsing error: Maximum call stack size exceeded"）——
    # 一条红的 ESLint 能让整个部署停下来。数组是平的，深度只有 2。
    body = ",\n".join('    "%s"' % s for s in lines)
    text = f'''/**
 * 月面反照率数据表（{n}×{n}，8 位灰度）——**由 `build_moon_albedo.py` 生成，勿手改**。
 *
 * 编码：`q/255 × (HI − LO) + LO` = 归一化反照率（盘内中位数为 1.0，越亮越高）。
 * 取向：**行主序**，行 0 = 月盘最北，列 0 = 月盘最西；x 向右 = 月面东、y 向下 = 月面南
 * （即"北在上、东在右"的照片朝向，与渲染侧 `fx = ((nx+1)/2)·N` / `fy = ((1−ny)/2)·N` 对齐）。
 * 盘内切圆以外的四角是**径向投影**填的（渲染侧不采样，只为不给消费方留脏值）。
 *
 * 源：NASA SVS 5048《Moon Phase and Libration, 2023》满月帧（LRO LOLA/LROC 数据）
 *     <{SRC_URL}>
 *     Credit: NASA's Scientific Visualization Studio（E. Wright / D. Ladd / N. Petro）
 * 本文件是**公有领域** NASA 影像的派生数据；同目录 `moon_source.jpg` 是原始输入。
 *
 * 生成参数：源图 {stats['src_size']}，月盘 圆心({stats['cx']:.1f},{stats['cy']:.1f}) r={stats['r']:.1f}；
 *          反照率 盘内 p1={stats['p1']:.3f} p50={stats['p50']:.3f} p99={stats['p99']:.3f}
 *          → 窗口 [{ALB_LO}, {ALB_HI}] 线性编码，夹顶/夹底各 {stats['clip_lo']*100:.2f}% / {stats['clip_hi']*100:.2f}%
 */
export const MOON_ALB_N = {n}
export const MOON_ALB_LO = {ALB_LO}
export const MOON_ALB_HI = {ALB_HI}
export const MOON_ALB_SOURCE = "{SRC_URL}"

/** base64 的 {n * n} 个字节（行主序）。分片只为 diff 可读，用前 `join("")` 拼回。
 *  ⚠️ **别改成字符串连加**（`"a" + "b" + …`）：900 多层左嵌套的表达式会让 ESLint 解析器
 *  爆调用栈，CI 的质量闸会红。数组是平的。 */
export const MOON_ALB_B64 = [
{body},
].join("")
'''
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return len(payload)


def main():
    ap = argparse.ArgumentParser(description="月面反照率配方（照片 → 8 位表）")
    ap.add_argument("--src", default=DEFAULT_SRC, help="源照片（默认同目录 moon_source.jpg）")
    ap.add_argument("--out", default=DEFAULT_OUT, help="产物 TS 路径")
    ap.add_argument("--size", type=int, default=256, help="网格边长（默认 256）")
    ap.add_argument("--fetch", action="store_true", help="先从 NASA SVS 重新下载源图")
    ap.add_argument("--diag", default="/tmp", help="诊断图输出目录（默认 /tmp，**别写进仓库**）")
    args = ap.parse_args()

    if args.fetch:
        import urllib.request
        print(f"下载 {SRC_URL}")
        urllib.request.urlretrieve(SRC_URL, args.src)

    if not os.path.exists(args.src):
        raise SystemExit(f"源照片不存在：{args.src}（用 --fetch 下载，或 --src 指定）")

    g = np.asarray(Image.open(args.src).convert("L"), dtype=np.float64)
    cx, cy, r = detect_disc(g)
    print(f"源图 {g.shape[1]}×{g.shape[0]}  月盘 圆心=({cx:.1f},{cy:.1f}) r={r:.1f}")

    alb = albedo_map(g, cx, cy, r)
    tex, mask = resample(alb, cx, cy, r, args.size)

    inside = tex[mask]
    p1, p50, p99 = (float(np.percentile(inside, p)) for p in (1, 50, 99))
    print(f"反照率（盘内）p1={p1:.3f} p5={np.percentile(inside, 5):.3f} "
          f"p50={p50:.3f} p95={np.percentile(inside, 95):.3f} p99={p99:.3f} "
          f"max={inside.max():.3f} min={inside.min():.3f}")

    # 径向分带均值：看边缘有没有爆表（爆了就是采到掩膜外了）
    n = args.size
    ny_i, nx_i = np.mgrid[0:n, 0:n]
    rho = np.hypot(((nx_i + 0.5) / n) * 2 - 1, 1 - ((ny_i + 0.5) / n) * 2)
    for lo, hi in [(0, 0.7), (0.7, 0.9), (0.9, 0.96), (0.96, 1.0)]:
        band = mask & (rho >= lo) & (rho < hi)
        if band.any():
            print(f"  径向 {lo:.2f}–{hi:.2f}: mean={tex[band].mean():.3f} "
                  f"max={tex[band].max():.3f}")

    norm = tex / max(p50, 1e-6)
    print("地物实测均值（归一化，供写测试/证伪用；镜像列 = 同一 nx 的南北对侧）：")
    for name, la, lo in FEATURES:
        fx, fy = seleno_to_disc(la, lo)
        print(f"  {name:<24} ({fx:+.3f},{fy:+.3f})  {box_mean(norm, mask, fx, fy, 0.07):.3f}"
              f"   南北镜像 {box_mean(norm, mask, fx, -fy, 0.07):.3f}"
              f"   东西镜像 {box_mean(norm, mask, -fx, fy, 0.07):.3f}")
    lim = mask & (rho > 0.8)
    print(f"  盘内中位 {np.median(inside) / max(p50,1e-6):.3f}；"
          f"左半 {norm[mask & (nx_i < n / 2)].mean():.3f} / 右半 {norm[mask & (nx_i >= n / 2)].mean():.3f}；"
          f"上半 {norm[mask & (ny_i < n / 2)].mean():.3f} / 下半 {norm[mask & (ny_i >= n / 2)].mean():.3f}")

    q = np.clip(np.round((norm - ALB_LO) / (ALB_HI - ALB_LO) * 255), 0, 255).astype(np.uint8)
    clip_lo = float((norm[mask] <= ALB_LO).mean())
    clip_hi = float((norm[mask] >= ALB_HI).mean())
    print(f"夹底 {clip_lo*100:.2f}% 夹顶 {clip_hi*100:.2f}%（都该是零头，大了就是窗口选窄了）")

    # 往返自检：解出来必须还是那张表（编码/解码差 ≤ 半个量化步长）
    back = q.astype(np.float64) / 255 * (ALB_HI - ALB_LO) + ALB_LO
    err = float(np.abs(back - np.clip(norm, ALB_LO, ALB_HI)).max())
    step = (ALB_HI - ALB_LO) / 255
    assert err <= step / 2 + 1e-9, f"往返误差 {err} > 半步长 {step/2}"
    assert np.isfinite(tex).all(), "反照率里有 NaN/Inf"

    stats = {"src_size": f"{g.shape[1]}×{g.shape[0]}", "cx": cx, "cy": cy, "r": r,
             "p1": p1, "p50": p50, "p99": p99, "clip_lo": clip_lo, "clip_hi": clip_hi}
    nchars = emit_ts(args.out, n, q, stats)
    print(f"写出 {args.out}（{n}×{n} 字节 → base64 {nchars} 字符）")

    os.makedirs(args.diag, exist_ok=True)
    Image.fromarray(q).resize(
        (n * 2, n * 2), Image.NEAREST).save(os.path.join(args.diag, "moon_albedo_tex.png"))
    v = np.clip((norm - ALB_LO) / (ALB_HI - ALB_LO), 0, 1)
    Image.fromarray((v * 255).astype(np.uint8)).resize(
        (n * 2, n * 2), Image.NEAREST).save(os.path.join(args.diag, "moon_albedo_norm.png"))
    print(f"诊断图：{args.diag}/moon_albedo_tex.png（编码后的表）、"
          f"{args.diag}/moon_albedo_norm.png（窗口拉伸便于目检）")


if __name__ == "__main__":
    sys.exit(main())

/* 水面（阶段 2）—— 倒影、菲涅尔、月光碎路、岸线浪花、河灯倒影。
 *
 * 这一层要解决的是"水看起来不像水"：原来的河面只有一层渐变 + 每帧 46 道均匀
 * 横线，**没有倒影**（天空/月亮/云在山脊上方的所有内容，水面上一个都看不到）。
 *
 * 三条物理根据，缺一条就退回"蓝色渐变色块"：
 *   ① 倒影：水面是镜面，天上有什么，水里就该有什么；
 *   ② 菲涅尔：掠射角（远、贴地平线）反射率 ≈0.85，垂直俯视（近、脚下）≈0.25
 *      —— 所以远端几乎全是天的颜色，近端才看得见水的本色。这一条最缺，
 *      也是"远看是镜子、近看是水"的根据；
 *   ③ 碎：镜面只存在于无风的水面。波浪把倒影逐行横向撕开，且越近撕得越狠
 *      （近处波在屏幕上的投影尺度大）。
 *
 * 成本控制：倒影整块**每 N 帧重建一次**（`reflTick`），逐帧只多一次 drawImage；
 * 破碎感靠重建时的逐行位移实现，不做逐帧的逐行重采样。
 *
 * 纯几何 + 纯函数的部分（`skyRowForWaterRow` / `waveShift` / `fresnelAt` /
 * `glitterAt`）都导出，好让判据在 node 里直接量，不必截图。 */

import { clamp01, fbm, fbm1, hash2, smoothstep } from "./noise";
import type { Geo, MoonGeom } from "./geo";

/* ══════════════════════ 一、倒影缓冲 ══════════════════════ */

/** 水面行 → 它反射的那条天空行（都是 CSS y）。
 *
 *  设视点高出水面 H，水面上一处距视点水平距离 D，则看该处的视线仰角 θ 满足
 *  `tanθ = H/D`。D→∞（屏幕上贴近地平线）时 θ→0，反射的是**地平线附近**的天；
 *  D→0（屏幕最下、脚下）时 θ→90°，反射的是**天顶**。
 *  所以源行在地平线之上的高度 `s(e)` 随 e=(y-yH)/(h-yH) 单调增，且在地平线附近
 *  被强烈压缩（cot 在 θ→0 处发散）—— 用 `e^1.35` 近似这条曲线。
 *
 *  注意这里**不需要** `scale(1,-1)` 翻转：s 本身就是"地平线之上的高度"，
 *  天越高（s 越大）→ 反射落在屏幕越下方（e 越大），正是镜像该有的次序。 */
export function skyRowForWaterRow(y: number, yH: number, h: number): number {
    const e = clamp01((y - yH) / (h - yH || 1e-9));
    return yH - yH * Math.pow(e, 1.35);
}

/** 某一水面行被波浪横向推开的像素数。近处（e→1）振幅大、远处趋近 0
 *  —— 远处波长在屏幕上被压扁到看不见，硬给振幅只会让远端糊成一片。
 *
 *  波长取 400-1500px（而不是几十像素的"细浪"）：位移是**逐条**加的，条高
 *  ≈(h-yH)/条数 ≈ 10-14px，波长太短时相邻条的相位差能到 0.5rad 以上，月盘倒影
 *  这种高对比竖边会被切成肉眼可见的**台阶**。长波长 + 更多条数才平滑。 */
export function waveShift(y: number, yH: number, h: number, phase: number, amp = 1): number {
    const e = clamp01((y - yH) / (h - yH || 1e-9));
    const a = (1.0 + 11 * e * e) * amp;
    return (
        a *
        (Math.sin(y * 0.0075 + phase * 1.7) * 0.55 +
            Math.sin(y * 0.0043 - phase * 1.05 + 1.7) * 0.3 +
            Math.sin(y * 0.0155 + phase * 2.6 + 3.1) * 0.15)
    );
}

/** 逐条的**明暗**调制 —— 这才是"碎"的主承载体。
 *
 *  一开始想用"逐行水平位移"做碎感，方向错了：位移只让倒影**歪**，不让它**断**。
 *  真水面上的月亮倒影是**一列断开的横短划**（波谷那几行根本照不到月亮），所以
 *  正解是按行把 alpha 压下去，让亮带之间留出暗缝。位移留在小量级，只负责"歪"。
 *  远处的波纹在屏幕上被压扁到看不见 ⇒ 远处趋近完整镜面，只在中近段碎。 */
export function reflRowAlpha(y: number, yH: number, h: number, phase: number): number {
    const e = clamp01((y - yH) / (h - yH || 1e-9));
    /* 频率随 e 增大：近处的波在屏幕上被投影放大，条纹本来就该更疏。
       固定频率时近端是 53px 一档，读成"百叶窗"（第一版实测）。 */
    const f = 0.055 + 0.075 * e;
    const a =
        Math.sin(y * f + phase * 2.2) * 0.62 +
        Math.sin(y * f * 0.41 - phase * 1.3 + 1.1) * 0.38;
    const chop = clamp01(0.5 - 0.5 * a); // 1 = 波谷（照不到月亮）
    /* 压到底：波谷那几行只留 6%，倒影因此真的**断开**成一条条横短划，
       而不是"亮一点暗一点的一块板"。远端（e→0）压得浅 —— 远处的波在屏幕上
       被压扁到看不见，那一带本来就接近完整镜面。 */
    const depth = 0.32 + 0.68 * e;
    return 1 - 0.94 * depth * chop;
}

/** 菲涅尔反射率：e=0（贴地平线、掠射）→ 0.58；e=1（脚下、近垂直）→ 0.14。
 *  物理上的掠射反射率接近 0.9，但**这里的源是天空、目标是深色河水**：照搬物理值
 *  会让整条河变成一块和天空一样亮的板，河水的本色全被盖掉（实测第一版就是这样，
 *  远端整片被抬到 45/255 的灰蓝，河读成雾）。电影里夜河的处理也一贯是压低的 ——
 *  保的是"远亮近暗"这条**比例**，不是绝对值。 */
export function fresnelAt(e: number): number {
    return 0.14 + 0.44 * Math.pow(1 - clamp01(e), 1.15);
}

/** 倒影条的条数：软渲染档减半。条数决定垂直映射的平滑度，不决定成本量级。 */
export const reflStrips = (soft: boolean) => (soft ? 30 : 96);

/** 重建后对整块做一次模糊（单位：缓冲的**设备像素**）。
 *
 *  为什么非有这一笔：条是**逐条**画的，每条一个水平位移，于是竖直方向上是分段
 *  常数。在月盘倒影那种高对比竖边上，分段常数 = 肉眼可见的锯齿轮廓（实测第一版
 *  就是这样，把月亮倒影切成了阶梯）。条数加到 96 只能把台阶做小、做不掉 ——
 *  一次模糊是唯一真正消除它的手段，而且顺带把"水面本来就是软的"这件事做对了。
 *  模糊量按条高给：条高 ≈ (h-yH)/条数 × q，取其一半。 */
const reflBlurPx = (geo: Geo, soft: boolean, q: number) =>
    Math.max(0.8, ((geo.h - geo.yH) / reflStrips(soft)) * q * 0.34);

/** 倒影的染色/压暗（`source-atop` 铺一层）。倒影不是"开了一扇看天的窗"：
 *  水会吸掉一部分、并把它染上水体的青蓝。不压这一层，倒影的亮部（月盘、月晕）
 *  会把河面读成一块发光的板。 */
const REFL_TINT = "rgba(5,12,30,0.46)";

export interface ReflBuild {
    cv: HTMLCanvasElement;
    q: number;
    yH: number;
    h: number;
    /** 本帧波相位（判据用） */
    phase: number;
}

/** 把 `sky`（含月盘、CSS 坐标与 baseBack 同源）镜像成水面倒影缓冲。
 *
 *  `sky` 必须**已经**把月盘画进去 —— baseBack 里只有月晕没有月盘（月盘 sprite
 *  是逐帧单独落屏的），只镜 baseBack 会得到一条"有光晕没有月亮"的倒影。 */
export function buildReflection(
    sky: HTMLCanvasElement,
    geo: Geo,
    quality: number,
    phase: number,
    soft: boolean,
    out?: HTMLCanvasElement
): ReflBuild {
    const { w, h, yH, margin: M } = geo;
    const q = quality;
    const rw = Math.max(2, Math.round(w * q));
    const rh = Math.max(2, Math.round((h - yH) * q));
    const cv = out ?? document.createElement("canvas");
    if (cv.width !== rw) cv.width = rw;
    if (cv.height !== rh) cv.height = rh;
    const g = cv.getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, rw, rh);
    g.setTransform(q, 0, 0, q, 0, 0);
    /* 之后一律用 **CSS 坐标**作画：水面区域的 CSS 原点 = (0, yH)。
       源的 CSS 原点与 baseBack 同源（其左上角是 (-M,-M)）。 */
    g.translate(0, -yH);

    /* 只算 ky：横向永远取满源图（含出血边），源 x 不需要换算。
       源图**只覆盖地平线以上那一条**（调用方按 `yH + 2M` 建缓冲）—— 采样的天空行
       是 `s ∈ [0, yH]`，河面那一半从来读不到。 */
    const ky = sky.height / (yH + 2 * M);
    const NS = reflStrips(soft);
    for (let i = 0; i < NS; i++) {
        const e0 = i / NS;
        const e1 = (i + 1) / NS;
        const y0 = yH + e0 * (h - yH);
        const y1 = yH + e1 * (h - yH);
        // 源带（CSS）：e 大 ⇒ 取更高的天
        const sTop = yH * Math.pow(e0, 1.35);
        const sBot = yH * Math.pow(e1, 1.35);
        const syCss = yH - sBot;
        const shCss = Math.max(0.5, sBot - sTop);
        /* 位移量 20261018 从 0.55 抬到 1.6：0.55 时近处整行的摆幅只有 ±6.6px，
           而这一屏有 1440px 宽 —— 镜子被"撕"得看不出来，倒影读成一张静态贴图。
           1.6 ⇒ 近处 ±19px、远端仍趋近 0（`waveShift` 的 e² 权重自带透视）。
           再大就开始把月盘倒影糊成一片，1.6 是"看得出在动"与"还认得出是什么"的交界。 */
        const dx = waveShift((y0 + y1) / 2, yH, h, phase, 1.6);
        g.globalAlpha = reflRowAlpha((y0 + y1) / 2, yH, h, phase);
        /* 源矩形在 sky 的**图像像素**里：CSS x → (x + M) * kx。
           横向取满（含出血边），目标同样铺满 w+2M，位移后不会露出未覆盖的缝。 */
        g.drawImage(
            sky,
            0,
            (syCss + M) * ky,
            sky.width,
            Math.max(0.5, shCss * ky),
            dx - M,
            y0,
            w + 2 * M,
            Math.max(0.5, y1 - y0)
        );
    }

    g.globalAlpha = 1;

    /* 染色/压暗：只在已经画上东西的像素上叠（`source-atop`）。 */
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = REFL_TINT;
    g.fillRect(-M, yH, w + 2 * M, h - yH + 1);
    g.globalCompositeOperation = "source-over";

    /* 一次模糊：抹掉"逐条位移"留下的竖直分段（见 reflBlurPx 的说明）。
       自己画自己 —— canvas 作为 drawImage 源时会在绘制前先快照，这是定义好的行为。 */
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.filter = `blur(${reflBlurPx(geo, soft, q).toFixed(2)}px)`;
    g.drawImage(cv, 0, 0, rw, rh);
    g.filter = "none";
    g.setTransform(q, 0, 0, q, 0, 0);
    g.translate(0, -yH);

    /* 菲涅尔 alpha 斜坡：`destination-in` 用一条竖直渐变把整块按行乘上反射率。
       渐变本身只依赖 (yH,h)，与波相位无关 ⇒ 每尺寸建一次即可。 */
    g.globalCompositeOperation = "destination-in";
    g.fillStyle = fresnelRamp(g, yH, h);
    g.fillRect(-M, yH, w + 2 * M, h - yH + 1);
    g.globalCompositeOperation = "source-over";
    g.setTransform(1, 0, 0, 1, 0, 0);

    return { cv, q, yH, h, phase };
}

let rampCache: { key: string; grad: CanvasGradient } | null = null;
/** 竖直菲涅尔斜坡（每尺寸建一次，别每帧 createGradient）。 */
export function fresnelRamp(g: CanvasRenderingContext2D, yH: number, h: number): CanvasGradient {
    const key = yH + "|" + h;
    if (rampCache && rampCache.key === key) return rampCache.grad;
    const grad = g.createLinearGradient(0, yH, 0, h);
    for (let i = 0; i <= 10; i++) {
        const e = i / 10;
        /* 最上面 6% 额外淡出：e=0 采到的是"地平线那一行天空"（远山雾纱/薄雾最亮
           的一带），直接以 0.62 的反射率铺在河面上，会沿 y=yH 拉出一条笔直的
           水平亮线 —— 水天过渡因此变成一道硬边。 */
        const a = fresnelAt(e) * smoothstep(0, 0.06, e);
        grad.addColorStop(e, `rgba(0,0,0,${a.toFixed(4)})`);
    }
    rampCache = { key, grad };
    return grad;
}

/** 每帧把倒影块贴回河面。只有一个 drawImage —— 破碎感在重建时就烘进去了。 */
export function drawReflection(ctx: CanvasRenderingContext2D, r: ReflBuild, geo: Geo): void {
    ctx.drawImage(r.cv, 0, r.yH, geo.w, r.h - r.yH);
}

/* ══════════════════════ 二、月光碎路 ══════════════════════ */

let colSp: HTMLCanvasElement | null = null;
/** 月光柱的横向羽化贴图（64×1，中间亮两侧落零）。
 *  逐条 `createLinearGradient` 是被头注纪律禁掉的，横向着色一律走这张贴图拉伸。 */
function columnSprite(): HTMLCanvasElement {
    if (colSp) return colSp;
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 1;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 64, 0);
    for (let i = 0; i <= 16; i++) {
        const u = i / 16;
        // cos² 羽化：中心 1、边缘 0，比线性落得更自然（线性会在两侧留一道折线）
        const a = Math.pow(Math.cos((u - 0.5) * Math.PI), 2);
        grad.addColorStop(u, `rgba(255,236,196,${a.toFixed(4)})`);
    }
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 1);
    colSp = c;
    return c;
}

/** 月光在水面上的**柱体**（碎光点下面那层连续的底）。
 *
 *  为什么非有这一层：把月盘按几何镜像进倒影缓冲，得到的是一个 120×217 的
 *  **实心椭圆**（`e^1.35` 的垂直压缩把 120px 的盘拉成 217px 高），落在河面上
 *  读成一块雾/一盏探照灯 —— 实测第一版就是这样。真实月光路的形状不是"月盘的
 *  镜像"而是**一列**：月亮的方位角在水面上是固定的（无限远光源，方位不随距离
 *  变），所以它只占**一列**；纵向之所以长，是因为水面的坡度分布把像沿视线方向
 *  摊开了。所以这里显式画一条"上窄下宽的暖色柱"，让碎光点落在它上面。 */
export function drawMoonColumn(
    ctx: CanvasRenderingContext2D,
    geo: Geo,
    moon: MoonGeom,
    t: number,
    reduce: boolean
): void {
    const { h, yH } = geo;
    const sp = columnSprite();
    const N = 30;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < N; i++) {
        const d0 = 0.2 + (i / N) * 0.9;
        const d1 = 0.2 + ((i + 1) / N) * 0.9;
        const u0 = geo.riverUAt(moon.x, d0);
        if (u0 === null) continue; // 该深度河道装不下月亮那一列 ⇒ 柱体自然被河岸裁掉
        const y0 = geo.riverY(d0);
        const y1 = geo.riverY(d1);
        if (y1 < yH - 2 || y0 > h + 20) continue;
        const e = clamp01((y0 - yH) / (h - yH));
        /* 整条月光路要**像一条蛇那样摆**，而不是钉死在一列上左右呼吸。
           20261018 之前柱体的中心 `cx` 完全不动，只有宽度在呼吸 —— 用户原话
           「河面的月光反光也接近静态开不出河面波动」。摆幅随 d² 张开（近处的水面
           坡度分布宽、亮点滑得远），相位随 d 走 ⇒ 得到的是"弯"不是"整体平移"。
           用一条**低频**正弦而不是 `waveShift`：柱体是几十条宽光带叠出来的，
           逐条高频抖动只会让边缘毛掉，读不出"整条路在游"。 */
        const sway = reduce ? 0 : Math.sin(t * 0.9 + d0 * 1.7) * (5 + 30 * d0 * d0);
        const cx = geo.riverX(u0, d0) + sway;
        /* alpha 随 d 增：近处的水面坡度分布更宽 ⇒ 摊得更亮。
           再乘菲涅尔 —— 柱体的**底子**也遵守"远亮近暗"这条物理，只是斜率比
           镜面倒影平缓（它是漫射的散射光，不是镜面反射）。 */
        let a = (0.055 + 0.2 * d0) * (0.5 + 0.7 * fresnelAt(e));
        if (a < 0.004) continue;
        /* 逐行再乘一次**破碎调制**（与倒影同一个函数、同一个相位）。
           少了这一笔，柱体是一条边缘干净的亮竖条 —— 读成一把光剑/探照灯
           （实测第二版就是这样），而不是"洒在水面上的月光"。真实月光路是被
           同一批波峰波谷切开的：波谷那几行照不到月亮，柱体因此断成一节节。
           相位与倒影一致（都取 `t*3.3`），两层才不会各断各的。 */
        a *= reflRowAlpha((y0 + y1) / 2, yH, h, t * 3.3);
        const wob = reduce ? 1 : 0.88 + 0.12 * Math.sin(t * 1.1 + i * 0.7);
        /* 两层：宽而淡的**晕** + 窄而亮的**芯**。
           只有一层时无论怎么调都读不对 —— 调宽了像探照灯、调窄了像一根竖线；
           真实月光路本来就是"一条亮芯 + 一圈散开的光"叠出来的。 */
        const hwH = (18 + 300 * d0 * d0) * (0.86 + 0.14 * Math.sin(t * 0.63 + d0 * 5.1));
        const hwC = 4 + 60 * d0 * d0;
        const dy = Math.max(1, y1 - y0);
        ctx.globalAlpha = a * 0.42 * wob;
        ctx.drawImage(sp, cx - hwH, y0, hwH * 2, dy);
        ctx.globalAlpha = a * 0.75 * wob;
        ctx.drawImage(sp, cx - hwC, y0, hwC * 2, dy);
    }
    ctx.restore();
}

/** 碎光点的解析参数（不存状态：全部由 (i, t) 的确定性哈希推出来，
 *  这样 resize / 重建不会让碎路"重抽一次签"）。 */
export function glitterAt(i: number, n: number, t: number, seed = 71) {
    const k = i / Math.max(1, n - 1);
    /* 深度**加抖动**：`k^1.16` 均匀铺出来的碎点在屏幕上近乎等距，读成一把
       等距的虚线尺子（实测第一版）。抖到 ±2 个步长就散开了。 */
    const dj = (hash2(i, 61, seed) - 0.5) * (1.48 / Math.max(1, n)) * 2.2;
    const d = Math.min(0.97, Math.max(0.16, 0.93 - Math.pow(k, 1.16) * 0.74 + dj)); // 近 0.93 → 远 0.19
    const f1 = 2.6 + hash2(i, 11, seed) * 5.4;
    const f2 = 0.9 + hash2(i, 17, seed) * 2.6;
    const ph = hash2(i, 13, seed) * Math.PI * 2;
    const a1 = Math.pow(0.5 + 0.5 * Math.sin(t * f1 + ph), 3);
    const a2 = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(t * f2 + ph * 1.7), 2);
    /* 离中线的散开量，归一化到 -1..1。取 `|s|^1.6` 而不是均匀分布：均匀分布
       把碎点铺成**等宽**的一条带，月光路因此读成一把虚线尺子（实测第一版就是
       这样）。幂次 <2 让大多数点仍贴着中线、少数甩到两侧，才有"路"的形状。 */
    const raw = (hash2(i, 5, seed) - 0.5) * 2;
    const spread = Math.sign(raw) * Math.pow(Math.abs(raw), 1.6);
    return {
        k,
        d,
        ph,
        flick: a1 * a2,
        spread,
        hero: hash2(i, 29, seed) > 0.9,
    };
}

/** 月光碎路：**集中在月亮所在的那一列**上。
 *
 *  原来那 46 道横线铺在河道中线（u=0.5）上，而月亮在 0.7w —— 碎光带和光源不在
 *  一列，读起来是"水面自己在发光"。物理上月亮在哪一列，碎路就在哪一列；而且
 *  月亮的倒影列在近地平线处会**跑出河道**（d→0 时河道只占 0.36w..0.66w，
 *  装不下 0.7w），所以碎路是从河道右缘切入、越近越宽的一条楔形 —— 这一条
 *  正是"月光洒在河上"最像的样子。 */
export function drawMoonGlitter(
    ctx: CanvasRenderingContext2D,
    geo: Geo,
    moon: MoonGeom,
    t: number,
    soft: boolean,
    reduce: boolean
): number {
    const { h, yH } = geo;
    const N = soft ? 90 : 220;
    let drawn = 0;
    ctx.save();
    ctx.lineCap = "round";
    for (let i = 0; i < N; i++) {
        const g = glitterAt(i, N, reduce ? 0 : t);
        if (g.flick < 0.03) continue;
        const u0 = geo.riverUAt(moon.x, g.d);
        if (u0 === null) continue;
        /* 碎光点必须**跟着波面走**。
           20261018 之前 `d` 与 `spread` 都是静态的（只由 i 推出来），于是每个碎点
           钉死在河面的一个位置上、只有亮度在闪 —— 整条月光路读成"一条固定在河面上
           的虚线尺子"，用户原话「接近静态开不出河面波动」。
           现在横向挂到**倒影用的同一条波场**上（`waveShift`），只是振幅放大：倒影
           那点位移是"把镜子撕歪"，碎路这点位移是"亮点在波面上滑"。远近不同振幅，
           所以近处摆得开、远处几乎不动 —— 那正是水面的透视。 */
        const y0 = geo.riverY(g.d);
        /* 相位与倒影、柱体的逐行破碎**用同一个**（`t * 3.3`）：三层的断口才会落在
           同一批波谷上。各用各的相位时，亮点落在柱体的暗缝里、倒影却在别处断开 ——
           三层各动各的，读出来是"三张独立的图在闪"，不是"一片水在动"。 */
        const wob = reduce ? 0 : waveShift(y0, yH, h, t * 3.3) * 4.0;
        const y =
            y0 +
            (reduce
                ? 0
                : Math.sin(y0 * 0.021 + t * 2.1 + g.ph) * (1.5 + 6 * g.d) +
                  waveShift(y0, yH, h, t * 3.3 + 0.9) * 1.1);
        if (y < yH - 2 || y > h + 8) continue;
        /* 横向散开按**屏幕像素**给，不按 u 给：u 的半宽在近处被河道宽度放大到
           1500px，同一个 ±0.04u 在 d=0.9 处是 ±130px、在 d=0.2 处只有 ±22px，
           形状完全失控。真实月光路的宽度由水面坡度分布决定、随距离张开 ——
           直接用 `12 + 250·d²` 描述这条张开（d=0.2 时全宽 48px、d=0.93 时 470px）。 */
        const halfW = 12 + 250 * g.d * g.d;
        const cx = geo.riverX(u0, g.d) + g.spread * halfW * (g.hero ? 0.55 : 1) + wob;
        /* 聚散：真实月光路有亮团也有空档，均匀铺满只会得到一条等亮的带。 */
        const clump = fbm1(g.d * 9.0, 2, 91);
        if (clump < 0.18) continue;
        const e = clamp01((y - yH) / (h - yH));
        const fres = fresnelAt(e);
        /* 远处（掠射）反而更亮：这是菲涅尔，不是"近大远小"的直觉。
           `flick` 是**调制**不是基底 —— 原来 a ∝ flick，而 flick = sin³·sin² 的
           均值只有 ~0.15，整条碎路的平均 alpha 落在 0.05：河面上几乎只剩那个
           椭圆在发光，碎光点等于没画（实测第一版）。现在基底 0.30，闪烁在
           0.30..1.00 之间调制，暗的那几颗仍然明显更暗。 */
        const a =
            (0.3 + 0.7 * g.flick) *
            (0.35 + 0.85 * fres) *
            (1 - 0.25 * g.k) *
            (0.28 + 0.9 * Math.pow(hash2(i, 43), 1.8)) *
            (0.45 + 0.85 * clump);
        if (a < 0.03) continue;
        drawn++;
        /* 长度直接按**屏幕像素**给，不按 u 给：u 的半宽在近处会被河道宽度放大成
           上百像素，第一版整条碎路因此长成一架梯子。
           长度取**重尾**（`hash^2.4`）：大多数是短划、少数拉得很长。均匀分布的
           长度本身就是"等长虚线"的来源 —— 实测第一版整条路读成一把刻度尺。 */
        const L = (2 + 30 * Math.pow(hash2(i, 41), 2.4)) * (0.5 + 1.0 * g.d) * (g.hero ? 1.7 : 1);
        ctx.strokeStyle = `rgba(255,232,178,${a.toFixed(3)})`;
        ctx.lineWidth = 0.7 + 1.1 * g.d + (g.hero ? 1.4 : 0);
        ctx.beginPath();
        ctx.moveTo(cx - L, y);
        ctx.lineTo(cx + L, y);
        ctx.stroke();
        if (g.hero) {
            // 少量"英雄亮点"：四角星芒，整条碎路上就那么几颗
            const r = 3 + 7 * g.d;
            ctx.strokeStyle = `rgba(255,246,222,${(a * 0.85).toFixed(3)})`;
            ctx.lineWidth = 0.9;
            ctx.beginPath();
            ctx.moveTo(cx - r, y);
            ctx.lineTo(cx + r, y);
            ctx.moveTo(cx, y - r * 0.42);
            ctx.lineTo(cx, y + r * 0.42);
            ctx.stroke();
            ctx.fillStyle = `rgba(255,250,232,${a.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(cx, y, 0.9 + g.d * 1.3, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    ctx.restore();
    return drawn;
}

/* ══════════════════════ 三、岸线浪花 + 浅水焦散 ══════════════════════ */

/** 岸线浪花：沿两条水线铺噪声打散的泡沫段（烘焙期一次，逐帧零成本）。
 *  纯色带会读成"描边"，所以 alpha 由 fbm 控制、且留出成片的空档。 */
export function drawShoreFoam(ctx: CanvasRenderingContext2D, geo: Geo, seed = 21): void {
    const { yH, h } = geo;
    const NSEG = 120;
    ctx.save();
    for (const edge of [0, 1]) {
        const side = edge === 0 ? 1 : -1;
        for (let i = 0; i < NSEG; i++) {
            const d0 = (i / NSEG) * 1.12;
            const d1 = ((i + 1) / NSEG) * 1.12;
            const y0 = geo.riverY(d0);
            const y1 = geo.riverY(d1);
            if (y1 < yH - 2 || y0 > h + 20) continue;
            /* 两个频率叠：慢频决定"这一带有没有沫"，快频把它切成断续的沫块。
               只用慢频时整条岸线会一起亮一起灭，读成一条画上去的白边（第一版
               实测就是这样）。 */
            const n = fbm1(d0 * 11.3 + edge * 13.7, 2, seed) * 0.6 +
                      fbm1(d0 * 47.0 + edge * 5.1, 2, seed + 9) * 0.4;
            const a = Math.max(0, n - 0.60) * 0.34 * (0.3 + 0.7 * Math.min(1, d0 * 1.6));
            if (a < 0.006) continue;
            const wd = 0.003 + 0.008 * d0;
            ctx.beginPath();
            ctx.moveTo(geo.riverX(edge, d0), y0);
            ctx.lineTo(geo.riverX(edge, d1), y1);
            ctx.lineTo(geo.riverX(edge + side * wd, d1), y1);
            ctx.lineTo(geo.riverX(edge + side * wd, d0), y0);
            ctx.closePath();
            ctx.fillStyle = `rgba(206,226,255,${a.toFixed(3)})`;
            ctx.fill();
        }
    }
    ctx.restore();
}

/** 浅水焦散：贴岸的细亮丝（水面折射在浅底上聚出的光网）。
 *  同样烘焙一次；用 ridged 噪声取丝状结构，只铺在近岸的浅水带里。 */
export function drawCaustics(ctx: CanvasRenderingContext2D, geo: Geo, seed = 33): void {
    const { yH, h } = geo;
    ctx.save();
    for (const edge of [0, 1]) {
        const side = edge === 0 ? 1 : -1;
        for (let i = 0; i < 90; i++) {
            const d = 0.42 + hash2(i, 3, seed + edge * 31) * 0.62;
            const y = geo.riverY(d);
            if (y < yH || y > h + 10) continue;
            const n = fbm(hash2(i, 7, seed + edge) * 6, d * 4.4, 3, seed);
            const a = Math.max(0, n - 0.46) * 0.5 * (0.3 + 0.7 * d);
            if (a < 0.02) continue;
            const u = edge + side * (0.012 + hash2(i, 9, seed) * 0.10);
            const len = (0.012 + hash2(i, 11, seed) * 0.05) * d;
            const y2 = geo.riverY(Math.min(1.12, d + len));
            ctx.strokeStyle = `rgba(170,214,236,${a.toFixed(3)})`;
            ctx.lineWidth = 0.6 + d * 0.9;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(geo.riverX(u, d), y);
            ctx.quadraticCurveTo(
                geo.riverX(u + side * 0.01, (d + d + len) / 2),
                (y + y2) / 2,
                geo.riverX(u + side * 0.004, Math.min(1.12, d + len)),
                y2
            );
            ctx.stroke();
        }
    }
    ctx.restore();
}

/* ══════════════════════ 四、河灯倒影 ══════════════════════ */

let reflSprite: HTMLCanvasElement | null = null;
/** 灯影贴图：一竖条暖光，上亮下隐、左右羽化。只建一次。 */
function lanternReflSprite(): HTMLCanvasElement {
    if (reflSprite) return reflSprite;
    const c = document.createElement("canvas");
    c.width = 48;
    c.height = 160;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 0, 160);
    grad.addColorStop(0, "rgba(255,226,168,0.85)");
    grad.addColorStop(0.22, "rgba(255,206,132,0.5)");
    grad.addColorStop(0.6, "rgba(255,186,110,0.17)");
    grad.addColorStop(1, "rgba(255,180,110,0)");
    g.fillStyle = grad;
    // 左右羽化：横向再乘一条渐变（用 destination-in 一次性乘上去）
    g.fillRect(0, 0, 48, 160);
    const hg = g.createLinearGradient(0, 0, 48, 0);
    hg.addColorStop(0, "rgba(0,0,0,0)");
    hg.addColorStop(0.5, "rgba(0,0,0,1)");
    hg.addColorStop(1, "rgba(0,0,0,0)");
    g.globalCompositeOperation = "destination-in";
    g.fillStyle = hg;
    g.fillRect(0, 0, 48, 160);
    g.globalCompositeOperation = "source-over";
    reflSprite = c;
    return c;
}

export interface ReflLantern {
    /** 灯心屏幕 x（CSS px，已含视差与晃摆） */
    x: number;
    /** 灯心屏幕 y */
    y: number;
    /** 与 DOM 同一套缩放（0..1） */
    scl: number;
    /** 暖色灯（莲花/圆笼）与冷色灯的权重 */
    warm: number;
}

/** 河灯在水里的倒影：灯下一条随波左右摆的暖色拖影，分 3 段错开
 *  —— 一段到底会读成"灯下面挂了根棍子"，错开才像被水面切碎。 */
export function drawLanternReflections(
    ctx: CanvasRenderingContext2D,
    geo: Geo,
    list: ReflLantern[],
    t: number,
    reduce: boolean
): void {
    if (!list.length) return;
    const sp = lanternReflSprite();
    const { yH, h } = geo;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let n = 0; n < list.length; n++) {
        const L = list[n];
        if (L.scl < 0.05) continue;
        const wSeg = 11 + 30 * L.scl;
        const segH = (34 + 96 * L.scl) / 3;
        const base = 0.34 * L.scl * (0.72 + 0.28 * (reduce ? 0.5 : Math.sin(t * 1.6 + n * 1.9)));
        for (let j = 0; j < 3; j++) {
            const yTop = L.y + 6 + j * segH * 0.92;
            if (yTop > h + 20 || yTop + segH < yH) continue;
            const dx = reduce ? 0 : waveShift(yTop + segH * 0.5, yH, h, t * 1.15 + n * 0.7, 0.55) * (0.6 + j * 0.5);
            ctx.globalAlpha = base * (1 - j * 0.26) * (L.warm > 0.5 ? 1 : 0.72);
            ctx.drawImage(sp, L.x + dx - wSeg / 2, yTop, wSeg, segH * 1.25);
        }
    }
    ctx.restore();
}

/* ══════════════════════ 五、宽幅水光带贴图 ══════════════════════ */

let bandSp: HTMLCanvasElement | null = null;
/** 宽幅水光带的竖直 alpha 斜坡贴图（替代每帧 `createLinearGradient`）。
 *  原来每条带每帧建一次渐变 + 5 个 `rgba()` 模板串（字符串解析才是真开销）。 */
export function bandSprite(): HTMLCanvasElement {
    if (bandSp) return bandSp;
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 64;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, "rgba(150,178,240,0)");
    grad.addColorStop(0.3, "rgba(150,178,240,0.7)");
    grad.addColorStop(0.5, "rgba(150,178,240,1)");
    grad.addColorStop(0.7, "rgba(150,178,240,0.7)");
    grad.addColorStop(1, "rgba(150,178,240,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 64);
    bandSp = c;
    return c;
}

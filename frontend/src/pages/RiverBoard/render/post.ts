/* 后期处理（阶段 3）—— 泛光 / 体积光轴 / 胶片颗粒。
 *
 * **不做全屏逐像素 JS 循环**：这一页画布在 DPR 1.5 下是 2160×1350，逐像素跑一遍
 * 是 50–100ms 级，直接毁掉整页。这里走的是"**美术指定的发光源** + canvas 原生
 * `ctx.filter` 模糊"：
 *
 *   ① 发光缓冲（1/4 分辨率）：只画**已知的发光体** —— 月盘、每盏河灯、萤火虫、
 *      水面上的月光柱。不做阈值提取（阈值提取要 `getImageData` 回读整屏，那正是
 *      上面说的 50ms 级操作），而且比阈值提取更可控：想让谁发光就画谁。
 *   ② 泛光：对发光缓冲做两级 `ctx.filter = blur()`（紧光 + 柔光），`lighter` 叠回。
 *   ③ 体积光轴：一张预烘的放射状柔光贴图，贴在月心上、裁剪到地平线之上。
 *   ④ 胶片颗粒：预烘一张噪声贴图，`overlay` 铺一层，每 3 帧换一次偏移。
 *
 * 成本量级：发光缓冲是 1/4 分辨率（1440×900 → 370×245），两级模糊各一次
 * `blur()` 调用；颗粒是一次 pattern 填充。都在"每帧几次全屏 drawImage"这个
 * 既有预算量级里。
 *
 * 纯几何/纯函数的部分导出，好让判据在 node 里直接量。 */

import { hash2 } from "./noise";

/* ══════════════════════ 一、发光缓冲 ══════════════════════ */

/** 发光缓冲相对 CSS 尺寸的比例。1/4 是"够糊"与"够便宜"的交点：泛光的模糊半径
 *  在这个分辨率上给 2–7px，放大回去等效 8–28px。 */
export const GLOW_Q = 0.25;

/** 清空发光缓冲并设好与主画布同源的变换（含出血边）。
 *  返回的上下文之后一律用 **CSS 坐标**作画，原点与主画布一致。 */
export function beginGlow(
    cv: HTMLCanvasElement,
    w: number,
    h: number,
    margin: number
): CanvasRenderingContext2D {
    const q = GLOW_Q;
    const sw = Math.max(4, Math.round((w + 2 * margin) * q));
    const sh = Math.max(4, Math.round((h + 2 * margin) * q));
    if (cv.width !== sw) cv.width = sw;
    if (cv.height !== sh) cv.height = sh;
    const g = cv.getContext("2d")!;
    g.setTransform(q, 0, 0, q, 0, 0);
    g.clearRect(-margin, -margin, w + 2 * margin, h + 2 * margin);
    g.translate(margin, margin);
    return g;
}

const blobs = new Map<string, HTMLCanvasElement>();
/** 柔光斑贴图（中心亮、边缘落零）。按颜色缓存 —— 每帧给每盏灯画一个，
 *  绝不能在调用点上建渐变（头注纪律：禁止每帧 `createGradient`）。 */
export function blobSprite(r: number, g0: number, b: number, core = 0): HTMLCanvasElement {
    const key = r + "," + g0 + "," + b + "," + core;
    const hit = blobs.get(key);
    if (hit) return hit;
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    /* 三段而不是两段：线性衰减到 0 会在边缘留一圈可见的"碗边"，中间加一段
       慢衰减（0.25 处仍有 0.55）才像光。`core` > 0 时再压一个更小的亮核。 */
    grd.addColorStop(0, `rgba(${r},${g0},${b},1)`);
    grd.addColorStop(0.25, `rgba(${r},${g0},${b},0.55)`);
    grd.addColorStop(0.62, `rgba(${r},${g0},${b},0.16)`);
    grd.addColorStop(1, `rgba(${r},${g0},${b},0)`);
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    blobs.set(key, c);
    return c;
}

const halos = new Map<string, HTMLCanvasElement>();
/** 大气光晕贴图：**盘面之内恒 0，从盘缘起单调衰减**。
 *
 *  月盘不能用 `blobSprite`：软核泛光叠在月面上会把月海的暗斑一起提亮，实测月盘被漂成
 *  一块没有细节的白饼 —— 而月盘本体是本页唯一"一字不许改"的资产。
 *  也**不能做成"环"**：环带（0 / 峰值 / 0 三站）在峰值处折得太急、末端又落得太齐，
 *  整圈读成一枚灰甜甜圈（实测两轮）。真实的大气光晕是**从盘缘往外一路衰减**的，
 *  所以这里是"内圈 0 → 盘缘峰值 → 幂律长尾"，没有回升段。
 *
 *  `inner` = 盘缘在贴图半径里的占比。贴图半径取盘半径的 1/inner 倍，盘缘正好落在 `inner`。 */
export function haloSprite(
    r: number,
    g: number,
    b: number,
    inner = 0.3,
    peak = 0.62
): HTMLCanvasElement {
    const key = r + "," + g + "," + b + "," + inner + "," + peak;
    const hit = halos.get(key);
    if (hit) return hit;
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g2 = c.getContext("2d")!;
    const grd = g2.createRadialGradient(64, 64, 0, 64, 64, 64);
    const at = (k: number) => inner + (1 - inner) * k;
    const col = (a: number) => `rgba(${r},${g},${b},${a.toFixed(4)})`;
    grd.addColorStop(0, col(0));
    grd.addColorStop(inner, col(0));
    /* 盘缘起单调衰减、尾巴拉长（近似高斯）。峰值贴着盘缘且**不许太陡**：
       峰值 0.8 + 快速回落会在盘外糊出一圈亮领子，整颗月亮读成"戴了个环"（实测）。 */
    grd.addColorStop(at(0.04), col(peak * 0.6));
    grd.addColorStop(at(0.12), col(peak * 0.44));
    grd.addColorStop(at(0.26), col(peak * 0.26));
    grd.addColorStop(at(0.48), col(peak * 0.11));
    grd.addColorStop(at(0.75), col(peak * 0.035));
    grd.addColorStop(1, col(0));
    g2.fillStyle = grd;
    g2.fillRect(0, 0, 128, 128);
    halos.set(key, c);
    return c;
}

/** 往发光缓冲里放一团柔光。`r` 是 CSS 半径。 */
export function glowBlob(
    g: CanvasRenderingContext2D,
    sp: HTMLCanvasElement,
    x: number,
    y: number,
    r: number,
    alpha: number
): void {
    if (alpha <= 0.004 || r <= 0.5) return;
    g.globalAlpha = alpha > 1 ? 1 : alpha;
    g.drawImage(sp, x - r, y - r, r * 2, r * 2);
}

/* ══════════════════════ 二、泛光 ══════════════════════ */

let bloomCv: HTMLCanvasElement | null = null;

/** 泛光合成：把发光缓冲模糊两级、`lighter` 叠回主画布。
 *
 *  为什么必须**两级**：只有一级时"半径小 ⇒ 光只贴着光源、没有氛围；半径大 ⇒
 *  光源本身糊掉、像隔着毛玻璃"。真实镜头的光晕本来就是紧光（镜片内部的散射）
 *  与柔光（光圈叶片的衍射）两层叠出来的。 */
export function bloom(
    ctx: CanvasRenderingContext2D,
    glow: HTMLCanvasElement,
    w: number,
    h: number,
    margin: number,
    reduce: boolean
): void {
    const sw = glow.width;
    const sh = glow.height;
    if (sw < 4 || sh < 4) return;
    if (!bloomCv) bloomCv = document.createElement("canvas");
    if (bloomCv.width !== sw) bloomCv.width = sw;
    if (bloomCv.height !== sh) bloomCv.height = sh;
    const b = bloomCv.getContext("2d")!;
    /* 降级档只留紧光：柔光是"氛围"，紧光是"光源还在发光"，后者不能丢。 */
    const passes: Array<[number, number]> = reduce
        ? [[1.8, 0.55]]
        : [
              [1.8, 0.5],
              [6.0, 0.3],
          ];
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const [r, a] of passes) {
        b.setTransform(1, 0, 0, 1, 0, 0);
        b.clearRect(0, 0, sw, sh);
        b.filter = `blur(${r}px)`;
        b.drawImage(glow, 0, 0);
        b.filter = "none";
        ctx.globalAlpha = a;
        ctx.drawImage(bloomCv, -margin, -margin, w + 2 * margin, h + 2 * margin);
    }
    ctx.restore();
}

/* ══════════════════════ 三、体积光轴 ══════════════════════ */

let rayCv: HTMLCanvasElement | null = null;

/** 放射状柔光贴图：绕中心一圈长短不一的柔光楔 + 一个亮核。
 *
 *  原计划是"绕月心做 10 次逐步缩放的 lighter 叠加"（屏幕空间 zoom blur）。实测
 *  那个做法得到的是一个**均匀的圆晕**而不是光轴 —— 圆形光源的缩放叠加在角向上
 *  没有结构，缩放多少次都还是圆的。要有"轴"，源本身就得有角向结构，所以这里
 *  直接烘一张带角向结构（26 条长短不一的柔楔）的贴图，一次 `drawImage` 搞定，
 *  比 10 次全缓冲叠加还便宜。 */
export function raySprite(): HTMLCanvasElement {
    if (rayCv) return rayCv;
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d")!;
    g.globalCompositeOperation = "lighter";
    g.translate(128, 128);
    const R = 128;
    /* 楔子是**环段**，从 `r0` 才起笔 —— 中心必须留空：一是月盘本体一字不许改
       （楔子从心起笔就会把月面糊白，实测），二是从心起笔时 26 条楔在中心叠加，
       合起来是一枚亮核，整片读成"太阳花"而不是"月光穿过薄雾"。 */
    const r0 = R * 0.2;
    for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2 + hash2(i, 7, 900) * 0.2;
        const len = R * (0.5 + 0.5 * Math.pow(hash2(i, 11, 901), 0.7));
        const wid = 0.006 + 0.03 * hash2(i, 13, 902);
        /* 强度差拉大（0.10→1.00，幂 2.4）：20 条一样亮就是一枚均匀的太阳花，
           光柱的观感来自"两三条亮的 + 一片几乎看不见的"。 */
        const inten = 0.1 + 0.9 * Math.pow(hash2(i, 17, 903), 2.4);
        const grd = g.createLinearGradient(
            Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * len, Math.sin(a) * len
        );
        grd.addColorStop(0, `rgba(255,242,212,${(0.5 * inten).toFixed(4)})`);
        grd.addColorStop(0.45, `rgba(255,240,208,${(0.22 * inten).toFixed(4)})`);
        grd.addColorStop(1, "rgba(255,236,200,0)");
        g.fillStyle = grd;
        g.beginPath();
        g.arc(0, 0, r0, a - wid, a + wid);
        g.arc(0, 0, len, a + wid, a - wid, true);
        g.closePath();
        g.fill();
    }
    rayCv = c;
    return c;
}

/** 把光轴贴在 (x,y) 上，半径 R。调用方负责裁剪（只让它出现在地平线之上）。 */
export function drawRays(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    R: number,
    alpha: number
): void {
    if (alpha <= 0.004) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = alpha > 1 ? 1 : alpha;
    ctx.drawImage(raySprite(), x - R, y - R, R * 2, R * 2);
    ctx.restore();
}

/* ══════════════════════ 四、胶片颗粒 ══════════════════════ */

let grainTile: HTMLCanvasElement | null = null;
let grainPat: CanvasPattern | null = null;

/** 噪声贴图（128×128，中灰为中心、幅度 ±55）。
 *  用 `hash2` 而不是 `Math.random` —— 跨构建的像素判据要可复现。
 *  幅度取到 ±55 而不是更保守的 ±37：`overlay` 对**暗底**的调制量是 `b·(2s-1)`，
 *  这条夜河的背景亮度只有 0.07–0.13，±37 的贴图配 5% 的合成 alpha 落到屏上是
 *  ±0.3/255 —— 实测与不加颗粒的差是 0.001，等于没画。 */
function grainTexture(): HTMLCanvasElement {
    if (grainTile) return grainTile;
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    const img = g.createImageData(128, 128);
    const d = img.data;
    for (let i = 0, n = 128 * 128; i < n; i++) {
        const v = 128 + Math.round((hash2(i & 127, i >> 7, 4242) - 0.5) * 110);
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
        d[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    grainTile = c;
    return c;
}

/** 胶片颗粒：`overlay` 铺一层噪声，偏移每 3 帧换一次。
 *
 *  为什么是 `overlay` 而不是 `source-over`：overlay 以中灰为恒等点，暗部几乎不动、
 *  中间调被推开 —— 这正是胶片颗粒的样子（它长在中间调上，不是给暗部糊一层灰）。
 *  偏移按帧号推而不是随机：同一帧号两次渲染必须落在同一个偏移上（判据要相减）。 */
export function drawGrain(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    margin: number,
    tick: number,
    alpha: number
): void {
    if (alpha <= 0.002) return;
    if (!grainPat) grainPat = ctx.createPattern(grainTexture(), "repeat");
    if (!grainPat) return;
    const ox = ((tick * 37) % 128) - 64;
    const oy = ((tick * 71) % 128) - 64;
    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = alpha;
    ctx.translate(ox, oy);
    ctx.fillStyle = grainPat;
    ctx.fillRect(-margin - ox, -margin - oy, w + margin * 2, h + margin * 2);
    ctx.restore();
}

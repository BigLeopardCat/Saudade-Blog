/* 天空与大气透视 —— 电影感重制的第一层。
 *
 * 现在这一页的夜空是一条线性渐变 + 三块纯色山脊剪影。缺的是三件东西：
 *   ① **大气透视**：远处的山应该被空气散射"洗淡"（提蓝、降对比、加雾纱），
 *      而不是三层一样黑 —— 没有这一条，画面就没有纵深；
 *   ② **体积云**：有厚度的云被月光照亮，朝月侧有边缘光、背光面有自阴影；
 *   ③ **银河与地平线辉光**：夜空的"底噪"层次。
 *
 * 全部在**烘焙期**算一次（init / resize），逐帧只多两次 `drawImage`。
 * 云条带之所以单独成条、逐帧画，是因为它要有自己的视差与漂移；山脊/银河/辉光
 * 是死的，直接烤进静态层。 */

import { clamp01, fbm, fbm1, hash2, mix, ridged, smoothstep, valueNoise } from "./noise";
import type { Geo, MoonGeom } from "./geo";

/* ------------------------------- 云 ------------------------------- */

export interface CloudLayerCfg {
    seed: number;
    /** 噪声频率（条带像素的倒数）；越小云越大 */
    fx: number;
    fy: number;
    oct: number;
    /** 密度阈值：越大云越稀 */
    thr: number;
    /** 不透明度上限 */
    opacity: number;
    /** 云带在条带高度内的垂直区间（0..1） */
    bandTop: number;
    bandBot: number;
    /** 自阴影色 / 受光色 / 边缘光色（RGB 0..255） */
    shadow: [number, number, number];
    lit: [number, number, number];
    rim: [number, number, number];
}

/** 高层薄云（卷云）：大尺度、淡、慢。 */
export const CLOUD_HIGH: CloudLayerCfg = {
    seed: 911,
    fx: 1 / 210,
    fy: 1 / 130,
    oct: 5,
    thr: 0.47,
    opacity: 0.40,
    bandTop: 0.0,
    bandBot: 0.86,
    shadow: [26, 34, 62],
    lit: [176, 190, 226],
    rim: [255, 240, 208],
};

/** 低层积云：小尺度、厚、受月照明显。 */
export const CLOUD_LOW: CloudLayerCfg = {
    seed: 407,
    fx: 1 / 340,
    fy: 1 / 190,
    oct: 6,
    thr: 0.44,
    opacity: 0.56,
    bandTop: 0.16,
    bandBot: 1.0,
    shadow: [14, 20, 44],
    lit: [150, 168, 212],
    rim: [255, 226, 176],
};

/* 云面法线用的光照方向（固定的美术方向，不是逐像素指向月亮）。
   为什么固定：云条带每帧会漂移，逐像素指向月亮的烘焙光会跟着"粘"在云上、
   漂移时露馅。月亮在 x=0.7w 的高空 ⇒ 光从右上打下来，这一条足够读。 */
const LX = 0.55, LY = -0.45, LZ = 0.70;
const LINV = 1 / Math.hypot(LX, LY, LZ);
const NL = LX * LINV, NL_Y = LY * LINV, NL_Z = LZ * LINV;

/* 云条带内部分辨率：条带按 CSS 像素的三分之一烘，再放大回来。
   云本来就是低频的，1/3 放大后只会更柔；而逐像素 fbm 是这里唯一的重活，
   降一半分辨率等于省四分之三的时间。 */
const CLOUD_SCALE = 3;

/** 烘一条云带。返回的 canvas 宽度 = `stripW`，高度 = `stripH`（CSS px 尺度）。 */
export function bakeCloudStrip(stripW: number, stripH: number, cfg: CloudLayerCfg): HTMLCanvasElement {
    const bw = Math.max(4, Math.ceil(stripW / CLOUD_SCALE));
    const bh = Math.max(4, Math.ceil(stripH / CLOUD_SCALE));

    // ① 密度场（只算一遍 fbm，法线从这张表上取差分 —— 逐像素再算 4 次 fbm 会慢 4 倍）
    const dens = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) {
        const yy = y / bh;
        // 垂直包络：云集中在中上部，天顶与地平线附近自然稀疏
        const band =
            smoothstep(cfg.bandTop, cfg.bandTop + 0.3, yy) *
            (1 - smoothstep(cfg.bandBot - 0.34, cfg.bandBot, yy));
        if (band <= 0.001) continue;
        const row = y * bw;
        for (let x = 0; x < bw; x++) {
            dens[row + x] = fbm(x * cfg.fx * CLOUD_SCALE, y * cfg.fy * CLOUD_SCALE, cfg.oct, cfg.seed) * band;
        }
    }

    const cv = document.createElement("canvas");
    cv.width = bw;
    cv.height = bh;
    const ctx = cv.getContext("2d")!;
    const img = ctx.createImageData(bw, bh);
    const d = img.data;

    // ② 着色：法线 = 密度场梯度，兰伯特 + 边缘光
    const NK = 9; // 梯度→法线的放大系数（云面很平，不放大会几乎没有明暗）
    for (let y = 0; y < bh; y++) {
        const row = y * bw;
        for (let x = 0; x < bw; x++) {
            const i = row + x;
            const v = dens[i];
            if (v <= cfg.thr) continue;
            const a = clamp01((v - cfg.thr) / (1 - cfg.thr));

            const gl = x > 0 ? dens[i - 1] : v;
            const gr = x < bw - 1 ? dens[i + 1] : v;
            const gu = y > 0 ? dens[i - bw] : v;
            const gd = y < bh - 1 ? dens[i + bw] : v;
            let nx = -(gr - gl) * 0.5 * NK;
            let ny = -(gd - gu) * 0.5 * NK;
            const inv = 1 / Math.hypot(nx, ny, 1);
            nx *= inv; ny *= inv;
            const nz = 1 * inv;

            const ndl = clamp01(nx * NL + ny * NL_Y + nz * NL_Z);
            const shade = 0.16 + 0.84 * ndl;
            // 边缘光：薄的部位（a 小）朝着光的那一侧亮起来 —— 云边被月亮勾出来的那道线
            const edge = (1 - a) * a * 4 * Math.pow(ndl, 3);

            const o = i * 4;
            d[o] = mix(cfg.shadow[0], cfg.lit[0], shade) + cfg.rim[0] * edge;
            d[o + 1] = mix(cfg.shadow[1], cfg.lit[1], shade) + cfg.rim[1] * edge;
            d[o + 2] = mix(cfg.shadow[2], cfg.lit[2], shade) + cfg.rim[2] * edge;
            // 两端各 4% 横向淡出：条带被采到极限位置时不会露出硬边
            const xf = x / bw;
            const fade = smoothstep(0, 0.04, xf) * (1 - smoothstep(0.96, 1, xf));
            d[o + 3] = a * cfg.opacity * 255 * fade;
        }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
}

/** 逐帧画云：裁剪在天空区内（山脊之上），带视差 + 缓慢漂移。
 *
 *  **条带是"被采样的大图"，不是"被搬动的贴片"**：屏幕是条带上的一个移动窗口，
 *  所以位移加在 `drawImage` 的**目标坐标的负值**上（`-sOff`），条带本身永远画满
 *  整个可见区。早期写成"把条带整体右移"，漂移一走到端点，屏幕左缘就露出没铺到的
 *  天空 —— 一个只在极值时刻出现的缝。
 *
 *  `baseX/baseY` 是窗口的基准偏移（通常传静态层的出血边 MARGIN）。 */
export function drawClouds(
    ctx: CanvasRenderingContext2D,
    strips: Array<{ cv: HTMLCanvasElement; par: number; speed: number }>,
    px: number,
    py: number,
    drift: number,
    baseX: number,
    baseY: number
): void {
    for (const s of strips) {
        const sOff = baseX + px * s.par + drift * s.speed;
        const sOffY = baseY + py * s.par * 0.6;
        ctx.drawImage(s.cv, -sOff, -sOffY, s.cv.width, s.cv.height);
    }
}

/* ----------------------------- 银河 ----------------------------- */

/** 银河带：沿一条对角线铺一串柔光团 + 沿带加密的暗星。
 *  全部 `lighter` 叠加，烤进静态层 —— 逐帧零成本。 */
export function drawMilkyWay(ctx: CanvasRenderingContext2D, geo: Geo, seed = 7): void {
    const { w, h, yH } = geo;
    // 带轴：左下 (0.16w, 0.40h) → 右上 (1.02w, -0.06h)
    const ax = 0.16 * w, ay = 0.40 * h;
    const bx = 1.02 * w, by = -0.06 * h;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const N = 30;
    for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        // 带内的位置抖动：银河不是一条直线，是条毛边的絮
        const jit = (hash2(i, 3, seed) - 0.5) * 0.5;
        const cx = ax + dx * t + uy * jit * 90;
        const cy = ay + dy * t - ux * jit * 90;
        const rr = (110 + hash2(i, 11, seed) * 130) * (0.55 + 0.45 * Math.sin(t * Math.PI));
        const al = (0.013 + hash2(i, 23, seed) * 0.016) * Math.sin(t * Math.PI);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
        // 冷暖分带：银河核球偏暖、外围偏冷
        g.addColorStop(0, `rgba(214,206,236,${al})`);
        g.addColorStop(0.45, `rgba(168,178,226,${al * 0.5})`);
        g.addColorStop(1, "rgba(120,140,200,0)");
        ctx.fillStyle = g;
        ctx.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
    }
    // 沿带撒的暗星（比主星场更密更暗，制造"那片天不一样"的观感）
    const NS = 420;
    for (let i = 0; i < NS; i++) {
        const t = hash2(i, 41, seed);
        const off = (hash2(i, 53, seed) - 0.5) * 2;
        const spread = 120 * Math.exp(-off * off * 2.2);
        const x = ax + dx * t + uy * off * spread;
        const y = ay + dy * t - ux * off * spread;
        if (x < -40 || x > w + 40 || y < -40 || y > yH + 20) continue;
        const r = 0.3 + hash2(i, 67, seed) * 0.85;
        const a = 0.08 + hash2(i, 71, seed) * 0.26;
        ctx.fillStyle = `rgba(228,232,255,${a})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}

/* ------------------------- 地平线辉光 / 月晕 ------------------------- */

/** 地平线辉光：以月亮方位为心的暖→冷过渡，压在山脊之后。
 *  这是"天空不是一条渐变"的关键 —— 光有一个来源方位。 */
export function drawHorizonGlow(ctx: CanvasRenderingContext2D, geo: Geo, moon: MoonGeom): void {
    const { w, yH } = geo;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    // 横向：以月亮方位为峰的高斯
    const hx = moon.x;
    const gw = w * 0.62;
    const g = ctx.createLinearGradient(0, 0, w, 0);
    const k = 0.62 + 0.38 * moon.haloK;
    for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        const x = t * w;
        const dd = (x - hx) / gw;
        const a = Math.exp(-dd * dd * 2.4) * k;
        g.addColorStop(t, `rgba(126,148,214,${(0.034 * a).toFixed(4)})`);
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, yH * 0.52, w, yH * 0.62);

    // 竖向：贴着地平线最亮，向上迅速衰减（大气散射的厚度）
    const v = ctx.createLinearGradient(0, yH * 0.6, 0, yH * 1.06);
    v.addColorStop(0, "rgba(150,168,226,0)");
    v.addColorStop(0.55, `rgba(168,180,232,${(0.040 * k).toFixed(4)})`);
    v.addColorStop(0.88, `rgba(206,198,226,${(0.052 * k).toFixed(4)})`);
    v.addColorStop(1, "rgba(190,170,190,0)");
    ctx.fillStyle = v;
    ctx.fillRect(0, yH * 0.6, w, yH * 0.46);
    ctx.restore();
}

/** 月晕：三层叠 —— 紧实的亮核、中景散射、很宽的一圈极淡的外晕。
 *  **只画光，不碰月盘**（月盘 sprite 在 index.tsx 里，由 riverboard-moon.test.mjs 锁死）。 */
/* 月晕的**受光面掩膜**：一个半径 2.6r 的小画布，盘内每点按它自己的球面法线与
 *  光方向点乘（Lambert）给不透明度，盘外全透明。之后把这个掩膜**模糊**着叠上去，
 *  得到的光晕形状就**正好是受光面的形状**。
 *
 *  为什么必须走这条路（20261018 用户反馈「不是满月，光晕却还是圆环」）：
 *    · 原来是绕盘心的**三个同心圆** —— 满月时对，不是满月时，亮面只有一半甚至
 *      一弯细牙，却仍然套着一个完整的圆环；
 *    · 第二版改成"在盘面内撒点、按 Lambert 加权、每点画一个柔光斑"。方向对，
 *      但每个光斑的半径必须远大于盘半径才能把光晕铺开，于是**每个亮点的光都糊到
 *      了暗面去**，实测受光侧/暗面侧在盘缘外 10px 处只差 6%（≈没有区别）。
 *  模糊掩膜没有这个问题：模糊只会把边界**变软**，不会把亮部搬到暗面去。
 *
 *  掩膜按 (尺寸, 光方向) 缓存 —— 月相在页面开着的时候不会变，一份就够。 */
let haloMask: { cv: HTMLCanvasElement; key: string } | null = null;

/** 掩膜外沿（以月盘半径为单位）。
 *
 *  2.6 是**不够的**：模糊把盘缘抹开之后 ρ>2.6 就什么都不剩，而"月光照亮周围大气"
 *  这件事恰恰是在外圈才看得见 —— `riverboard-scene.test.py` 的中景扇区取的就是
 *  ρ∈[2.05, 3.9]，实测那一带只涨了 0.74/29.3 = 2.5%（判据要 12%）。
 *  上一版（三个同心圆）够得着那么远，缺的只是"跟着月相走"；所以这里要的是
 *  **把射程补回来、形状保持不变**，不是把光晕做大 —— 用户的原话是「不是满月，
 *  光晕却还是圆环」，说的是**形状**，不是尺寸。 */
const HALO_RATIO = 4.5;

function haloMaskCanvas(moon: MoonGeom): HTMLCanvasElement {
    const R = moon.r * HALO_RATIO;
    const N = Math.max(96, Math.round(R * 2 * 0.5));
    const key = N + "," + moon.lx.toFixed(4) + "," + moon.lz.toFixed(4);
    if (haloMask && haloMask.key === key) return haloMask.cv;
    const c = document.createElement("canvas");
    c.width = c.height = N;
    const g = c.getContext("2d")!;
    const img = g.createImageData(N, N);
    const d = img.data;
    const half = N / 2;
    const rp = (moon.r / R) * half; // 月盘半径在这张画布里的像素数
    for (let y = 0; y < N; y++) {
        const py = (y + 0.5 - half) / rp;
        for (let x = 0; x < N; x++) {
            const px = (x + 0.5 - half) / rp;
            const rho = Math.hypot(px, py);
            let v = 0;
            if (rho < HALO_RATIO) {
                if (rho <= 1) {
                    /* 盘内：按**球面法线**点乘光方向。
                       阈值**故意比月盘 sprite 宽得多**（sprite 用 -0.035/0.12，那是
                       明暗交界线本身）。用同一条阈值试过：光晕在暗面侧断得干干净净，
                       盘边立刻塌出一个"黑洞"，比原来的圆环还难看。物理上大气散射本来
                       就把光**散进暗半球**，只是越往暗面越弱 —— 所以这里的半影一路铺到
                       dot≈-0.75（暗面边缘）才落零，明暗交界处仍有约七成。 */
                    const nz = Math.sqrt(1 - rho * rho);
                    v = smoothstep(-0.75, 0.35, px * moon.lx + nz * moon.lz);
                } else {
                    /* 盘外：法线取**屏幕方向** `(px,py)/ρ`（球面法线在盘缘处正好
                       等于它，nz→0 ⇒ ρ=1 处连续，不会在盘边留一道缝），再乘一条
                       径向衰减 —— `ρ=1` 处为 1、`ρ=HALO_RATIO` 处为 0。
                       `+0.55·lz` 是**满月项**：满月时光方向正对观察者（lx=0），
                       只按 `(px/ρ)·lx` 算会得到一条均匀的暗环 —— 加上它之后满月
                       拿到一圈完整的光晕，弦月仍是"亮面一侧一片、暗面一侧一线"。

                       角向：`0.22 + 0.78·smoothstep(-1.0, 0.35, ·)`。
                       底 0.22 而不是 0：大气散射不会在明暗界线处戛然而止，背光侧
                       留两成（实测背光侧 2.6~4.0r 抬 +3.3，受光侧 +19）。
                       过渡带故意铺得**很宽**（从 69° 一路到 180°）—— 收窄到
                       42° 试过，明暗界线在画面上读成一道竖墙。 */
                    const dot = (px / rho) * moon.lx + 0.55 * moon.lz;
                    v =
                        (0.22 + 0.78 * smoothstep(-1.0, 0.35, dot)) *
                        Math.pow(1 - (rho - 1) / (HALO_RATIO - 1), 1.8);
                }
            }
            const i = (y * N + x) * 4;
            d[i] = d[i + 1] = d[i + 2] = 255;
            d[i + 3] = Math.round(v * 255);
        }
    }
    g.putImageData(img, 0, 0);
    haloMask = { cv: c, key };
    return c;
}

/** 把掩膜染成某个颜色（`source-in` 上色，形状不变）。 */
function tinted(src: HTMLCanvasElement, rgb: string): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    const g = c.getContext("2d")!;
    g.drawImage(src, 0, 0);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = rgb;
    g.fillRect(0, 0, c.width, c.height);
    return c;
}

export function drawMoonHalo(ctx: CanvasRenderingContext2D, moon: MoonGeom): void {
    const k = moon.haloK;
    const mask = haloMaskCanvas(moon);
    const warm = tinted(mask, "rgb(255,244,214)");
    const cool = tinted(mask, "rgb(202,216,250)");
    /* **画多大 = 掩膜多大**（`HALO_RATIO`）。原来这里写死 2.6，而掩膜已经铺到
       4.5 —— 掩膜外圈那截衰减被压进 2.6r 里、再往外直接切掉，射程白算了。 */
    const R = moon.r * HALO_RATIO;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    /* 两档模糊：紧的一档贴着月缘把月亮"点亮"，宽的一档给夜空被照亮的基底。
       两档用的是**同一张掩膜**，所以两档都跟着月相走。 */
    ctx.filter = `blur(${(moon.r * 0.18).toFixed(2)}px)`;
    ctx.globalAlpha = Math.min(1, 0.35 * k);
    ctx.drawImage(warm, moon.x - R, moon.y - R, R * 2, R * 2);
    ctx.filter = `blur(${(moon.r * 0.9).toFixed(2)}px)`;
    ctx.globalAlpha = Math.min(1, 0.7 * k);
    ctx.drawImage(cool, moon.x - R, moon.y - R, R * 2, R * 2);
    ctx.filter = "none";
    ctx.restore();
}

/* ----------------------------- 远山 ----------------------------- */

/** 山脊高度场：保留原来那三条正弦的**骨架**（构图不变），叠一层低频 fbm 做山形变化、
 *  一层脊状噪声做岩脊细节。 */
function ridgeY(x: number, base: number, seed: number, amp: number, detail: number): number {
    const s =
        Math.sin(x * 0.0042 + seed) * amp * 1.2 +
        Math.sin(x * 0.011 + seed * 2.7) * amp * 0.7 +
        Math.sin(x * 0.023 + seed * 5.1) * amp * 0.28;
    if (detail <= 0) return base + s;
    const macro = (fbm1(x * 0.00052, 3, seed * 3 + 5) - 0.5) * amp * 1.25 * detail;
    const crest = (ridged(x * 0.0031, 0.7, 3, seed * 7 + 11) - 0.5) * amp * 0.45 * detail;
    return base + s + macro + crest;
}

interface RidgeSpec {
    base: number;
    seed: number;
    amp: number;
    /** 顶色 / 底色（远山被大气洗淡 ⇒ 顶色更亮更蓝） */
    top: string;
    bot: string;
    /** 山脊之上的雾纱强度（越大越远） */
    haze: number;
    /** 山形细节强度（近山更碎） */
    detail: number;
    /** 是否画树线（只有最近那一层） */
    tree: boolean;
}

/** 三层远山 + 大气透视 + 近山树线。
 *  `geo.h` 以下会被后面的河面覆盖，这里照旧填到底，省得留缝。 */
export function drawRidges(ctx: CanvasRenderingContext2D, geo: Geo, moon: MoonGeom): void {
    const { w, h, yH, margin } = geo;
    const x0 = -margin - 20;
    const x1 = w + margin + 20;

    const specs: RidgeSpec[] = [
        // 最远：被空气散射洗得最淡 —— 提蓝、降对比。**夜里的远山仍然是暗的**：
        // 大气透视在这幅画里的正确表达是"山脊之上那一层雾更亮"，不是"把山体刷白"。
        {
            base: yH * 0.82, seed: 3.1, amp: h * 0.045,
            top: "#101936", bot: "#0a1029", haze: 0.26, detail: 0.30, tree: false,
        },
        {
            base: yH * 0.92, seed: 8.7, amp: h * 0.062,
            top: "#0b1231", bot: "#070d22", haze: 0.13, detail: 0.55, tree: false,
        },
        // 最近：暗、脆、带树线
        {
            base: yH * 0.97, seed: 1.7, amp: h * 0.05,
            top: "#070c22", bot: "#03060f", haze: 0.04, detail: 1.0, tree: true,
        },
    ];

    for (const sp of specs) {
        const crest: number[] = [];
        ctx.beginPath();
        ctx.moveTo(x0, h + margin);
        ctx.lineTo(x0, ridgeY(x0, sp.base, sp.seed, sp.amp, sp.detail));
        for (let x = x0; x <= x1; x += 6) {
            const y = ridgeY(x, sp.base, sp.seed, sp.amp, sp.detail);
            crest.push(y);
            ctx.lineTo(x, y);
        }
        ctx.lineTo(x1, h + margin);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, sp.base - sp.amp * 2.4, 0, h);
        g.addColorStop(0, sp.top);
        g.addColorStop(1, sp.bot);
        ctx.fillStyle = g;
        ctx.fill();

        // 树线：沿脊线撒小剪影。**成丛、有断口** —— 均匀等距的锯齿读作"锯条"，
        // 真实的林线是一片一片的：密一段、空一段，越靠山脊越高。
        if (sp.tree) {
            ctx.fillStyle = "#02040c";
            let x = x0;
            while (x < x1) {
                const y = ridgeY(x, sp.base, sp.seed, sp.amp, sp.detail);
                // 成丛判据：低频噪声决定这一段的疏密，空段整段跳过
                const clump = fbm1(x * 0.0016, 2, sp.seed * 13 + 3);
                const gap = hash2(Math.round(x * 0.31), 13, sp.seed);
                if (clump < 0.42 || gap < 0.22) {
                    x += 7 + gap * 26;
                    continue;
                }
                const k = smoothstep(0.42, 0.72, clump);
                const hh = (1.6 + hash2(Math.round(x * 0.7), 5, sp.seed) * 5.2) * (0.5 + k);
                const hw = 0.7 + hash2(Math.round(x * 0.7), 9, sp.seed) * 1.0;
                ctx.beginPath();
                ctx.moveTo(x - hw, y + 2);
                ctx.lineTo(x, y - hh);
                ctx.lineTo(x + hw, y + 2);
                ctx.closePath();
                ctx.fill();
                x += 2.0 + hash2(Math.round(x), 17, sp.seed) * 2.6;
            }
        }

        // 雾纱：山脊之上的一层软带，把这一层往背景里推。
        // 用横向高斯加权到月亮方位（有光的一侧雾更亮 —— 丁达尔的前身）
        if (sp.haze > 0.02) {
            const band = sp.amp * 3.2;
            const yTop = sp.base - band;
            const vg = ctx.createLinearGradient(0, yTop, 0, sp.base + band * 0.5);
            const hz = sp.haze * (0.55 + 0.45 * moon.haloK);
            vg.addColorStop(0, "rgba(120,140,206,0)");
            vg.addColorStop(0.62, `rgba(132,152,214,${(0.085 * hz).toFixed(4)})`);
            vg.addColorStop(1, `rgba(150,166,220,${(0.14 * hz).toFixed(4)})`);
            ctx.fillStyle = vg;
            ctx.fillRect(x0, yTop, x1 - x0, band * 1.5);

            const hg = ctx.createLinearGradient(0, 0, w, 0);
            for (let i = 0; i <= 8; i++) {
                const t = i / 8;
                const dd = (t * w - moon.x) / (w * 0.6);
                hg.addColorStop(t, `rgba(150,170,224,${(0.09 * hz * Math.exp(-dd * dd * 2.2)).toFixed(4)})`);
            }
            ctx.save();
            ctx.globalCompositeOperation = "lighter";
            ctx.fillStyle = hg;
            ctx.fillRect(0, yTop, w, band * 1.5);
            ctx.restore();
        }
    }
}

/* ------------------------- 夜空基底 ------------------------- */

/** 夜空渐变：比原来多一档，地平线附近偏青，天顶更深。
 *  返回 true 表示已铺满，调用方不必再自己填。 */
export function paintSky(ctx: CanvasRenderingContext2D, geo: Geo): void {
    const { w, yH, margin } = geo;
    const sky = ctx.createLinearGradient(0, 0, 0, yH * 1.3);
    sky.addColorStop(0, "#010208");
    sky.addColorStop(0.34, "#050a1c");
    sky.addColorStop(0.64, "#0a122b");
    sky.addColorStop(0.86, "#101833");
    sky.addColorStop(1, "#1a2242");
    ctx.fillStyle = sky;
    ctx.fillRect(-margin, -margin, w + margin * 2, yH * 1.3 + margin * 2);
}

/** 近地平线的一层薄雾（贴在水面之上、山脊之下），让水天过渡不是一条硬线。 */
export function drawHorizonMist(ctx: CanvasRenderingContext2D, geo: Geo, moon: MoonGeom): void {
    const { w, yH, margin } = geo;
    const k = 0.5 + 0.5 * moon.haloK;
    const g = ctx.createLinearGradient(0, yH * 0.86, 0, yH * 1.12);
    g.addColorStop(0, "rgba(120,146,212,0)");
    g.addColorStop(0.5, `rgba(128,152,216,${(0.048 * k).toFixed(4)})`);
    g.addColorStop(1, "rgba(120,146,212,0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = g;
    ctx.fillRect(-margin, yH * 0.86, w + margin * 2, yH * 0.26);
    ctx.restore();
}

/* 供 index.tsx 的星辰生成使用：银河带附近的星更密。 */
export function milkyWayDensity(x: number, y: number, geo: Geo): number {
    const { w, h } = geo;
    const ax = 0.16 * w, ay = 0.40 * h;
    const dx = 1.02 * w - ax, dy = -0.06 * h - ay;
    const len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;
    // 点到带轴的距离
    const rx = x - ax, ry = y - ay;
    const along = rx * ux + ry * uy;
    const perp = Math.abs(-rx * uy + ry * ux);
    const spread = 120 * Math.exp(-Math.pow(perp / 150, 2) * 2.2);
    const alongK = smoothstep(-len * 0.1, len * 0.1, along) * (1 - smoothstep(len * 0.9, len * 1.1, along));
    return (1 - clamp01(perp / 420)) * alongK * (spread > 0 ? 1 : 0) * 0.9;
}

/** 供测试与调参用：脊线高度场（与 drawRidges 同源）。 */
export function ridgeProfile(x: number, base: number, seed: number, amp: number, detail: number): number {
    return ridgeY(x, base, seed, amp, detail);
}

/** 供测试用：确定性噪声的一个小采样器（验证"同输入同输出"）。 */
export function noiseProbe(x: number, y: number, seed: number): number {
    return valueNoise(x, y, seed);
}

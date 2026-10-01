/**
 * 月面反照率：真实月球照片的采样表（20261001，第 42 轮「贴图渲染」）。
 *
 * ## 这一轮换了什么
 *
 * 用户看完第 41 轮的乳酪月面说「留言板月亮采用贴图渲染实现逼真效果」——即回到照片。
 * 第 40 轮之所以把照片扔掉（换成程序化生成），不是因为它不好看，而是它那条路的工程形态
 * 有硬伤：`moon_tex.ts` 里塞的是一张 base64 **PNG**，非得过 `<img>`/canvas 才会变成像素 ⇒
 * `loadMoonTex` 异步解码 + `texApplied` 就绪后补画静态层（第 37 轮那个"改了半个月没人
 * 生效"的事故就出在这儿），而且源照片丢了、参数再也改不动。
 *
 * 所以这一轮**换的是装法，不是回头路**：
 *
 *   · 载荷 = **256×256 的 8 位灰度原始字节**，base64 编在 `moon_albedo_data.ts` 里
 *     （生成文件，见下）。解码就是一句 `atob`，**同步**、无 DOM、无 canvas ⇒ `moonAlbedo()`
 *     仍是纯函数，node 里直接可测（`tests/riverboard-moon.test.mjs`），`index.tsx` 里那条
 *     `loadMoonTex`/`texApplied` 的异步路**不许回来**（测试锁着）。
 *   · 源照片**随仓库入库**（`moon_source.jpg`）+ 配方脚本（`build_moon_albedo.py`）⇒
 *     "源照片已丢"这件事不会再发生，换照片=重跑一遍脚本。
 *
 * ## 载荷为什么是 256（而不是当年的 192、也不是更大）
 *
 * 月盘的**设备像素**数 = CSS 直径 × dpr，而画布 dpr 有上限 `DPR_CAP = 1.5` ⇒ 1080p 下
 * 月盘约 130 设备像素、retina 约 194（第 40 轮量的就是这两个数，sprite 内部再 ×2 超采样
 * 是渲染时的抗锯齿，不提高对反照率的分辨率需求）。256 ≥ 它俩 ⇒ 采样永远是"缩小"，
 * 不会有当年 192 被放大那种糊。再往上加只是白送字节。
 *
 * 代价（诚实记账）：base64 87384 字符，gzip 后约 61KB —— 主包 gzip 后约 1.71MB，
 * 等于 +3.5%。换的是"月亮像真的"。
 *
 * ## 与渲染侧的契约
 *
 * · 表里的值 = **反照率**（0 暗 1 亮，盘内中位数 1.0），**不含任何光照项**——照片里的
 *   照明（限暗、光照梯度）已在配方脚本里除掉了。渲染侧 `buildMoonSprite` 自己按光方向
 *   算一次；这边再带一份就是两次。
 * · 取向与渲染侧一致：`fx = ((nx+1)/2)·N`、`fy = ((1−ny)/2)·N`（nx 右 = 月面东、
 *   ny 上 = 月面北；行 0 = 最北）。
 * · **别在这边做线性拉伸**：`index.tsx::ensureMoonAlbedo` 按盘内 p5/p95 把反照率自适应
 *   标定到亮度区间（对比度放大器），任何写在这一侧的线性拉伸都会被它原样抵消
 *   （第 40 轮的实测教训）。这一侧只负责"别削顶"，窗口由配方脚本按实测分位数的外侧定。
 *
 * ## 确定性
 *
 * 载荷是常量 ⇒ 解出来的表天然逐字节可复现（刷新换一副月面那种事在结构上不可能发生）。
 * `moonAlbedo()` 返回的是**同一份缓存实例**，调用方只读、不许改写。
 */
import { MOON_ALB_N, MOON_ALB_LO, MOON_ALB_HI, MOON_ALB_B64 } from "./moon_albedo_data.ts";

/** 反照率网格边长（月盘**外接正方形**内的采样数，内切圆以外的角落不参与渲染）。
 *  它只是细节上限：已高于常见屏幕上月盘的设备像素数（1080p ≈ 130、retina ≈ 194）。 */
export { MOON_ALB_N };

/** sprite 内部超采样倍数（画成 size*ss 再缩到 size，月缘抗锯齿一次到位） */
export const MOON_SPRITE_SS = 2;

/** 解码后的主表（惰性、只解一次）。`moonAlbedo()` 直接返回它——调用方只读。 */
let master: Float32Array | null = null;

/** base64 → 8 位灰度 → 反照率（`q/255 × (HI−LO) + LO`）。 */
const decode = (): Float32Array => {
    if (master) return master;
    const bin = atob(MOON_ALB_B64);
    const n = MOON_ALB_N;
    const a = new Float32Array(n * n);
    const k = (MOON_ALB_HI - MOON_ALB_LO) / 255;
    for (let i = 0; i < a.length; i++) a[i] = MOON_ALB_LO + bin.charCodeAt(i) * k;
    master = a;
    return a;
};

/** 反照率网格（行主序，长度 n*n）。`n = MOON_ALB_N` 时直接给主表；
 *  别的边长按双线性重采样（给测试与实际想看小图的地方用，渲染侧只取默认值）。 */
export function moonAlbedo(n = MOON_ALB_N): Float32Array {
    const m = decode();
    if (n === MOON_ALB_N) return m;
    const out = new Float32Array(n * n);
    const N = MOON_ALB_N;
    const idx = (i: number) => Math.max(0, Math.min(N - 1, i));
    for (let py = 0; py < n; py++) {
        const fy = ((py + 0.5) / n) * N - 0.5;
        const y0 = Math.floor(fy), ty = Math.max(0, Math.min(1, fy - y0));
        const ya = idx(y0) * N, yb = idx(y0 + 1) * N;
        for (let px = 0; px < n; px++) {
            const fx = ((px + 0.5) / n) * N - 0.5;
            const x0 = Math.floor(fx), tx = Math.max(0, Math.min(1, fx - x0));
            const xa = idx(x0), xb = idx(x0 + 1);
            const s0 = m[ya + xa] * (1 - tx) + m[ya + xb] * tx;
            const s1 = m[yb + xa] * (1 - tx) + m[yb + xb] * tx;
            out[py * n + px] = s0 * (1 - ty) + s1 * ty;
        }
    }
    return out;
}

/** 月盘 sprite 的落位：**设备整像素**（每帧双线性重采样是"月亮糊"的直接成因——
 *  静态层按非整数视差偏移合成，月缘这种高频边缘被反复磨）。返回的 x/y/size 都是
 *  设备像素整数，配合恒等变换 drawImage 即 1:1 落屏、零重采样。
 *  `diameter` 是 CSS 像素下的月盘直径；`dpr` 用画布自己的 dpr（不是 window 的）。 */
export function moonSpriteGeometry(
    centerX: number,
    centerY: number,
    diameter: number,
    dpr: number,
): { x: number; y: number; size: number; ss: number } {
    const size = Math.max(8, Math.round(diameter * dpr));
    return {
        // 圆心最多偏半个设备像素（size 取整之后无法再对齐时）
        x: Math.round(centerX * dpr - size / 2),
        y: Math.round(centerY * dpr - size / 2),
        size,
        ss: MOON_SPRITE_SS,
    };
}

/* 确定性噪声 —— 云层、银河、山脊、水波、颗粒共用的一套。
 *
 * 为什么不用 `Math.random()`：这些噪声全部在**烘焙期**（init / resize）算，
 * 同一个尺寸重烘一次必须得到同一张图，否则拖动窗口会让云"跳"一下。
 * 用整数哈希当随机源 ⇒ 同一个 (x, y, seed) 永远同一个值。
 *
 * 纯函数、无 DOM —— node 里可以直接 import 测（见 tests/riverboard-scene.test.py）。 */

/** 整数哈希 → [0,1)。Math.imul 保证 32 位乘法不丢精度。 */
export function hash2(ix: number, iy: number, seed = 0): number {
    let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

/** 二维 value noise（smoothstep 插值）。 */
export function valueNoise(x: number, y: number, seed = 0): number {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
    const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
    return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

/** 分形叠加（fbm）。返回 [0,1]。 */
export function fbm(x: number, y: number, oct = 4, seed = 0, gain = 0.5, lac = 2): number {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let i = 0; i < oct; i++) {
        sum += amp * valueNoise(x * f, y * f, seed + i * 131);
        norm += amp;
        amp *= gain;
        f *= lac;
    }
    return sum / norm;
}

/** 脊状 fbm：`1-|2n-1|` 取脊线，适合山脊/浪脊。返回 [0,1]。 */
export function ridged(x: number, y: number, oct = 4, seed = 0): number {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let i = 0; i < oct; i++) {
        const n = valueNoise(x * f, y * f, seed + i * 197);
        sum += amp * (1 - Math.abs(2 * n - 1));
        norm += amp;
        amp *= 0.5;
        f *= 2;
    }
    return sum / norm;
}

/** 一维 fbm（山脊高度场用）。 */
export function fbm1(x: number, oct = 4, seed = 0): number {
    return fbm(x, 0.371, oct, seed);
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function smoothstep(e0: number, e1: number, v: number): number {
    const t = clamp01((v - e0) / (e1 - e0 || 1e-9));
    return t * t * (3 - 2 * t);
}

/** 线性插值。 */
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

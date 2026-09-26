/**
 * 月面反照率：程序化绘制（20260926，取代 `moon_tex.ts` 那张真实照片采样表）。
 *
 * ── 为什么换掉照片 ──────────────────────────────────────────────────
 * 那条路的天花板是**固定的 192×192**（`sample_moon_tex.py` 的产物，源照片已丢），
 * 而月盘的设备像素数随屏幕走：1080p ≈ 130、retina（dpr 2）≈ 260 —— 192 被放大后
 * 本身就是糊的，屏幕越大越糊。程序化生成按需要的尺寸现算，天花板消失。
 *
 * ── 画的是什么 ──────────────────────────────────────────────────────
 * 月海（真实地理位置，正弦投影）· 环形山（真实环形山，亮缘 + 暗底 + 中心小丘）·
 * 两极高地 · 一层固定种子的细颗粒（小坑与亮斑）。亮度即反照率：0 = 最暗、1 = 最亮。
 *
 * **刻意不含任何光照项**：反照率是月面自己的属性，不随月相变（旧的手写 fallback
 * 把"迎光壁更亮"算了进来，那是**光照**——已经由渲染侧按光方向做一次，这边再做一次
 * 就是两次；换成对称亮缘后，反照率只跟月面有关，与何时看、看哪一面无关）。
 *
 * ── 确定性 ──────────────────────────────────────────────────────────
 * 细颗粒全部出自 `mulberry32(MOON_SEED)`：同种子逐字节可复现。月面每次刷新换一副
 * 面孔就成了噪点而不是月亮（测试 `tests/riverboard-moon.test.mjs` 锁这一条）。
 */

/** 反照率网格边长（月盘**外接正方形**内的采样数，盘外的角落不参与采样）。
 *  它只是细节上限：256 已高于常见屏幕上月盘的设备像素数（1080p ≈ 130、retina ≈ 260）
 *  ——所以它不再是天花板，这与照片那版固定 192 有本质区别。 */
export const MOON_ALB_N = 256;

/** 月海暗斑（近地面真实分布，正弦投影近似），月盘归一化 [-1,1]：[cx, cy, rx, ry]
 *  nx 右 = 月面东（λ+），ny 上 = 月面北（φ+）：风暴洋（西部大片）· 雨海（西北）·
 *  静海（东中）· 澄海（东北）· 丰富海（东）· 危海（东北缘）· 汽海（中北）·
 *  云海（南中）· 湿海（西南） */
const MARIA: [number, number, number, number][] = [
    [-0.4, 0.05, 0.3, 0.26], // 风暴洋
    [-0.2, 0.38, 0.17, 0.13], // 雨海
    [0.24, 0.12, 0.18, 0.14], // 静海
    [0.14, 0.27, 0.13, 0.1], // 澄海
    [0.45, -0.02, 0.14, 0.1], // 丰富海
    [0.55, 0.16, 0.1, 0.07], // 危海
    [0.06, 0.2, 0.1, 0.07], // 汽海
    [-0.13, -0.24, 0.14, 0.1], // 云海
    [-0.33, -0.21, 0.1, 0.07], // 湿海
];

/** 环形山：真实月面（近地面、地球裸眼视角）知名环形山，[cx, cy, r] 归一化。
 *  坐标 = 正弦投影 (sinλ·cosφ, sinφ)，r 由真实直径换算（D km → sin(D/3474·90°)）
 *  后按视觉 ×1.4 艺术放大——月亮在场景中偏小，真实比例在画面里不可见。
 *  第谷 Tycho（南，辐射纹最醒目）· 哥白尼 Copernicus · 开普勒 Kepler ·
 *  阿里斯塔克斯 Aristarchus（月面最亮）· 柏拉图 Plato（暗底）· 克拉维乌斯 Clavius
 *  （南极大环）· 阿基米德 Archimedes · 亚里士多德 Aristoteles · 喜帕恰斯 Hipparchus ·
 *  托勒密 Ptolemaeus · 阿尔芬苏斯 Alphonsus · 泰奥菲勒斯 Theophilus ·
 *  朗格伦 Langrenus（东缘）· 佩塔维乌斯 Petavius（东缘）· 恩迪米翁 Endymion ·
 *  阿特拉斯 Atlas · 皮科洛米尼 Piccolomini */
const CRATERS: [number, number, number][] = [
    [-0.141, -0.686, 0.053], // 第谷
    [-0.339, 0.167, 0.059], // 哥白尼
    [-0.61, 0.141, 0.02], // 开普勒
    [-0.674, 0.402, 0.025], // 阿里斯塔克斯
    [-0.1, 0.784, 0.064], // 柏拉图
    [-0.126, -0.855, 0.098], // 克拉维乌斯
    [-0.061, 0.495, 0.052], // 阿基米德
    [0.191, 0.768, 0.055], // 亚里士多德
    [0.083, -0.096, 0.07], // 喜帕恰斯
    [-0.031, -0.16, 0.07], // 托勒密
    [-0.049, -0.232, 0.056], // 阿尔芬苏斯
    [0.436, -0.198, 0.063], // 泰奥菲勒斯
    [0.864, -0.155, 0.07], // 朗格伦
    [0.788, -0.424, 0.084], // 佩塔维乌斯
    [0.495, 0.805, 0.07], // 恩迪米翁
    [0.48, 0.728, 0.053], // 阿特拉斯
    [0.463, -0.495, 0.056], // 皮科洛米尼
];

/** 高地基准亮度（反照率 1.0 = 最亮；月海/坑底在它上面往下乘） */
const HIGHLAND = 1.0;
/** 月海中心压暗比例（0.42 ⇒ 月海 ≈ 高地的 0.58，与照片版 1.6:1 的对比同量级） */
const MARIA_DEPTH = 0.42;
/** 环形山坑底压暗比例 */
const CRATER_DEPTH = 0.4;
/** 环形山亮缘增益（对称亮缘 = 溅射物反照率高，与光照无关） */
const RIM_GAIN = 0.2;
/** 两极高地提亮（真实月面靠边缘的高地更亮） */
const POLAR_GAIN = 0.12;
/** 细颗粒：小坑个数 / 亮斑个数（固定数量 + 固定种子 ⇒ 确定性） */
const SPECK_DARK = 260;
const SPECK_BRIGHT = 180;
/** 月面细节种子 */
const MOON_SEED = 0x5eed2026;
/** sprite 内部超采样倍数（画成 size*ss 再缩到 size，月缘抗锯齿一次到位） */
export const MOON_SPRITE_SS = 2;

/** mulberry32：32 位固定种子 PRNG（同种子同序列，不依赖平台随机源） */
const mulberry32 = (seed: number) => {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

/** 一维确定性哈希 → [0,1)（逐像素颗粒用；比 PRNG 便宜，同样可复现） */
const hash2 = (x: number, y: number) => {
    const h = Math.sin(x * 21.7 + y * 9.3) * 43758.53;
    return h - Math.floor(h);
};

/** 在归一化月盘坐标 [-1,1]² 内生成反照率网格（行主序，长度 n*n）。
 *  盘外（外接正方形的四角）不参与采样，值保持高地基准，无意义。 */
export function moonAlbedo(n = MOON_ALB_N): Float32Array {
    const a = new Float32Array(n * n).fill(HIGHLAND);
    /** 归一化区间 [lo,hi] 映射到网格下标区间（含端点，外扩 1 格保证柔边不被切） */
    const span = (lo: number, hi: number) => {
        const i0 = Math.max(0, Math.floor(((lo + 1) / 2) * n) - 1);
        const i1 = Math.min(n - 1, Math.ceil(((hi + 1) / 2) * n) + 1);
        return [i0, i1] as const;
    };
    const px2nx = (px: number) => ((px + 0.5) / n) * 2 - 1;
    const py2ny = (py: number) => 1 - ((py + 0.5) / n) * 2;

    // ① 月海：大块柔边暗斑
    for (const [cx, cy, rx, ry] of MARIA) {
        const [x0, x1] = span(cx - rx, cx + rx);
        const [y0, y1] = span(cy - ry, cy + ry);
        for (let py = y0; py <= y1; py++) {
            const ny = py2ny(py);
            for (let px = x0; px <= x1; px++) {
                const nx = px2nx(px);
                const dx = (nx - cx) / rx, dy = (ny - cy) / ry;
                const d2 = dx * dx + dy * dy;
                if (d2 >= 1) continue;
                a[py * n + px] *= 1 - MARIA_DEPTH * Math.pow(1 - d2, 1.5);
            }
        }
    }

    // ② 环形山：暗底 + 对称亮缘（+ 大坑的中心小丘）
    for (const [cx, cy, r] of CRATERS) {
        const [x0, x1] = span(cx - r, cx + r);
        const [y0, y1] = span(cy - r, cy + r);
        for (let py = y0; py <= y1; py++) {
            const ny = py2ny(py);
            for (let px = x0; px <= x1; px++) {
                const nx = px2nx(px);
                const dx = (nx - cx) / r, dy = (ny - cy) / r;
                const d2 = dx * dx + dy * dy;
                if (d2 >= 1) continue;
                // 坑底
                a[py * n + px] *= 1 - CRATER_DEPTH * Math.pow(1 - d2, 1.2);
                // 亮缘：d2 0.62..1.0 之间一条环带（正弦包络，两端为 0 不产生硬边）
                if (d2 > 0.62) {
                    const t = (d2 - 0.62) / 0.38;
                    a[py * n + px] *= 1 + RIM_GAIN * Math.sin(t * Math.PI);
                }
                // 中心小丘（真实大坑的中央峰）
                if (r > 0.05 && d2 < 0.07) a[py * n + px] *= 1 + 0.12 * (1 - d2 / 0.07);
            }
        }
    }

    // ③ 细颗粒（固定种子）：小坑（暗底 + 淡亮缘）与亮斑（辐射纹/丘）
    const rnd = mulberry32(MOON_SEED);
    for (let i = 0; i < SPECK_DARK + SPECK_BRIGHT; i++) {
        // 圆盘内撒点（拒绝采样；半径上限 ~0.97 避开月缘，免得颗粒被边缘切掉半个）。
        // 8 次都落在盘外就照用——盘外是正方形四角、本来就不显示，且序列仍是确定的
        let cx = 0, cy = 0;
        for (let g = 0; g < 8; g++) {
            cx = rnd() * 2 - 1;
            cy = rnd() * 2 - 1;
            if (cx * cx + cy * cy <= 0.94) break;
        }
        const isDark = i < SPECK_DARK;
        const r = isDark ? 0.006 + rnd() * 0.016 : 0.005 + rnd() * 0.011;
        const amp = isDark ? 0.1 + rnd() * 0.2 : 0.06 + rnd() * 0.1;
        const [x0, x1] = span(cx - r, cx + r);
        const [y0, y1] = span(cy - r, cy + r);
        for (let py = y0; py <= y1; py++) {
            const ny = py2ny(py);
            for (let px = x0; px <= x1; px++) {
                const nx = px2nx(px);
                const dx = (nx - cx) / r, dy = (ny - cy) / r;
                const d2 = dx * dx + dy * dy;
                if (d2 >= 1) continue;
                if (isDark) {
                    a[py * n + px] *= 1 - amp * (1 - d2);
                    if (d2 > 0.5) a[py * n + px] *= 1 + amp * 0.5 * Math.sin(((d2 - 0.5) / 0.5) * Math.PI);
                } else {
                    a[py * n + px] *= 1 + amp * (1 - d2);
                }
            }
        }
    }

    // ④ 两极高地 + 逐像素颗粒
    for (let py = 0; py < n; py++) {
        const ny = py2ny(py);
        const polar = 1 + POLAR_GAIN * Math.pow(Math.abs(ny), 3);
        for (let px = 0; px < n; px++) {
            const i = py * n + px;
            a[i] = a[i] * polar * (0.97 + 0.06 * hash2(px2nx(px), ny));
            if (a[i] < 0.02) a[i] = 0.02;
        }
    }
    return a;
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

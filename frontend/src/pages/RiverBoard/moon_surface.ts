/**
 * 月面反照率：程序化绘制（20260926，取代 `moon_tex.ts` 那张真实照片采样表）。
 *
 * ── 为什么换掉照片 ──────────────────────────────────────────────────
 * 那条路的天花板是**固定的 192×192**（`sample_moon_tex.py` 的产物，源照片已丢），
 * 而月盘的设备像素数随屏幕走：1080p ≈ 130、retina（dpr 2）≈ 260 —— 192 被放大后
 * 本身就是糊的，屏幕越大越糊。程序化生成按需要的尺寸现算，天花板消失。
 *
 * ── 画的是什么（20260926 第二轮：乳酪质感）────────────────────────────
 * 用户看完第一版（写实月海 + 环形山）说"月亮有点害羞，换成类似奶酪的月亮吧"。
 * 月相、光照、遮挡**一行没动**（那是两次返工才定下的月面物理，见 index.tsx 的
 * `buildMoonSprite`）；换的只有这张反照率表——**孔**取代环形山：
 *
 *   · 孔：十几个大而圆的凹，底平、肩陡（`pow(1-d2, 0.7)`，不是环形山那种柔和抛物面），
 *     口径 0.055–0.15（环形山 0.02–0.10）——"更圆、更大、更少"；
 *   · 孔缘亮边：`d2 > RIM_INNER` 一圈正弦包络的亮环（乳酪孔挖出来时那圈高光壁）；
 *   · 细孔带：430 个小孔压出大中小三级孔洞，外加少量亮斑做变化；
 *   · 大尺度块面：暗块用的是真实月海的位置（近地面正弦投影，乳酪本体的凹陷），
 *     亮块是酪体自己的鼓包——全盘只有孔的话，远看是一张花斑，不像月亮。
 *
 * ── ⚠️ 深浅不是"看着定"的：这套比例被渲染侧的自适应标定放大过 ──────────────
 * `index.tsx::ensureMoonAlbedo` 取**整张反照率的 p5/p95** 映射到亮度区间 `0.80..1.28`
 * （对比度放大器：跨度越小，放大越狠）。于是有一条不直观但被实测反复验证的约束：
 *
 *   **孔越低（`HOLE_DEPTH` 越大），月盘整体越亮、越平。**
 *
 * 因为 p5 会被孔底自己占住：孔底 −45% ⇒ 标定区间就是 [0.55, hi]，而酪体（占九成面积）
 * 落在区间上部 ⇒ 全盘 41% 的像素挤在峰值 10% 以内，读成一张过曝的白饼（实测
 * `meanLum 0.797 / 峰值附近占比 0.408`，而上一版是 `0.682 / 0.062`）。
 * 现在把两头的**值**都收浅（孔底 −24%、亮块 +16%），靠标定把那点差距放大成
 * 约 1.7:1 的孔底:孔缘对比——这和上一版月海:高原的对比是同量级，而孔仍然是这张脸上
 * 最暗的东西（孔底低于月海暗块，所以它还读得出"孔"）。
 * 定这两个数时是**真渲染出来看**的：满月光照下按落屏尺寸（1080p 下月盘约 129 设备
 * 像素、retina 约 258）各出一张图逐版对比，孔底 −45% 那版一眼就是过曝的平盘。
 *
 * **刻意不含任何光照项**：反照率是月面自己的属性，不随月相变（旧的手写 fallback
 * 把"迎光壁更亮"算了进来，那是**光照**——渲染侧已按光方向做过一次，这边再做一次
 * 就是两次；孔缘因此是**对称**的亮环，与何时看、看哪一面无关）。
 *
 * 亮度即反照率：0 = 最暗、1 = 最亮。绝对数值只表达**相对**关系（见上）。
 *
 * ── 确定性 ──────────────────────────────────────────────────────────
 * 细颗粒全部出自 `mulberry32(MOON_SEED)`：同种子逐字节可复现。月面每次刷新换一副
 * 面孔就成了噪点而不是月亮（测试 `tests/riverboard-moon.test.mjs` 锁这一条）。
 */

/** 反照率网格边长（月盘**外接正方形**内的采样数，盘外的角落不参与采样）。
 *  它只是细节上限：256 已高于常见屏幕上月盘的设备像素数（1080p ≈ 130、retina ≈ 260）
 *  ——所以它不再是天花板，这与照片那版固定 192 有本质区别。 */
export const MOON_ALB_N = 256;

/** 大尺度块面压暗 / 提亮比例。两者都刻意收浅：标定区间由它们与孔底共同决定，
 *  任一头拉深都会把酪体挤到区间上端（见文件头那段"深浅不是看着定的"）。 */
const PATCH_DARK = 0.1;
const PATCH_BRIGHT = 0.16;

/** 大尺度块面：[cx, cy, rx, ry, depth]（月盘归一化 [-1,1]，depth > 0 压暗、< 0 提亮）。
 *  nx 右 = 月面东（λ+），ny 上 = 月面北（φ+）。
 *  前九个是**真实月海**（近地面正弦投影的近似位置）——它们同时是乳酪本体的凹陷块面；
 *  后四个是酪体的亮块（鼓包），避开月海中心，让盘面有起伏而不是一块匀饼。 */
const PATCHES: [number, number, number, number, number][] = [
    [-0.4, 0.05, 0.3, 0.26, PATCH_DARK], // 风暴洋
    [-0.2, 0.38, 0.17, 0.13, PATCH_DARK], // 雨海
    [0.24, 0.12, 0.18, 0.14, PATCH_DARK], // 静海
    [0.14, 0.27, 0.13, 0.1, PATCH_DARK], // 澄海
    [0.45, -0.02, 0.14, 0.1, PATCH_DARK], // 丰富海
    [0.55, 0.16, 0.1, 0.07, PATCH_DARK], // 危海
    [0.06, 0.2, 0.1, 0.07, PATCH_DARK], // 汽海
    [-0.13, -0.24, 0.14, 0.1, PATCH_DARK], // 云海
    [-0.33, -0.21, 0.1, 0.07, PATCH_DARK], // 湿海
    [0.02, -0.34, 0.2, 0.13, -PATCH_BRIGHT], // 酪体亮块（南中）
    [-0.56, 0.08, 0.15, 0.12, -PATCH_BRIGHT], // 酪体亮块（西）
    [0.4, 0.28, 0.17, 0.13, -PATCH_BRIGHT], // 酪体亮块（东北）
    [0.1, 0.02, 0.13, 0.15, -PATCH_BRIGHT], // 酪体亮块（中央）
];

/** 乳酪孔：[cx, cy, r]（月盘归一化 [-1,1]，r 是孔半径）。
 *  手工排布而不是 PRNG 撒点——要的是**分布均匀、大小有层次、互不重叠**，
 *  随机撒点做不到（会挤成一坨、也会互相咬边）。所有孔都保证 `|c| + r < 0.9`，
 *  边缘那个圈留白，免得孔被月缘切掉半个读成缺口。 */
const HOLES: [number, number, number][] = [
    [-0.42, 0.30, 0.15],
    [-0.12, -0.10, 0.135],
    [0.16, 0.42, 0.12],
    [0.44, 0.06, 0.11],
    [-0.30, -0.42, 0.10],
    [0.62, -0.34, 0.09],
    [0.05, -0.62, 0.085],
    [-0.68, -0.05, 0.075],
    [0.30, 0.68, 0.07],
    [-0.55, 0.62, 0.065],
    [0.68, 0.44, 0.06],
    [-0.08, 0.18, 0.055],
    [0.38, -0.68, 0.055],
];

/** 酪体基准亮度（反照率 1.0 = 最亮；块面/孔/颗粒都在它上面乘） */
const HIGHLAND = 1.0;
/** 孔底压暗比例（0.24 ⇒ 孔底 ≈ 酪体的 0.76；**收浅是刻意的**，见文件头） */
const HOLE_DEPTH = 0.24;
/** 孔底剖面的陡度：指数 < 1 ⇒ 底平、肩陡（挖出来的孔，不是被砸出来的坑） */
const HOLE_SHAPE = 0.7;
/** 孔缘亮边增益（窄缘：孔底:孔缘经标定放大后约 1.7:1） */
const RIM_GAIN = 0.18;
/** 孔缘环带的内边界（d2 从 RIM_INNER 到 1 的一条正弦包络，两端为 0 不产生硬边）。
 *  取 0.75 = 只占孔半径外侧的 25%：宽缘会让每个孔变成一圈粗亮环（读成环形山而不是
 *  "挖出来的孔"），窄缘才是孔沿那一道高光。 */
const RIM_INNER = 0.75;
/** 极区提亮（乳酪没有极冠，只留一点，免得上下缘读成被切平） */
const POLAR_GAIN = 0.06;
/** 细孔个数 / 亮斑个数（固定数量 + 固定种子 ⇒ 确定性） */
const SPECK_DARK = 430;
const SPECK_BRIGHT = 90;
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
 *  盘外（外接正方形的四角）不参与采样，值保持酪体基准，无意义。 */
export function moonAlbedo(n = MOON_ALB_N): Float32Array {
    const a = new Float32Array(n * n).fill(HIGHLAND);
    /** 归一化区间 [lo,hi] 映射到网格下标区间（含端点，外扩 1 格保证柔边不被切）。
     *  **只对 x 成立**（`px2nx` 随下标递增）；y 要用下面的 `spanY`。 */
    const span = (lo: number, hi: number) => {
        const i0 = Math.max(0, Math.floor(((lo + 1) / 2) * n) - 1);
        const i1 = Math.min(n - 1, Math.ceil(((hi + 1) / 2) * n) + 1);
        return [i0, i1] as const;
    };
    /** y 的版本。`py2ny(py) = 1 - ((py+0.5)/n)*2 = -px2nx(py)` 是**取反**映射（ny 向上、
     *  行号向下），所以 ny∈[lo,hi] 对应的行区间就是 `span(-hi,-lo)`。
     *
     *  ⚠️ 20260926 修掉一个一直没被看见的缺陷：这里原先把 `span` 直接用在 y 上，于是
     *  每个地物只被**访问**到**镜像纬度**那条行带（真正的圆在另一半球、根本没进循环），
     *  南北两极附近的地物整块没画（第谷 -0.686、柏拉图 +0.784 全都不在盘上）。当时
     *  的测试只看"暗像素总数 > 200"，赤道附近那几个够用 ⇒ 缺陷一直是绿的。 */
    const spanY = (lo: number, hi: number) => span(-hi, -lo);
    const px2nx = (px: number) => ((px + 0.5) / n) * 2 - 1;
    const py2ny = (py: number) => 1 - ((py + 0.5) / n) * 2;

    // ① 大尺度块面：柔边（depth < 0 提亮，`1 - depth·s` 就是 `1 + |depth|·s`）
    for (const [cx, cy, rx, ry, depth] of PATCHES) {
        const [x0, x1] = span(cx - rx, cx + rx);
        const [y0, y1] = spanY(cy - ry, cy + ry);
        for (let py = y0; py <= y1; py++) {
            const ny = py2ny(py);
            for (let px = x0; px <= x1; px++) {
                const nx = px2nx(px);
                const dx = (nx - cx) / rx, dy = (ny - cy) / ry;
                const d2 = dx * dx + dy * dy;
                if (d2 >= 1) continue;
                a[py * n + px] *= 1 - depth * Math.pow(1 - d2, 1.5);
            }
        }
    }

    // ② 乳酪孔：底平肩陡的暗腔 + 一圈对称亮缘
    for (const [cx, cy, r] of HOLES) {
        const [x0, x1] = span(cx - r, cx + r);
        const [y0, y1] = spanY(cy - r, cy + r);
        for (let py = y0; py <= y1; py++) {
            const ny = py2ny(py);
            for (let px = x0; px <= x1; px++) {
                const nx = px2nx(px);
                const dx = (nx - cx) / r, dy = (ny - cy) / r;
                const d2 = dx * dx + dy * dy;
                if (d2 >= 1) continue;
                // 孔腔（指数 < 1 ⇒ 中心一大片平底，靠近孔壁才急降）
                a[py * n + px] *= 1 - HOLE_DEPTH * Math.pow(1 - d2, HOLE_SHAPE);
                // 孔缘亮边：正弦包络，两端为 0（孔外一圈平滑接回酪体，无硬边）
                if (d2 > RIM_INNER) {
                    const t = (d2 - RIM_INNER) / (1 - RIM_INNER);
                    a[py * n + px] *= 1 + RIM_GAIN * Math.sin(t * Math.PI);
                }
            }
        }
    }

    // ③ 细孔带（固定种子）：小孔（暗腔 + 淡亮缘）与亮斑（反光的小凸起）
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
        // 细孔比第一版更小一档（0.004 起）：大中小三级孔洞才像乳酪
        const r = isDark ? 0.004 + rnd() * 0.018 : 0.005 + rnd() * 0.011;
        // 细孔的深浅压在孔底之上（0.14 < HOLE_DEPTH）⇒ p5 那个位置由**大孔**占住，
        // 标定区间不被一片小噪点拽走；同时它们仍是可见的一层肌理
        const amp = isDark ? 0.05 + rnd() * 0.09 : 0.05 + rnd() * 0.07;
        const [x0, x1] = span(cx - r, cx + r);
        const [y0, y1] = spanY(cy - r, cy + r);
        for (let py = y0; py <= y1; py++) {
            const ny = py2ny(py);
            for (let px = x0; px <= x1; px++) {
                const nx = px2nx(px);
                const dx = (nx - cx) / r, dy = (ny - cy) / r;
                const d2 = dx * dx + dy * dy;
                if (d2 >= 1) continue;
                if (isDark) {
                    a[py * n + px] *= 1 - amp * Math.pow(1 - d2, HOLE_SHAPE);
                    if (d2 > RIM_INNER) {
                        a[py * n + px] *= 1 + amp * 0.8 * Math.sin(((d2 - RIM_INNER) / (1 - RIM_INNER)) * Math.PI);
                    }
                } else {
                    a[py * n + px] *= 1 + amp * (1 - d2);
                }
            }
        }
    }

    // ④ 极区 + 逐像素颗粒
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

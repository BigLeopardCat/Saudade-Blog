// ═ 河灯页月盘 sprite（20260926）══
//   node tests/riverboard-moon.test.mjs
//
// 现场（用户报的）：河灯页的月亮是糊的。查下来不是"纹理不好看"，是两条机械成因：
//   ① 月盘烘在整屏静态层里，而静态层每帧按**非整数**偏移合成（视差）⇒ 月缘这种高频
//      边缘每帧被双线性重采样一次；月盘还被烤进 baseBack 与 baseFront 两份 ⇒ 二次重采样。
//   ② 反照率来自 moon_tex.ts 那张**固定 192×192** 的照片采样，而月盘的设备像素数随屏幕
//      走（1080p ≈ 130、retina ≈ 260）⇒ 192 被放大本身就是糊的，源照片也已丢失。
//
// 修法：反照率改成程序化现画（moon_surface.ts，按需要的尺寸生成、天花板消失），月盘独立成
//   sprite、**设备整像素**落屏（恒等变换 1:1 drawImage，零重采样），画在 baseFront 之后。
//
// 20260926 第二轮：用户看完这一版说"月亮有点害羞，换成类似奶酪的月亮吧"⇒ 反照率生成器
//   换成奶酪孔（`moon_surface.ts`，月相/光照/遮挡一行没动）。本条只把 ③ 的判据按新输出的
//   实测值重定，并补两条**只有奶酪孔才成立**的判据（成片性、孔在自己那一侧）。
//
// 本套件锁三件：
//   ① 落位数学 —— moonSpriteGeometry 对 dpr 1 / 1.25 / 1.5 / 2 都给出设备整像素，圆心
//      误差 ≤ 半个设备像素，size 随 dpr 线性增长（这是"不糊"的直接判据）；
//   ② 反照率 —— 同种子逐字节可复现（刷新换一副月面就成了噪点），且**不是一块平盘**
//      （有孔底那种暗区、也有亮块/孔缘那种亮区，标准差远离 0）；
//   ③ 接线 —— 源码契约：sprite 在 baseFront 之后画、每个 renderBase 只烘一次、
//      moon_tex 那条照片路已断（文件已删、无残留 import）。
//
// moon_surface.ts 是纯 TS（无 DOM、无 canvas），所以直接 esbuild 摊平后 import 即可，
// 不需要像 live-refresh 那样装假浏览器。
import * as esbuild from 'esbuild';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = mkdtempSync(path.join(tmpdir(), 'moonsurface-'));
const file = path.join(out, 'moon_surface.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/pages/RiverBoard/moon_surface.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
});
const M = await import(pathToFileURL(file).href);

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (got, want, name) => ok(got === want, name, { got, want });

console.log('\n① 落位：设备整像素（每帧非整数重采样就是"糊"的直接成因）');
{
    const DP = [1, 1.25, 1.5, 2];
    for (const dpr of DP) {
        const geo = M.moonSpriteGeometry(960.37, 300.61, 200, dpr);
        ok(Number.isInteger(geo.x) && Number.isInteger(geo.y),
            `dpr ${dpr} ⇒ x/y 是设备整像素`, geo);
        // 圆心最多偏半个设备像素：size 取整之后无法再对齐时，这是能做到的最好
        const dx = Math.abs((geo.x + geo.size / 2) - 960.37 * dpr);
        const dy = Math.abs((geo.y + geo.size / 2) - 300.61 * dpr);
        ok(dx <= 0.5 && dy <= 0.5, `dpr ${dpr} ⇒ 圆心误差 ≤ 半个设备像素`, { dx, dy });
    }
    eq(M.moonSpriteGeometry(100, 100, 200, 1).size, 200, 'size = round(直径 × dpr)（dpr 1）');
    eq(M.moonSpriteGeometry(100, 100, 200, 2).size, 400, '  dpr 2 ⇒ 两倍设备像素（不再是 192 天花板）');
    const s1 = M.moonSpriteGeometry(100, 100, 200, 1).size;
    const s2 = M.moonSpriteGeometry(100, 100, 200, 2).size;
    ok(s2 > s1 * 1.9 && s2 < s1 * 2.1, 'size 随 dpr 线性增长', { s1, s2 });
    ok(M.moonSpriteGeometry(0, 0, 1, 1).size >= 8, '极小直径也保底 8 设备像素（drawImage 不吃 0）');
    eq(M.moonSpriteGeometry(100, 100, 200, 2).ss, M.MOON_SPRITE_SS, '内部超采样倍数随 geometry 一起给出');
    ok(M.MOON_SPRITE_SS >= 2, '超采样 ≥ 2（月缘抗锯齿一次到位）');
}

console.log('\n② 反照率：确定性（同种子逐字节相同，刷新不许换一副面孔）');
{
    const a = M.moonAlbedo();
    const b = M.moonAlbedo();
    eq(a.length, M.MOON_ALB_N * M.MOON_ALB_N, '网格 = N×N（N = MOON_ALB_N）');
    let same = true;
    for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { same = false; break; } }
    ok(same, '两次生成逐字节相同（固定种子 PRNG，不依赖平台随机源）');
    const c = M.moonAlbedo(64);
    eq(c.length, 64 * 64, '换网格边长照样生成（N 是参数）');
}

console.log('\n③ 反照率：不是一块平盘（有孔底那种暗区，也有亮块/孔缘那种亮区）');
{
    const n = M.MOON_ALB_N;
    const a = M.moonAlbedo();
    // 阈值全部按**这一版生成器的实测输出**定（旧版是 0.7/1.05；换成奶酪孔后孔底只有
    // −24%——刻意收浅，理由见 moon_surface.ts 文件头那段"深浅不是看着定的"）。
    const DARK_T = 0.85, BRIGHT_T = 1.05;
    // 只统计**月盘内**的像素（外接正方形的四角本来就不显示，不参与渲染）
    let cnt = 0, sum = 0, mn = Infinity, mx = -Infinity, dark = 0, bright = 0;
    const inner = [], inside = [];
    for (let y = 0; y < n; y++) {
        const ny = 1 - ((y + 0.5) / n) * 2;
        for (let x = 0; x < n; x++) {
            const nx = ((x + 0.5) / n) * 2 - 1;
            if (nx * nx + ny * ny > 1) continue;
            const v = a[y * n + x];
            inner.push(v); inside.push([x, y]); cnt++; sum += v;
            if (v < mn) mn = v;
            if (v > mx) mx = v;
            if (v < DARK_T) dark++;          // 孔底
            if (v > BRIGHT_T) bright++;      // 亮块 / 孔缘
        }
    }
    const mean = sum / cnt;
    let v2 = 0;
    for (const v of inner) v2 += (v - mean) * (v - mean);
    const sd = Math.sqrt(v2 / cnt);

    ok(sd > 0.05, '亮度标准差远离 0（不是平盘）', { sd });
    ok(mx - mn > 0.4, '最亮与最暗拉开 > 0.4（孔底与亮块的对比肉眼可见）', { mn, mx });
    ok(dark > 800, '存在成片的暗区（乳酪孔底）', { dark, pct: +(dark / cnt * 100).toFixed(1) });
    ok(bright > 800, '存在成片的亮区（酪体亮块/孔缘）', { bright, pct: +(bright / cnt * 100).toFixed(1) });
    ok(mn >= 0.02 - 1e-9, '下界被夹住（永不为 0/负，避免除零与负反照率）', { mn });
    ok(inner.every((v) => v > 0 && v < 4), '全部为有限正常值（无 NaN/Infinity 漏出）');

    // 亮暗两类的中心必须是分开的——只看"有暗有亮"会被单像素噪声骗过
    const dm = inner.filter((v) => v < DARK_T).reduce((s, v) => s + v, 0) / Math.max(1, dark);
    const bm = inner.filter((v) => v > BRIGHT_T).reduce((s, v) => s + v, 0) / Math.max(1, bright);
    ok(bm - dm > 0.2, '亮类均值 - 暗类均值 > 0.2（两类是分开的，不是噪声）', { dm, bm });

    // ── 奶酪孔的本体判据：暗像素必须**成片**（孔是挖出来的腔，不是撒上去的暗噪点）。
    //    每个暗像素数 4 邻域里"也同样暗"的个数，≥3 的占比要高：细颗粒噪点会很低
    let contig = 0;
    const isDark = (x, y) => x >= 0 && y >= 0 && x < n && y < n && a[y * n + x] < DARK_T;
    for (const [x, y] of inside) {
        if (!isDark(x, y)) continue;
        let nb = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (isDark(x + dx, y + dy)) nb++;
        if (nb >= 3) contig++;
    }
    const ratio = contig / dark;
    ok(ratio > 0.6, '暗像素成片（4 邻域≥3 同暗的占比 > 0.6 ⇒ 是孔腔不是暗噪点）', { ratio: +ratio.toFixed(3) });

    // ── 每个孔必须画在**它自己声明的纬度**上。
    //    20260926 修掉的那个缺陷就在这里：纬度行带原先按镜像扫描（`span` 用在 y 上），
    //    南北两极附近的孔整块没画（第谷 -0.686、柏拉图 +0.784 全不在盘上），
    //    而当时的判据只看"暗像素总数"⇒ 一直是绿的。孔位从源码里读，避免测试与实现脱钩。
    const src = readFileSync(path.join(root, 'src/pages/RiverBoard/moon_surface.ts'), 'utf8');
    const block = src.match(/const HOLES: \[number, number, number\]\[\] = \[([\s\S]*?)\n\];/);
    ok(!!block, '源码里能读到 HOLES 表（孔位是这张表声明的）');
    const holes = [...(block ? block[1] : '').matchAll(/\[(-?[\d.]+),\s*(-?[\d.]+),\s*([\d.]+)\]/g)]
        .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    ok(holes.length >= 8, '孔位表至少有 8 个孔', { n: holes.length });
    const at = (nx, ny) => {
        const x = Math.min(n - 1, Math.max(0, Math.floor(((nx + 1) / 2) * n)));
        const y = Math.min(n - 1, Math.max(0, Math.floor(((1 - ny) / 2) * n)));
        return a[y * n + x];
    };
    const body = inner.slice().sort((p, q) => p - q)[Math.floor(cnt / 2)];   // 酪体中位
    const missed = holes.filter(([cx, cy]) => !(at(cx, cy) < body - 0.1));
    ok(missed.length === 0, '每个孔的**自己那个圆心**都是暗腔（≠ 被画到镜像纬度去了）',
        { missed, body: +body.toFixed(3) });
    // 镜像纬度那条行带必须是酪体（离赤道越远越确定；|cy| ≥ 0.3 的孔逐个验，
    // 若镜像点正好落在另一个孔里就跳过——那不是缺陷的证据）
    const wrong = [];
    for (const [cx, cy, r] of holes) {
        if (Math.abs(cy) < 0.3) continue;
        const inOther = holes.some(([ox, oy, orr]) =>
            Math.hypot(cx - ox, -cy - oy) < orr * 1.2);
        if (inOther) continue;
        if (!(at(cx, -cy) - at(cx, cy) > 0.15)) wrong.push([cx, cy, +at(cx, cy).toFixed(3), +at(cx, -cy).toFixed(3)]);
    }
    ok(wrong.length === 0, '南北两侧的孔各在自己那一侧（同 x 的镜像纬度是酪体）', { wrong });
}

console.log('\n④ 源码契约：月盘是屏幕上的唯一一份、在 baseFront 之后、每个 renderBase 只烘一次');
{
    const tsx = readFileSync(path.join(root, 'src/pages/RiverBoard/index.tsx'), 'utf8');
    ok(!/from\s+["']\.\/moon_tex["']/.test(tsx), 'index.tsx 已无 moon_tex 的 import（照片那条路已断）');
    ok(!existsSync(path.join(root, 'src/pages/RiverBoard/moon_tex.ts')), 'moon_tex.ts 文件已删（几百 KB base64 死重）');
    ok(/from\s+["']\.\/moon_surface\.ts["']/.test(tsx), 'index.tsx 从 moon_surface.ts 取反照率与落位');

    // 每个 renderBase 只烘一次 sprite：定义处 1 次 "buildMoonSprite = ("、调用处 1 次 "buildMoonSprite("
    const calls = (tsx.match(/(?<![=\w])buildMoonSprite\(/g) || []).length;
    eq(calls, 1, 'buildMoonSprite 只被调用一次（sprite 与光晕同源 ⇒ 永不脱相）');

    // 层次：sprite 必须画在 baseFront **之后**（否则又被静态层重采样一次）
    const iFront = tsx.indexOf('ctx.drawImage(baseFront');
    const iMoon = tsx.indexOf('ctx.drawImage(moonSprite.cv');
    ok(iFront >= 0 && iMoon > iFront, 'sprite 画在 baseFront 之后（屏幕上唯一的一份月亮）', { iFront, iMoon });

    // 1:1 落屏：恒等变换 + 设备像素矩形，缺一个就又会重采样
    const seg = tsx.slice(tsx.lastIndexOf('if (moonSprite)', iMoon), iMoon + 120);
    ok(/setTransform\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)/.test(seg), '画 sprite 前把变换设成恒等（几何是设备像素）', seg);
    ok(/geo\.x,\s*geo\.y,\s*geo\.size,\s*geo\.size/.test(seg), 'drawImage 的矩形取自 moonSpriteGeometry（不是就地算的浮点）');

    // 静态层那份月亮必须已经不在了：光晕仍在，但月盘/反照率不再进 baseBack
    ok(!/loadMoonTex/.test(tsx), '不再有 loadMoonTex 这条异步补纹理的路（sprite 在 renderBase 里同步烘好）');
    ok(!/texApplied/.test(tsx), 'texApplied 那条"纹理到位再重绘"的状态已撤（不再需要）');

    const scss = readFileSync(path.join(root, 'src/pages/RiverBoard/index.scss'), 'utf8');
    const m = scss.match(/\.rz-home-btn\s*\{[^}]*left:\s*34px;\s*bottom:\s*(\d+)px;/);
    ok(!!m, 'scss 里有 .rz-home-btn（左下角回主页）');
    eq(m && Number(m[1]), 200, '  位置在灯影集（bottom 116、高约 68）之上，不叠');
}

console.log('\n⑤ 回主页：走 router 跳转，不整页刷新');
{
    const tsx = readFileSync(path.join(root, 'src/pages/RiverBoard/index.tsx'), 'utf8');
    ok(/import\s*\{\s*useNavigate\s*\}\s*from\s*["']react-router-dom["']/.test(tsx), '引了 useNavigate');
    ok(/const\s+navigate\s*=\s*useNavigate\(\)/.test(tsx), '组件里取了 navigate');
    ok(/className="rz-home-btn"[\s\S]{0,160}navigate\("\/"\)/.test(tsx), '按钮点了 navigate("/")（同树内跳转，不整页刷新）');
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);

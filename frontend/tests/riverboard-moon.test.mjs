// ═ 河灯页月盘 sprite：留言板暖纸风格回归（20261005）══
//   node tests/riverboard-moon.test.mjs
//
// 现场（用户报的）：河灯页的月亮是糊的。查下来不是"纹理不好看"，是两条机械成因：
//   ① 月盘烘在整屏静态层里，而静态层每帧按**非整数**偏移合成（视差）⇒ 月缘这种高频
//      边缘每帧被双线性重采样一次；月盘还被烤进 baseBack 与 baseFront 两份 ⇒ 二次重采样；
//   ② 径向 limb / sunGain / alpha 叠加会把月面压成同心圆环，照片细节也不适合留言板主题。
//
// 修法：月盘独立成 sprite、**设备整像素**落屏（恒等变换 1:1 drawImage，零重采样），
// 画在 baseFront 之后；渲染层只保留暖纸色、低对比月海和干净月相终止线。
//
// 本套件锁六件：
//   ① 落位数学 —— moonSpriteGeometry 对 dpr 1 / 1.25 / 1.5 / 2 都给出设备整像素，圆心
//      误差 ≤ 半个设备像素，size 随 dpr 线性增长（这是"不糊"的直接判据）；
//   ② 载荷 —— base64 解出来正好是 N×N 个字节、值全落在声明的窗口内、重复取用逐字节相同；
//   ③ 这是一张**真月面**，且方向没搞反 —— 亮度标准差、东西/南北不对称、最亮最暗那 1% 的
//      方位（第谷辐射纹在南、风暴洋在西）、暗区成片。这几条合起来能挡住"换成一团噪声"
//      "上下/左右镜像了""表被填平了"三类事故。
//   ⑥ 真渲染 —— 把 `buildMoonSprite` 从 index.tsx 里**切出来真跑一遍**（不是手抄的数学镜像），
//      按真实落屏尺寸量亮度/色温/过曝。这一节是"用户说丑、我却说验过了"那次的直接产物：
//      整页截图里月盘只有 86 设备像素，肉眼判不出它是一颗发暗的棕球还是月亮。
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
const RB = path.join(root, 'src/pages/RiverBoard');
const out = mkdtempSync(path.join(tmpdir(), 'moonsurface-'));
const file = path.join(out, 'moon_surface.mjs');
await esbuild.build({
    entryPoints: [path.join(RB, 'moon_surface.ts')],
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

console.log('\n② 载荷：base64 解出来正好是 N×N，值全在声明的窗口内');
{
    const n = M.MOON_ALB_N;
    ok(n >= 256, '网格边长 ≥ 256（月盘设备像素数：1080p ≈ 130、retina ≈ 194）', { n });

    // 生成文件：分片 base64 + 三个常量（N/LO/HI）。**别手改**——它是脚本产物
    const dataTs = readFileSync(path.join(RB, 'moon_albedo_data.ts'), 'utf8');
    ok(/由\s*`build_moon_albedo\.py`\s*生成|由 build_moon_albedo\.py 生成/.test(dataTs),
        '数据文件头标着"由 build_moon_albedo.py 生成"（手改会在这里露馅）');
    const b64 = [...(dataTs.split('MOON_ALB_B64 =')[1] || '').matchAll(/"([A-Za-z0-9+/=]+)"/g)]
        .map((m) => m[1]).join('');
    eq(b64.length, Math.ceil(n * n / 3) * 4, 'base64 长度 = 4·⌈N²/3⌉（分片拼回来不短不长）');
    eq(Buffer.from(b64, 'base64').length, n * n, '  解码后的字节数 = N×N');
    // ⚠️ 载荷必须是**数组 + join("")**，不能是 `"a" + "b" + …` 的连加：900 多层左嵌套的
    // BinaryExpression 会让 `eslint . --ext ts,tsx`（CI 质量闸那一步）报
    // "Parsing error: Maximum call stack size exceeded" —— 一条红的 ESLint 能让部署停下来。
    ok(!/"[^"\n]*"\s*\+\s*$/m.test(dataTs), '载荷是数组 + join("")，不是字符串连加（连加会爆 ESLint 调用栈）');
    const lo = Number((dataTs.match(/MOON_ALB_LO = ([\d.]+)/) || [])[1]);
    const hi = Number((dataTs.match(/MOON_ALB_HI = ([\d.]+)/) || [])[1]);
    ok(Number.isFinite(lo) && Number.isFinite(hi) && hi > lo, '数据文件声明了 LO < HI', { lo, hi });

    const a = M.moonAlbedo();
    eq(a.length, n * n, 'moonAlbedo() 长度 = N×N');
    let mn = Infinity, mx = -Infinity, bad = 0;
    for (const v of a) {
        if (!Number.isFinite(v)) bad++;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
    }
    eq(bad, 0, '全部是有限数（无 NaN/Infinity 漏出）');
    // 值域 = 声明的窗口 ⇒ 证明解码用的就是这份 LO/HI（换成别的常数立刻红）
    ok(mn >= lo - 1e-6 && mx <= hi + 1e-6, '全部落在 [MOON_ALB_LO, MOON_ALB_HI] 内', { mn, mx, lo, hi });
    ok(mx - mn > 0.3, '整张表拉开了 > 0.3（不是被压成一条线）', { mn, mx });

    // 载荷是常量 ⇒ 两次取用逐字节相同（刷新换一副月面那种事结构上不可能发生）
    const b = M.moonAlbedo();
    let same = true;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { same = false; break; }
    ok(same, '两次取用逐字节相同（载荷是常量，不依赖任何随机源/时间）');

    // 重采样（n ≠ MOON_ALB_N 时走双线性）：长度对、值仍在窗口内、不炸
    const c = M.moonAlbedo(64);
    eq(c.length, 64 * 64, '换网格边长照样生成（重采样）');
    let cok = true;
    for (const v of c) if (!(v >= lo - 1e-6 && v <= hi + 1e-6)) { cok = false; break; }
    ok(cok, '  重采样后仍在窗口内（双线性不会越界）');
}

console.log('\n③ 载荷仍稳定，但渲染不再照搬照片');
{
    const n = M.MOON_ALB_N;
    const a = M.moonAlbedo();
    const dataTs = readFileSync(path.join(RB, 'moon_albedo_data.ts'), 'utf8');
    const lo = Number((dataTs.match(/MOON_ALB_LO = ([\d.]+)/) || [])[1]);
    const hi = Number((dataTs.match(/MOON_ALB_HI = ([\d.]+)/) || [])[1]);
    const nxOf = (px) => ((px + 0.5) / n) * 2 - 1;
    const nyOf = (py) => 1 - ((py + 0.5) / n) * 2;

    // 只统计**盘内**的 texel（外接正方形的四角是配方脚本按径向投影填的，渲染不采样）
    const X = [], Y = [], V = [];
    for (let py = 0; py < n; py++) {
        for (let px = 0; px < n; px++) {
            const x = nxOf(px), y = nyOf(py);
            if (x * x + y * y > 1) continue;
            X.push(x); Y.push(y); V.push(a[py * n + px]);
        }
    }
    const cnt = V.length;
    ok(cnt > 0.77 * n * n && cnt < 0.79 * n * n, '盘内 texel 占 ≈ π/4', { pct: +(cnt / (n * n)).toFixed(3) });
    const mean = V.reduce((s, v) => s + v, 0) / cnt;
    const sd = Math.sqrt(V.reduce((s, v) => s + (v - mean) * (v - mean), 0) / cnt);
    // 阈值按本版实测定（sd 0.204 / 东西差 +0.151 / 南北差 +0.117）
    ok(sd > 0.12, '亮度标准差远离 0（不是平盘，也不是白饼）', { sd: +sd.toFixed(4) });

    const pick = (sel) => {
        let c = 0, s = 0;
        for (let i = 0; i < cnt; i++) if (sel(X[i], Y[i])) { c++; s += V[i]; }
        return { c, m: c ? s / c : NaN };
    };
    const west = pick((x) => x < 0), east = pick((x) => x >= 0);
    const north = pick((_, y) => y > 0), south = pick((_, y) => y <= 0);

    // 月面的东西不对称是**近地面最硬的事实**：西半球被风暴洋/雨海占着（暗），
    // 东缘与南部是高地（亮）。左<右 ⇒ 顺带把"左右镜像了"挡在门外。
    ok(east.m - west.m > 0.08, '东半比西半亮（西侧月海多）⇒ 左右没镜像',
        { west: +west.m.toFixed(3), east: +east.m.toFixed(3), d: +(east.m - west.m).toFixed(3) });
    ok(south.m - north.m > 0.05, '南半比北半亮（南部高地）⇒ 上下没翻转',
        { north: +north.m.toFixed(3), south: +south.m.toFixed(3), d: +(south.m - north.m).toFixed(3) });

    // 编码窗口两头是配方脚本留的余量（`ALB_LO/HI` 取在实测 p1/p99 的外侧），被夹住的像素在
    // 表里是一个**平平台**——它们的方位只是一堆散点的平均（实测触顶那一撮质心 ny≈+0.01，
    // 毫无方向性），拿它去当"最亮的地方"会把判据稀释掉。渲染侧本来也看不到这个平台：
    // `ensureMoonAlbedo` 的 p95 标定（实测 1.377）还在夹顶（1.45）**下面**，屏幕上的峰值
    // 由 p95 决定。所以这一条只要求"夹住的是一小撮"（配方侧选窗口的事），不要求零夹取。
    const cHi = V.filter((v) => v >= hi - 1e-6).length;
    const cLo = V.filter((v) => v <= lo + 1e-6).length;
    ok((cHi + cLo) / cnt < 0.05, '编码窗口没有把照片压扁（触顶/触底的合计 < 5%）',
        { cHi, cLo, pct: +(((cHi + cLo) / cnt) * 100).toFixed(2) });

    // 最亮/最暗那 1% 的**方位**：第谷的辐射纹在南部高原、风暴洋在西侧。
    // 这两条比"某个月海亮暗"稳得多——月海的日心坐标经正交投影落到盘上会被天平动
    // （SVS 那张是某一时刻的真实视角，天平动可达 ±8° ≈ 0.14 个盘半径）挪掉大半个窗口，
    // 而"南半球最亮、西半球最暗"是半球尺度的事实，挪不动。
    const live = V.map((v, i) => i).filter((i) => V[i] > lo + 1e-6 && V[i] < hi - 1e-6);
    const ranked = live.slice().sort((p, q) => V[q] - V[p]);
    const k1 = Math.max(1, Math.round(live.length * 0.01));
    const top = ranked.slice(0, k1), bot = ranked.slice(-k1);
    const cen = (arr) => ({
        nx: arr.reduce((s, i) => s + X[i], 0) / arr.length,
        ny: arr.reduce((s, i) => s + Y[i], 0) / arr.length,
    });
    const bt = cen(top), dk = cen(bot);
    ok(bt.ny < -0.2, '最亮的 1% 在南半球（第谷辐射纹）',
        { nx: +bt.nx.toFixed(3), ny: +bt.ny.toFixed(3) });
    ok(dk.nx < -0.1, '最暗的 1% 在西半球（风暴洋一带）',
        { nx: +dk.nx.toFixed(3), ny: +dk.ny.toFixed(3) });

    // 月海是**成片**的（这是照片与"撒上去的随机噪点"的分水岭）：16×16 分箱后取暗箱，
    // 数 4 邻域里同样暗的个数 ≥3 的占比。实测 0.52。
    const K = 16, B = n / K;
    const bin = new Float64Array(K * K);
    for (let by2 = 0; by2 < K; by2++) {
        for (let bx2 = 0; bx2 < K; bx2++) {
            let s = 0, c = 0;
            for (let py = by2 * B; py < (by2 + 1) * B; py++) {
                for (let px = bx2 * B; px < (bx2 + 1) * B; px++) { s += a[py * n + px]; c++; }
            }
            const x = nxOf(bx2 * B + B / 2), y = nyOf(by2 * B + B / 2);
            bin[by2 * K + bx2] = (x * x + y * y <= 0.9 * 0.9) ? s / c : NaN;
        }
    }
    const dark = (i, j) => i >= 0 && j >= 0 && i < K && j < K && bin[i * K + j] < 0.9;
    let tot = 0, contig = 0;
    for (let i = 0; i < K; i++) {
        for (let j = 0; j < K; j++) {
            if (!dark(i, j)) continue;
            tot++;
            const nb = [dark(i - 1, j), dark(i + 1, j), dark(i, j - 1), dark(i, j + 1)].filter(Boolean).length;
            if (nb >= 3) contig++;
        }
    }
    const ratio = contig / Math.max(1, tot);
    ok(tot > 20, '分箱后有成片的暗区（月海）', { tot });
    ok(ratio > 0.3, '暗区成片（4 邻域≥3 同暗的占比 > 0.3 ⇒ 月海不是椒盐噪点）',
        { ratio: +ratio.toFixed(3) });

    // 盘外四角也是**有限、在窗口内**的值（配方脚本按径向投影填的）——不许给消费方留 0/NaN
    const corners = [a[0], a[n - 1], a[(n - 1) * n], a[n * n - 1]];
    ok(corners.every((v) => Number.isFinite(v) && v > 0.4 && v < 1.6),
        '外接正方形的四角是有限正常值（径向投影填充，不是 0/NaN）', { corners });
}

console.log('\n④ 源码契约：贴图那条路是同步的、在 baseFront 之后、每个 renderBase 只烘一次');
{
    const tsx = readFileSync(path.join(RB, 'index.tsx'), 'utf8');
    ok(!/from\s+["']\.\/moon_tex["']/.test(tsx), 'index.tsx 已无 moon_tex 的 import（那条 PNG 路已断）');
    ok(!existsSync(path.join(RB, 'moon_tex.ts')), 'moon_tex.ts 文件已删（几百 KB 的 base64 PNG 死重）');
    ok(/from\s+["']\.\/moon_surface\.ts["']/.test(tsx), 'index.tsx 从 moon_surface.ts 取反照率与落位');
    // ⚠️ 本轮最容易踩回去的坑：又去引一张图片、又走异步解码 + 就绪回调。
    // 第 37 轮的"改了半个月没生效"就是这么来的——载荷是**同步**解出来的字节表，
    // 结构上不需要"纹理就绪后重画一次静态层"。
    ok(!/loadMoonTex/.test(tsx), '不再有 loadMoonTex 这条异步补纹理的路');
    ok(!/texApplied/.test(tsx), 'texApplied 那条"纹理到位再重绘"的状态已撤（不再需要）');
    ok(!/Image\(\)|new Image|decode\(\)\.then/.test(tsx), 'index.tsx 里没有"解码图片"这类异步等待');

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

    // 反照率的来源链必须**完整**：生成文件 + 配方脚本 + 源照片三件都在。
    // "源照片已丢"是第 40 轮放弃照片纹理的直接原因，这条是那件事的回归锁。
    const surface = readFileSync(path.join(RB, 'moon_surface.ts'), 'utf8');
    ok(/from\s+["']\.\/moon_albedo_data\.ts["']/.test(surface), 'moon_surface.ts 从生成的数据文件取载荷');
    ok(existsSync(path.join(RB, 'moon_albedo_data.ts')), 'moon_albedo_data.ts 在（生成文件）');
    ok(existsSync(path.join(RB, 'build_moon_albedo.py')), 'build_moon_albedo.py 在（配方脚本）');
    ok(existsSync(path.join(RB, 'moon_source.jpg')), 'moon_source.jpg 在（源照片**已入库**，不会再"丢"）');
    ok(!existsSync(path.join(RB, 'sample_moon_tex.py')), '旧的 sample_moon_tex.py 已删（产物形态不存在了）');
    ok(/atob\(/.test(surface) && !/createImageBitmap|new Image/.test(surface),
        '解码走 atob（同步、无 DOM）——node 里能直接测就是靠这条');

    const scss = readFileSync(path.join(RB, 'index.scss'), 'utf8');
    const m = scss.match(/\.rz-home-btn\s*\{[^}]*left:\s*34px;\s*bottom:\s*(\d+)px;/);
    ok(!!m, 'scss 里有 .rz-home-btn（左下角回主页）');
    eq(m && Number(m[1]), 200, '  位置在灯影集（bottom 116、高约 68）之上，不叠');
}

console.log('\n⑤ 回主页：走 router 跳转，不整页刷新');
{
    const tsx = readFileSync(path.join(RB, 'index.tsx'), 'utf8');
    ok(/import\s*\{\s*useNavigate\s*\}\s*from\s*["']react-router-dom["']/.test(tsx), '引了 useNavigate');
    ok(/const\s+navigate\s*=\s*useNavigate\(\)/.test(tsx), '组件里取了 navigate');
    ok(/className="rz-home-btn"[\s\S]{0,160}navigate\("\/"\)/.test(tsx), '按钮点了 navigate("/")（同树内跳转，不整页刷新）');
}

console.log('\n⑥ 真渲染：把 index.tsx 里的 buildMoonSprite 切出来跑（不是手抄的镜像）');
{
    // 为什么要有这一节：20261001 用户报"留言板月亮吓死人，你这是贴图月亮？"——
    // 而当时我拿"一张 1280×720 的整页截图看着还行"当成了验证。整页截图里月盘只有
    // 86 设备像素，肉眼根本判不出它是发暗的棕球还是月亮。所以判据必须落在**像素级**：
    // 把真函数（不是重写一份数学）切出来，按真实落屏尺寸出图，量它的亮度与色温。
    // 阈值按当前的合成模型定标：
    //   · RGB 负责月面本身，alpha 只负责几何遮挡，避免透明度把纹理再压暗一次；
    //   · 曝光要足够让月面脱离夜空，但高光不能铺成一片白；
    //   · 蓝红比保持中性，避免照片纹理被渲染成土黄。
    const tsx = readFileSync(path.join(RB, 'index.tsx'), 'utf8');
    const slice = (a, b) => {
        const i = tsx.indexOf(a), j = tsx.indexOf(b, i);
        if (i < 0 || j < 0) throw new Error(`切不出「${a}」（源码结构变了，改这一节的锚点）`);
        return tsx.slice(i, j);
    };
    let cap = null;
    globalThis.document = {
        createElement: () => ({
            width: 0, height: 0,
            getContext: () => ({
                createImageData: (w, h) => (cap = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
                putImageData: () => {},
            }),
        }),
    };
    // 相位靠把源码里的 Date.now() 换成字面量来钉死（每档 8 分之一圈 = 3.69 天）
    const build = async (nowMs) => {
        const src = [
            `import { moonAlbedo } from ${JSON.stringify(path.join(RB, 'moon_surface.ts'))};`,
            'let moonAlbA = null; let moonSprite = null;',
            slice('const moonPhase = () => {', '\ninterface LanternMeta').replace('Date.now()', String(nowMs)),
            slice('const ensureMoonAlbedo = () => {', '\n\n/* 月盘 sprite'),
            slice('const moonPhaseParams = () => {', '\n\n/** 画月盘 sprite'),
            slice('const buildMoonSprite = (geo: { size: number; ss: number }) => {', '\n/* 性能（P2-2）'),
            'export { buildMoonSprite };',
        ].join('\n');
        const dir = mkdtempSync(path.join(tmpdir(), 'moonsprite-'));
        const out = path.join(dir, 's.mjs');
        await esbuild.build({
            stdin: { contents: src, resolveDir: RB, loader: 'ts' },
            bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
        });
        const M = await import(pathToFileURL(out).href);
        cap = null;
        M.buildMoonSprite({ size: 86, ss: 2 });   // 1280×720 @dpr1 下月盘的真实设备像素数
        return cap;
    };
    // 与上面 `moonPhase` 同源：以今天为基准，减到目标档
    const K0 = Date.UTC(2000, 0, 6, 18, 14), LUN = 29.53058867;
    const at = (want) => {
        const base = Date.UTC(2026, 9, 1, 1, 25);
        const age0 = (((base + 8 * 3600e3 - K0) / 86400000 / LUN) % 1 + 1) % 1;
        return Math.round(base - (((age0 - want + 1) % 1) * LUN * 86400000));
    };
    const stats = (img) => {
        const P = img.width;
        let lit = 0, sR = 0, sB = 0, blown = 0;
        for (let i = 0; i < P * P; i++) {
            if (img.data[i * 4 + 3] === 0) continue;
            lit++;
            sR += img.data[i * 4]; sB += img.data[i * 4 + 2];
            if (img.data[i * 4] >= 254) blown++;
        }
        return { litPct: (100 * lit) / ((Math.PI * P * P) / 4), meanR: sR / lit, br: sB / sR, blownPct: (100 * blown) / lit };
    };
    const CASES = [['满月', 0.5], ['凸月', 0.625], ['上弦', 0.25]];
    const got = [];
    for (const [name, q] of CASES) got.push([name, stats(await build(at(q)))]);
    for (const [name, s] of got) {
        ok(s.meanR >= 118, `${name}：盘内平均亮度落在"月亮"该有的亮带（≥118/255）`,
            { meanR: +s.meanR.toFixed(1) });
        ok(s.br >= 0.74 && s.br <= 0.82, `${name}：暖纸色比例稳定（B/R 介于 0.74–0.82）`, { br: +s.br.toFixed(3) });
        ok(s.blownPct < 10, `${name}：过曝面积受控（<10%）`, { pct: +s.blownPct.toFixed(2) });
    }
    // 满月整盘受光、上弦半盘 —— 遮挡范围由**几何**定，与反照率无关
    ok(got[0][1].litPct > 97, '满月：整盘都受光（亮面覆盖率 ≈ 100%）', { litPct: +got[0][1].litPct.toFixed(1) });
    ok(got[2][1].litPct > 45 && got[2][1].litPct < 57, '上弦：恰好半盘受光', { litPct: +got[2][1].litPct.toFixed(1) });

    ok(/const phaseAlpha = smoothstep\(/.test(tsx), '月相透明度由平滑终止线控制，不依赖月面纹理');
    ok(!/limbKp|limbPeak|sunGain|const occlude/.test(tsx),
        '渲染侧不再使用径向 limb/sunGain/occlude 链，避免生成同心圆环');
    ok(/const maria = \[/.test(tsx) && /暖纸色月面/.test(tsx),
        '月面使用固定的低对比手绘月海与暖纸色主题');
    ok(!/ALB_FLOOR|ALB_SPAN|moonAlbLo/.test(tsx), 'p5/p95 自适应拉伸那套已删干净');
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);

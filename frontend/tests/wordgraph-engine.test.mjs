// ═ 图谱引擎纯逻辑回归 ══
//   node tests/wordgraph-engine.test.mjs
// 覆盖投影（中心/方向/深度序/近裁剪）、pickNode 命中、locateLocal 关键词兜底、
// cameraFor 取景。engine.ts / locate.ts 是 TS，用 esbuild 打成 ESM 再 import
// ——本机禁止 vite build（3.7GB 内存会 OOM），单文件 esbuild 是既定替代手段。
import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = mkdtempSync(path.join(tmpdir(), 'wgt-'));

// runtimeApi.ts 顶层读 import.meta.env 与 window.location，两个都得先备好
const DEFINE = 'import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
    + '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}';

function bundle(rel, name) {
    const file = path.join(out, name);
    execFileSync(path.join(root, 'node_modules/.bin/esbuild'), [
        path.join(root, rel), '--bundle', '--format=esm', '--platform=neutral',
        `--outfile=${file}`, `--define:${DEFINE}`, '--log-level=error',
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
    return file;
}

globalThis.window ??= { location: { port: '', protocol: 'http:', hostname: 'localhost' } };

const W = 'src/frontHome/Content/ContentHome/Vitrine/wordgraph/';
const engine = await import(bundle(W + 'engine.ts', 'engine.mjs'));
const locate = await import(bundle(W + 'locate.ts', 'locate.mjs'));

// ── 断言小工具（与 chat-core.test.mjs 同款）──
let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) passed++;
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (got, exp, name) => ok(got === exp, name, { got, exp });
const near = (got, exp, tol, name) => ok(Math.abs(got - exp) <= tol, name, { got, exp, tol });
const truthy = (v, name) => ok(!!v, name, { got: v });

// ── 固定夹具：两个簇，方便测"定位到某个簇"──
const ART = [{ id: 12, t: '异步架构', g: ['Rust'], c: '后端' }, { id: 14, t: '嵌入式笔记', g: ['IoT'], c: '硬件' }];
const mk = (i, w, x, y, z, n, a = 0) => ({ i, w, x, y, z, n, a, a2: a });
const NODES = [
    mk(0, '异步', 1.00, 0.05, 0.10, 1.00),
    mk(1, '并发', 0.85, 0.30, -0.10, 0.80),
    mk(2, '线程', 1.10, -0.25, 0.20, 0.70),
    mk(3, '协程', 0.75, -0.05, -0.30, 0.60),
    mk(4, 'rust', -1.00, 0.55, 0.30, 0.90, 1),
    mk(5, 'axum', -1.20, 0.75, 0.10, 0.65, 1),
    mk(6, 'tokio', -0.85, 0.40, 0.50, 0.55, 1),
];
const GRAPH = {
    v: 'test', model: 'x', dim: 3, built: '2026-09-15',
    articles: ART, nodes: NODES, edges: [[0, 1, 0.8], [1, 2, 0.6], [4, 5, 0.7]],
    stats: {},
};

const CAM0 = { yaw: 0, pitch: 0, dist: 5, target: [0, 0, 0] };

// ══════════════════════════════════════════════ 投影
console.log('== projectNodes ==');
{
    const p = new engine.Projection(1);
    engine.projectNodes([mk(0, '原点', 0, 0, 0, 1)], CAM0, 800, 600, p);
    near(p.x[0], 400, 1e-4, '原点投影到画布中心 x');
    near(p.y[0], 300, 1e-4, '原点投影到画布中心 y');
    near(p.d[0], 5, 1e-6, '原点深度 = dist');
}
{
    const p = new engine.Projection(3);
    const probe = [mk(0, 'x', 1, 0, 0, 1), mk(1, 'y', 0, 1, 0, 1), mk(2, 'z', 0, 0, 1, 1)];
    engine.projectNodes(probe, CAM0, 800, 600, p);
    ok(p.x[0] > 400, '世界 +x → 屏幕右侧', { x: p.x[0] });
    ok(p.y[1] < 300, '世界 +y → 屏幕上方', { y: p.y[1] });
    ok(p.d[2] < 5, '世界 +z（朝相机）→ 更近', { d: p.d[2] });
    ok(p.r[2] > p.r[0], '更近的点屏幕半径更大（透视缩放）', { near: p.r[2], far: p.r[0] });
}
{
    // yaw=π/2：相机绕到 +x 侧，世界 +x 的点应当变成"正对中心且最近"
    const p = new engine.Projection(1);
    engine.projectNodes([mk(0, 'x', 1, 0, 0, 1)], { ...CAM0, yaw: Math.PI / 2 }, 800, 600, p);
    near(p.x[0], 400, 1e-3, 'yaw 90° → 世界 +x 落回画面中心');
    near(p.d[0], 4, 1e-6, 'yaw 90° → 世界 +x 距离 4');
}
{
    // 近裁剪：点跑到相机背后（eye 在 z=5，点在 z=7）
    const p = new engine.Projection(1);
    engine.projectNodes([mk(0, 'behind', 0, 0, 7, 1)], CAM0, 800, 600, p);
    ok(p.d[0] < 0, '背后点深度为负', { d: p.d[0] });
    eq(p.r[0], 0, '背后点半径归零');
    ok(p.x[0] < -1e5, '背后点坐标被踢出屏幕', { x: p.x[0] });
}
{
    // 点半径的夹取带（20260916b 用户：「明明在外面看得见的向量点，视角飞进去反而变小
    // 看不见了」）。探针放在世界 -z 上 ⇒ depth = dist + 1，ratio = dist/(dist+1)：
    //   团外 dist=5   → 5/6 = 0.833（未触带，逐像素与改动前一致）
    //   团内 dist=0.4 → 0.4/1.4 = 0.286 → 必须被抬到下限 0.62
    const probe = [mk(0, 'far', 0, 0, -1, 1)];
    const proj = (dist) => {
        const p = new engine.Projection(1);
        engine.projectNodes(probe, { ...CAM0, dist }, 800, 600, p);
        return p.r[0];
    };
    const BASE = 1.7 + 3.1;                       // n=1 时的基础半径
    near(proj(5), BASE * (5 / 6), 1e-4, '团外（dist=5）不触夹取带：仍按 dist/depth');
    ok(proj(0.4) >= BASE * 0.62 - 1e-6,
        '飞进团里（dist=0.4）远处点半径守住下限 0.62（不夹的话 0.286 ⇒ 4.8px 缩成 1.4px）',
        { r: proj(0.4), 未夹: BASE * (0.4 / 1.4) });
    // 上限：贴到相机上的点（depth≈0.06）ratio 会到 6.7，必须夹到 1.4 而不是画成大色块
    const pn = new engine.Projection(1);
    engine.projectNodes([mk(0, 'face', 0, 0, 0.34, 1)], { ...CAM0, dist: 0.4 }, 800, 600, pn);
    ok(pn.r[0] <= BASE * 1.4 + 1e-6, '贴脸点的半径有上限', { r: pn.r[0] });
}

// ══════════════════════════════════════════════ 命中
console.log('== pickNode ==');
{
    const p = new engine.Projection(NODES.length);
    engine.projectNodes(NODES, CAM0, 800, 600, p);
    const c = engine.pickNode(p, p.x[0], p.y[0]);
    eq(c, 0, '点在落点上 → 命中该点');
    eq(engine.pickNode(p, p.x[0] + 400, p.y[0]), null, '偏出 400px → 不命中');
    // 重叠：让一个点与另一个点屏幕位置重合但更近
    const two = [mk(0, 'far', 0, 0, -1, 1), mk(1, 'near', 0, 0, 1, 1)];
    const p2 = new engine.Projection(2);
    engine.projectNodes(two, CAM0, 800, 600, p2);
    near(p2.x[0], p2.x[1], 1e-4, '夹具：两点屏幕位置重合');
    eq(engine.pickNode(p2, 400, 300), 1, '重叠时命中离相机更近的那个');
}

// ══════════════════════════════════════════════ 本地关键词兜底
console.log('== locateLocal ==');
{
    const hit = locate.locateLocal('异步编程', GRAPH);
    truthy(hit.length, '有命中');
    eq(hit[0].w, '异步', '「异步编程」→ 最长匹配到「异步」（不是「步编」）');
}
{
    const hit = locate.locateLocal('rust 的并发模型', GRAPH);
    const ws = hit.map((h) => h.w);
    truthy(ws.includes('rust'), '跨中英混合：命中 rust', ws);
    truthy(ws.includes('并发'), '跨中英混合：命中 并发', ws);
}
{
    const hit = locate.locateLocal('axum', GRAPH);
    eq(hit[0].w, 'axum', 'ASCII 整词精确命中');
}
{
    const hit = locate.locateLocal('axumx', GRAPH);   // 前缀兜底
    ok(hit.some((h) => h.w === 'axum'), 'ASCII 前缀容错命中 axum', hit);
}
{
    // 零命中必须仍有落点（bigram 兜底），不能按了回车什么都没有
    const hit = locate.locateLocal('协程调度器', GRAPH);
    truthy(hit.length, '即使精确词全不中，bigram 兜底也有落点');
    eq(locate.locateLocal('', GRAPH).length, 0, '空串 → 空结果（不瞎猜）');
}

// ══════════════════════════════════════════════ 缩放区间
console.log('== zoomBy ==');
{
    // 20260915 用户报「图谱放大范围太小，还没放大多数就到极限了」。点云半径实测
    // max 1.11 / p90 0.86（333 词产物）：旧 DIST_MIN=1.7 连最外层点都够不到，
    // 相机永远在球外——判据就是"放大到底必须能进到点云内部"。
    const MIN = 0.4;
    near(engine.zoomBy(4.3, -1e6), MIN, 1e-9, '一直放大到底 = 0.4（旧值 1.7）');
    ok(engine.zoomBy(4.3, -1e6) < 1.11, '放大到底能进到点云内部（< 实测 max 半径 1.11）');
    near(engine.zoomBy(4.3, 1e6), 9, 1e-9, '一直缩小到顶 = 9（上限没动）');
    ok(engine.zoomBy(4.3, -100) < 4.3, '滚轮上滚一格 = 拉近');
    ok(engine.zoomBy(4.3, 100) > 4.3, '滚轮下滚一格 = 拉远');
    ok(engine.zoomBy(MIN, -100) === MIN, '已到最近端再滚不动（不会越界成负数）');
    ok(engine.zoomBy(9, 100) === 9, '已到最远端再滚不动');
    // 手感：从默认机位推到最近端不超过 20 格（Chrome 一格 wheel = deltaY 100）——
    // 区间放宽后步长也得跟上，否则"范围是够了但要滚半天"
    let d = 4.3, n = 0;
    while (d > MIN + 1e-9 && n < 200) { d = engine.zoomBy(d, -100); n++; }
    ok(n <= 20, `从默认 4.3 推到最近端 ${n} 格（≤20 才不累手）`, { n, end: d });
    // 乘性步长必须精确可逆：拉近再拉远要回到原距离（否则来回滚会漂）
    near(engine.zoomBy(engine.zoomBy(4.3, -400), 400), 4.3, 1e-9, '拉近再拉远精确回到原距离');
}

// ══════════════════════════════════════════════ 穿云（滚轮到底之后继续前进）
console.log('== dollyBy / wheelStep ==');
{
    // 20260915 用户报「滚轮不能穿出向量空间，深处向量要旋转视角才看得到」：
    // 只缩 dist 的话相机永远绕着锚点 0.4 打转，团中央的词只能转到正面才看得见。
    // 判据：dist 到底之后继续上滚 → dist 不变、沿视线前进；下滚先退回锚点。
    const MIN = 0.4;
    ok(engine.dollyBy(-100) > 0, '上滚一格 = 前进（正位移）');
    ok(engine.dollyBy(100) < 0, '下滚一格 = 后退（负位移）');
    near(engine.dollyBy(-100), -engine.dollyBy(100), 1e-12, '前进/后退一格等长（精确可逆）');
    const per = engine.dollyBy(-100);
    ok(per > 0.1 && per < 0.3, `一格位移 ${per.toFixed(3)} 落在手感区间 (0.1, 0.3)`, { per });
    // 穿过整团（直径 ≈2×1.11）要几格：太多说明"进去了出不来"，太少会一步穿爆
    const across = (2 * 1.11) / per;
    ok(across >= 8 && across <= 20, `穿过整团约 ${across.toFixed(1)} 格（8~20 格）`, { across });

    const r1 = engine.wheelStep(MIN, 0, -100);
    eq(r1.dist, MIN, '到底后继续上滚：dist 不再变小');
    ok(r1.advance > 0, '到底后继续上滚：改为沿视线前进', r1);
    const r1b = engine.wheelStep(MIN, 0.5, -100);
    eq(r1b.dist, MIN, '已在团里再上滚：dist 保持');
    ok(r1b.advance > 0, '已在团里再上滚：继续前进');

    const r2 = engine.wheelStep(MIN, 0.5, 100);
    eq(r2.dist, MIN, '有位移时下滚：先退位移，dist 不动');
    near(r2.advance, -Math.min(per, 0.5), 1e-12, '下滚退回量 = min(一格, 剩余位移)');
    const r2b = engine.wheelStep(MIN, 0.05, 100);
    near(r2b.advance, -0.05, 1e-12, '剩余位移不足一格 → 一次退干净（不会退过头变成负位移）');
    eq(r2b.dist, MIN, '退干净这步仍然不动 dist');

    const r3 = engine.wheelStep(MIN, 0, 100);
    ok(r3.advance === 0, '没有位移时下滚：回到普通缩放，不产生位移');
    ok(r3.dist > MIN, '没有位移时下滚：dist 变大（退出团）', r3);
    const r4 = engine.wheelStep(4.3, 0, -100);
    eq(r4.advance, 0, '还没到底时上滚：只是缩放，不穿云');
    ok(r4.dist < 4.3, '还没到底时上滚：dist 变小');

    // 从默认机位一路滚到底再继续滚：应先在 15 格左右把 dist 压到 MIN，之后才开始穿云
    let d = 4.3, n = 0, adv = 0;
    while (n < 60) {
        const r = engine.wheelStep(d, adv, -100);
        d = r.dist; adv += r.advance; n++;
        if (adv > 2.3) break;                       // 穿过整团
    }
    ok(adv > 2.22, `从默认机位滚 ${n} 格可穿过整团（位移 ${adv.toFixed(2)} > 直径 2.22）`, { n, adv });
    ok(n <= 34, `穿团总格数 ${n} ≤ 34（别让人滚到手酸）`, { n });
}

// ══════════════════════════════════════════════ 取景
console.log('== cameraFor ==');
{
    eq(engine.cameraFor(GRAPH, [], CAM0), CAM0, '无命中 → 相机原样不动（同一对象引用）');
}
{
    const hits = [{ w: '异步', s: 1 }, { w: '并发', s: 0.8 }, { w: '线程', s: 0.7 }, { w: '协程', s: 0.6 }];
    const cam = engine.cameraFor(GRAPH, hits, CAM0);
    let sw = 0, cx = 0, cy = 0, cz = 0;
    for (const h of hits) {
        const n = NODES.find((x) => x.w === h.w);
        sw += h.s; cx += n.x * h.s; cy += n.y * h.s; cz += n.z * h.s;
    }
    near(cam.target[0], cx / sw, 1e-6, 'target = 加权质心 x');
    near(cam.target[1], cy / sw, 1e-6, 'target = 加权质心 y');
    near(cam.target[2], cz / sw, 1e-6, 'target = 加权质心 z');
    eq(cam.yaw, CAM0.yaw, '朝向不变（只推进去，不绕着转）');
    eq(cam.pitch, CAM0.pitch, '俯仰不变');
    ok(cam.dist >= 0.8 - 1e-9 && cam.dist <= 9, 'dist 落在滚轮可达区间', { dist: cam.dist });

    // ★ 硬要求：全部命中点都必须落在画面内，否则"定位"就是把人带到看不见的地方
    const p = new engine.Projection(NODES.length);
    engine.projectNodes(NODES, cam, 620, 460, p);
    const inside = hits.map((h) => {
        const i = NODES.findIndex((x) => x.w === h.w);
        return { w: h.w, x: p.x[i], y: p.y[i], in: p.x[i] >= 0 && p.x[i] <= 620 && p.y[i] >= 0 && p.y[i] <= 460 };
    });
    ok(inside.every((v) => v.in), '全部命中点都在视锥内', inside);
}
{
    // 大簇：走比例分支（不被 LOCATE_DIST_MIN 夹住）时也必须框得住
    const wide = [
        mk(0, 'a', 0, 0, 0, 1), mk(1, 'b', 2.4, 0, 0, 1),
        mk(2, 'c', 0, 2.4, 0, 1), mk(3, 'd', 0, 0, 2.4, 1),
    ];
    const g2 = { ...GRAPH, nodes: wide };
    const hits = wide.map((n) => ({ w: n.w, s: 1 }));
    const cam = engine.cameraFor(g2, hits, CAM0);
    ok(cam.dist < 9, '大簇没被顶到最远距离', { dist: cam.dist });
    const p = new engine.Projection(4);
    engine.projectNodes(wide, cam, 620, 460, p);
    const out = wide.filter((_, i) => !(p.x[i] >= 0 && p.x[i] <= 620 && p.y[i] >= 0 && p.y[i] <= 460))
        .map((n) => n.w);
    eq(out.length, 0, '大簇的全部命中点也在视锥内（取景系数够大）', out);
}

console.log('== 大小写：索引原形(小写) vs 节点显示形（20260916 修的 chip 不定位）==');
{
    // 真因：agent 侧索引 index.json 的 words 是**小写原形**（build_word_graph.py:644），
    // 前端产物节点是**显示形**（Python/JWT/MQTT…），实跑 341 词里 44 个只差大小写。
    // 修前 setHighlight / cameraFor / 组件 findIndex 三处都用精确匹配 → 向量路返回的小写词
    // 被静默丢弃：不飞（cameraFor 查不到 → 原样返回）、不亮（hits 空）、不选中（findIndex −1）
    // = 用户看到的"chip 点了没反应"；而本地兜底路 locate.ts 的 keyOf 本来就大小写不敏感，
    // 于是出现"检索服务可用时反而不如降级准"的怪相。
    const mixed = [mk(0, 'Python', 1, 0, 0, 1), mk(1, 'JWT', -1, 0, 0, 1), mk(2, '异步', 0, 1, 0, 1)];
    const g = { ...GRAPH, nodes: mixed, edges: [] };

    eq(engine.wordKey('Python'), 'python', 'wordKey：ASCII 折小写');
    eq(engine.wordKey('Python'), engine.wordKey('python'), '显示形与索引原形同键');
    eq(engine.wordKey('异步'), '异步', '非 ASCII 原样（中文无大小写）');

    // 取景：小写查询必须落到显示形节点上
    const cam = engine.cameraFor(g, [{ w: 'python', s: 1 }], CAM0);
    ok(cam !== CAM0, '小写 python 有命中 → 不是"无命中原样返回"');
    near(cam.target[0], mixed[0].x, 1e-6, 'target x = Python 节点位置');
    near(cam.target[1], mixed[0].y, 1e-6, 'target y = Python 节点位置');
    near(cam.target[2], mixed[0].z, 1e-6, 'target z = Python 节点位置');
    const p = new engine.Projection(3);
    engine.projectNodes(mixed, cam, 620, 460, p);
    ok(p.x[0] >= 0 && p.x[0] <= 620 && p.y[0] >= 0 && p.y[0] <= 460, 'Python 落在视锥内（飞过去看得见）');

    eq(engine.cameraFor(g, [{ w: 'c++', s: 1 }], CAM0), CAM0, '真不存在的词仍原样不动（没放宽成模糊匹配）');
    // 多命中里混一个不存在的词：存在的那个照样算进质心
    const cam2 = engine.cameraFor(g, [{ w: 'jwt', s: 1 }, { w: 'c++', s: 1 }], CAM0);
    near(cam2.target[0], mixed[1].x, 1e-6, '混入未命中的词：仍定位到 JWT（不做平均拉偏）');

    // 本地兜底路（locate.ts 的 keyOf 已改为 import wordKey）与向量路同判：
    // 同一批小写查询词，两条路都必须命中显示形节点——这才是"两路一致"。
    const ws = locate.locateLocal('python', g).map((h) => h.w);
    truthy(ws.includes('Python'), "降级路也算命中 Python（两路同一 wordKey）", ws);
    const ws2 = locate.locateLocal('jwt token', g).map((h) => h.w);
    truthy(ws2.includes('JWT'), '降级路：小写 jwt 命中 JWT', ws2);
}

console.log(`\n${failed === 0 ? '✓' : '✗'} wordgraph-engine: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

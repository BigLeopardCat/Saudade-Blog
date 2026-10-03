// ═ 图谱产物质量门（前端侧）══
//   node tests/wordgraph-artifact.test.mjs
// 建图脚本自己有一道质量门（fidelity / len_sim_rho / 节点数），这里是从**产物**
// 反着再验一遍：契约（manifest → 带 hash 的文件名 → export default）、几何合法性、
// 图的连通性、以及那条最容易静默失效的 nginx immutable 文件名规则。
import { readFileSync, statSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const GRAPH_DIR = path.resolve(here, '../public/graph');

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) passed++;
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (got, exp, name) => ok(got === exp, name, { got, exp });
const truthy = (v, name) => ok(!!v, name, { got: v });

// 产物文件的缓存头**两条路各归各的**（20261003 起产物改由 API 供出）：
//   ① 仓库里 committed 的种子（public/graph/ → dist/graph/）：由 nginx 决定 ——
//      它只对形如 -<8位以上hash>.<白名单扩展名> 的文件给 1 年 immutable，白名单里有
//      js、没有 json。文件名一旦不合规就会掉进 no-store 每次刷新全量重下 ——
//      性能事故，但页面看起来完全正常（这就是它值得被断言的原因）。
//   ② 后台重建的产物（agent 的 data/word_graph/web/）：由 Rust 的
//      `/api/public/graph/artifact/:file` 供出，Content-Type / Cache-Control 全在
//      `src/routes/graph.rs` 里 —— nginx 那两个 443 块的 `^~ /api/` 前缀 location
//      跳过所有正则 location，`\.(js|css|json)$` 那条抢不走。
// 两边**同一条文件名形状**：前端 loader.ts 的动态 import 与 Rust 的白名单校验共用它。
const FILE_RE = /^graph-[A-Za-z0-9_-]{8,}\.js$/;
/** 建图脚本把坐标缩放到 98 分位后 clip 到 ±WORLD_R。前端相机参数按这个尺度定死 */
const WORLD_R = 1.6;

console.log('== manifest ==');
if (!existsSync(path.join(GRAPH_DIR, 'manifest.json'))) {
    console.log('  ✗ 找不到 public/graph/manifest.json——先跑 scripts/build_word_graph.py');
    process.exit(1);
}
const m = JSON.parse(readFileSync(path.join(GRAPH_DIR, 'manifest.json'), 'utf8'));
truthy(FILE_RE.test(m.file), `manifest.file 符合 nginx immutable 命名规则`, m.file);
eq(m.file, `graph-${m.v}.js`, 'manifest.file 与 v 一致（graph-<v>.js）');
const filePath = path.join(GRAPH_DIR, m.file);
truthy(existsSync(filePath), 'manifest 指向的产物文件存在', m.file);
eq(statSync(filePath).size, m.bytes, 'manifest.bytes 与实际文件大小一致');

console.log('== 产物结构 ==');
const mod = await import(pathToFileURL(filePath).href);
const g = mod.default;
truthy(g && typeof g === 'object', 'export default 出对象');
for (const k of ['articles', 'nodes', 'edges', 'stats']) truthy(g?.[k] !== undefined, `有 ${k} 字段`);
if (!g?.nodes?.length) { console.log('  ✗ 产物没有节点'); process.exit(1); }

const { nodes, edges, articles, stats } = g;
console.log(`   节点 ${nodes.length} / 边 ${edges.length} / 文章 ${articles.length} / ${statSync(filePath).size} 字节`);

ok(nodes.length >= 150 && nodes.length <= 600, '节点数在 150~600', nodes.length);
truthy(articles.length >= 2, '至少 2 篇文章（不然着色没有意义）', articles.length);

console.log('== 节点 ==');
{
    const seen = new Set();
    const dupes = [];
    let badCoord = null, badN = null, badArt = null, badIdx = null;
    nodes.forEach((n, i) => {
        if (n.i !== i) badIdx = { at: i, i: n.i };
        if (!n.w || typeof n.w !== 'string') badCoord = { at: i, w: n.w };
        if (seen.has(n.w)) dupes.push(n.w);
        seen.add(n.w);
        if (![n.x, n.y, n.z].every((v) => typeof v === 'number' && Number.isFinite(v))) badCoord = { at: i, n };
        if (Math.abs(n.x) > WORLD_R || Math.abs(n.y) > WORLD_R || Math.abs(n.z) > WORLD_R) badCoord = { at: i, n };
        if (!(n.n >= 0 && n.n <= 1)) badN = { at: i, n: n.n };
        if (!(n.a >= 0 && n.a < articles.length)) badArt = { at: i, a: n.a };
        if (!(n.a2 >= 0 && n.a2 < articles.length)) badArt = { at: i, a2: n.a2 };
    });
    eq(dupes.length, 0, '词不重复', dupes.slice(0, 5));
    eq(badIdx, null, 'n.i 与数组下标一致', badIdx);
    eq(badCoord, null, `坐标有限且落在 ±${WORLD_R} 内`, badCoord);
    eq(badN, null, '重要度归一化在 0~1', badN);
    eq(badArt, null, 'a / a2 指向存在的文章', badArt);
}

console.log('== 边 ==');
{
    const pair = new Set();
    const deg = new Array(nodes.length).fill(0);
    let selfLoop = null, dup = null, badIdx = null, badSim = null;
    for (const e of edges) {
        const [a, b, s] = e;
        if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0 && a < nodes.length && b < nodes.length)) { badIdx = e; continue; }
        if (a === b) selfLoop = e;
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (pair.has(key)) dup = e;
        pair.add(key);
        deg[a]++; deg[b]++;
        if (!(s > 0 && s <= 1)) badSim = e;
    }
    eq(badIdx, null, '边下标不越界', badIdx);
    eq(selfLoop, null, '无自环', selfLoop);
    eq(dup, null, '无重边', dup);
    eq(badSim, null, '余弦相似度落在 (0,1]', badSim);
    const isolated = deg.map((d, i) => (d === 0 ? nodes[i].w : null)).filter(Boolean);
    eq(isolated.length, 0, '无孤立点（建图脚本会为它补一条最近邻边）', isolated.slice(0, 8));
    ok(Math.max(...deg) <= 12, '单点度数没有离谱的 hub', Math.max(...deg));
}

console.log('== 质量指标 ==');
{
    const fid = stats.fidelity, rho = stats.len_sim_rho;
    truthy(typeof fid === 'number', 'stats.fidelity 存在', stats);
    truthy(typeof rho === 'number', 'stats.len_sim_rho 存在', stats);
    // 主门 = **保真度**：视图里的近邻是否还是 1024 维处理空间里的近邻。这是访客
    // 实际感受到的东西（点一个词、它周围的词相不相关）。随机基线 10/(n-1)≈0.025，
    // 20260917 的离线 A/B（scripts/layout_ab.py）实测：UMAP 0.433 / PCA+弹簧 0.255 /
    // Isomap 0.18~0.21 / SMACOF（只优化边集）0.027≈随机。
    ok(fid >= 0.30, '近邻保真度 ≥ 0.30（UMAP 布局实测 0.43）', fid);
    if (stats.fidelity_k) {
        // 多 k 曲线：k 从 5 到 20 不该塌（塌了说明只有最近的一圈被保住）
        for (const k of ['k5', 'k10', 'k20']) {
            ok(stats.fidelity_k[k] >= 0.25, `保真度曲线 ${k} ≥ 0.25`, stats.fidelity_k);
        }
    }
    // ⚠️ 符号约定：rho = spearman(线长, 相似度)，"越相似线越短" ⇒ 负值才正确。
    //    写成正数说明线长方向反了——那比"线长不带信息"更糟（在说谎）。
    //    **但它不是质量门**：它只覆盖边集（占全部点对的约 1%），SMACOF 单独优化这些边
    //    就能做到 −1.000 而保真度塌到随机——可被游戏，且方向与"附近是否相关"相反。
    //    这里只留一条符号 sanity（防方向写反）。
    ok(rho < 0, '线长-相似度秩相关为负（方向没写反；数值仅供展示参考，不是门）', rho);
    ok(['umap', 'semantic', 'pca'].includes(stats.layout), '记录了布局算法', stats.layout);
    truthy(g.built, '记录了构建时间', g.built);
    truthy(g.model && g.dim > 0, '记录了 embedding 模型与维度', { model: g.model, dim: g.dim });
    ok(stats.n_nodes === nodes.length, 'stats.n_nodes 与实际节点数一致', { stats: stats.n_nodes, real: nodes.length });
}

// ── 后台重建的产物（存在才验）────────────────────────────────────────────
// 上面那一整段验的是**仓库里 committed 的种子**：从没重建过的站点走的就是它。
// 重建过的站点走另一份（agent 的 data/word_graph/web/，由 Rust 供出）——那份不在
// 版本控制里、本机也不一定有（没重建过就整个目录不存在），所以整段按"存在才验"。
// ⚠️ CI 上永远不存在（agent 是另一个仓库、这个目录也 gitignore）⇒ 这一段只在
// 生产机上跑得到，它守的是"这台机器当前供出去的那份产物"。
const AGENT_WEB = process.env.GRAPH_ARTIFACT_DIR
    || path.resolve(here, '../../saudade-blog-agent/data/word_graph/web');
const prodManifestPath = path.join(AGENT_WEB, 'manifest.json');
console.log('== 生产产物（后台重建）==');
if (!existsSync(prodManifestPath)) {
    console.log(`  · 跳过：${AGENT_WEB} 下没有 manifest.json（这台机器还没在后台重建过）`);
} else {
    const pm = JSON.parse(readFileSync(prodManifestPath, 'utf8'));
    truthy(FILE_RE.test(pm.file), '生产 manifest.file 符合同一条命名规则', pm.file);
    truthy(FILE_RE.test(`graph-${pm.v}.js`) && pm.file === `graph-${pm.v}.js`,
        '生产 manifest.file 与 v 一致（graph-<v>.js）', pm);
    // 归属站点是这个文件存在的全部意义：重建任务把它当参数收下来（页面传浏览器的 origin），
    // 没有它前端就永远判"不是本站"⇒ 展品显示"尚未为本站点生成"。
    truthy(typeof pm.site === 'string' && pm.site.trim() !== '',
        '生产 manifest 写了 site（否则首页永远认不出这是本站的图）', pm);
    const pPath = path.join(AGENT_WEB, pm.file);
    if (existsSync(pPath)) {
        eq(statSync(pPath).size, pm.bytes, '生产 manifest.bytes 与实际文件大小一致');
        // ⚠️ **不能直接 import 这个路径**：Node 按**最近的 package.json** 决定 `.js` 是不是
        //    ESM，而 `saudade-blog-agent/` 下没有 package.json（种子那份能直接 import，
        //    只是因为 `frontend/package.json` 里写了 `"type": "module"`）——直接 import 会
        //    按 CommonJS 解析，`export default` 当场语法错，**整段崩在断言之前**：本机实测
        //    连一行 FAIL 都打不出来，进程带栈退出（CI 上这段恒跳过，所以只有生产机上看得见）。
        //    但"它必须是合法的 ES module"这条本身要验（浏览器里 `loader.ts` 就是
        //    `await import(url)` 拿它的）⇒ 复制成 `.mjs` 再 import：既真验了 ESM 可解析性，
        //    又不被周边 package.json 左右。
        const tmp = mkdtempSync(path.join(tmpdir(), 'wg-prod-'));
        const tmpFile = path.join(tmp, 'prod.mjs');
        writeFileSync(tmpFile, readFileSync(pPath));
        let pg;
        try {
            pg = (await import(pathToFileURL(tmpFile).href)).default;
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
        ok(Array.isArray(pg?.nodes) && pg.nodes.length > 0, '生产产物有节点', pg?.nodes?.length);
        // 热度是"按文章热度画大小"的**唯一数据来源**：没有 h 就只能退回 tf-idf 重要度，
        // 用户要的那个效果就不存在（而这种缺失在页面上看不出来——图照画，只是大小没意义）。
        ok(typeof pg?.nodes?.[0]?.h === 'number', '生产产物带热度字段 h（否则大小退回 tf-idf 重要度）',
            pg?.nodes?.[0]);
        console.log(`   生产产物 ${pm.file}（${pm.bytes} 字节，site=${pm.site}）`);
    } else {
        ok(false, '生产 manifest 指向的产物文件存在', pm.file);
    }
}

console.log(`\n${failed === 0 ? '✓' : '✗'} wordgraph-artifact: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

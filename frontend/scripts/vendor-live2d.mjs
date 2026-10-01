// ═ 看板娘运行时的第三方产物就位（20261001 开源前准备）══
//
//   node frontend/scripts/vendor-live2d.mjs        （或 npm run vendor:live2d）
//   CI 在 `npm ci` 之后、`vite build` 之前自动跑一次（deploy.yml）。
//
// 为什么需要这一步：看板娘渲染层要用三份**不能进 git 的二进制/构建产物**——
// 两份是体积（进仓库等于每次 clone 拖 576KB，且与 node_modules 重复），
// 一份是许可（Live2D 专有运行时，进了仓库就等于被本仓的 GPL-2.0 声称覆盖）。
// 三者都落到 `frontend/public/live2d-widgets/vendor/` 与 `public/cubism5/`，
// 这两个位置本身被 .gitignore 排除（见仓根 .gitignore 的说明块）。
//
//   ① pixi.min.js        ← node_modules/pixi.js（MIT）
//   ② cubism4.min.js     ← node_modules/pixi-live2d-display（MIT 包；注意它内联了
//                          Live2D 的 Cubism Web Framework，所以同样不进 git）
//   ③ live2dcubismcore.min.js ← 官方 CDN（Live2D 专有许可，非本仓协议覆盖范围）
//
// ③ 是从**官方地址**取的，不是本仓的副本 —— 这就是"移出仓库 + 文档指引"的落地形态。
// 取回来后按 sha256 逐字节校验：官方哪天换版本，这里会**响亮地红**，而不是悄没声地
// 把一个新版本的渲染核心塞进生产（Cubism Core 换版本的差异不会报错，只会画得不一样）。
//
// 只想校验、不想下载：`node frontend/scripts/vendor-live2d.mjs --check`
// （CI 的 dry 校验用；文件缺失或哈希不符即退出码 1）。
import { createHash } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, '..');
const PUBLIC = path.join(FRONTEND, 'public');
const VENDOR = path.join(PUBLIC, 'live2d-widgets', 'vendor');
const CUBISM_DIR = path.join(PUBLIC, 'cubism5');

const CHECK_ONLY = process.argv.includes('--check');

// ── ① ② node_modules 里现成的两份 UMD ────────────────────────────────────────
// 必须是 UMD/IIFE 形态（挂 window.PIXI / window.PIXI.live2d），这样 boot.js 能用
// 普通 <script> 加载它们——看板娘那批文件是不经打包的，没有 bundler 可用。
const VENDORED = [
  ['pixi.js', 'dist/pixi.min.js', 'pixi.min.js', 'MIT'],
  ['pixi-live2d-display', 'dist/cubism4.min.js', 'cubism4.min.js', 'MIT'],
];

// ── ③ Cubism Core：官方地址 + 钉死的哈希 ─────────────────────────────────────
// 官方页面上这份是"最新版"（无版本化 URL）⇒ 哈希是唯一的版本锚点。
// 换版本的正确姿势：确认新核心能渲染 agent_2（跑 tests/live2d-render.test.py），
// 再更新这两行常量——**不要**为了让它变绿而删掉校验。
const CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';
const CORE_SHA = '25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f';
const CORE_NAME = 'live2dcubismcore.min.js';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const kb = (n) => (n / 1024).toFixed(1) + 'KB';

let failed = 0;
const bad = (msg) => { console.error('  ✗ ' + msg); failed++; };

// ── 拷贝 node_modules 里的两份 ───────────────────────────────────────────────
mkdirSync(VENDOR, { recursive: true });
for (const [pkg, from, to, license] of VENDORED) {
  const src = path.join(FRONTEND, 'node_modules', pkg, from);
  const dst = path.join(VENDOR, to);
  if (!existsSync(src)) {
    bad(`缺 ${pkg}/${from} —— 先跑 npm ci（${to} 是它的一份拷贝，不跟踪进 git）`);
    continue;
  }
  if (CHECK_ONLY) {
    const ok = existsSync(dst) && sha256(readFileSync(dst)) === sha256(readFileSync(src));
    console.log(`  ${ok ? '✅' : '❌'} ${to.padEnd(20)} ${kb(statSync(src).size).padStart(9)}  ${license}` +
      (ok ? '' : '  ← 与 node_modules 不一致，跑 npm run vendor:live2d'));
    if (!ok) failed++;
    continue;
  }
  copyFileSync(src, dst);
  console.log(`  ✅ ${to.padEnd(20)} ${kb(statSync(dst).size).padStart(9)}  ${license}`);
}

// ── Cubism Core：先看本地的，再决定要不要下载 ────────────────────────────────
mkdirSync(CUBISM_DIR, { recursive: true });
const corePath = path.join(CUBISM_DIR, CORE_NAME);
const coreNow = existsSync(corePath) ? sha256(readFileSync(corePath)) : null;

if (coreNow === CORE_SHA) {
  console.log(`  ✅ ${CORE_NAME.padEnd(20)} ${kb(statSync(corePath).size).padStart(9)}  Live2D 专有（本地已就位，哈希相符）`);
} else if (CHECK_ONLY) {
  bad(`${CORE_NAME} ${coreNow ? '哈希不符（本地 ' + coreNow.slice(0, 16) + '…）' : '不存在'} —— 跑 npm run vendor:live2d`);
} else {
  if (coreNow) console.warn(`  ⚠ ${CORE_NAME} 本地哈希不符，从官方地址重取`);
  process.stdout.write(`  ↓ 取 ${CORE_URL}\n`);
  let buf = null;
  try {
    const resp = await fetch(CORE_URL);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    buf = Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    bad(`取不到 Cubism Core：${e.message}（离线环境请手动放到 ${path.relative(FRONTEND, corePath)}）`);
  }
  if (buf) {
    const got = sha256(buf);
    if (got !== CORE_SHA) {
      // 这是**故意的硬失败**：官方换了核心版本，必须人来确认新核心还能渲染，
      // 顺带更新上面的 CORE_SHA。静默换版本 = 生产画得不一样且不报错。
      bad(`${CORE_NAME} 官方那份的哈希变了\n` +
          `      期望 ${CORE_SHA}\n      实得 ${got}\n` +
          `      ⇒ 官方发布了新核心。先跑 tests/live2d-render.test.py 确认能渲染，再更新本文件的 CORE_SHA。`);
    } else {
      writeFileSync(corePath, buf);
      console.log(`  ✅ ${CORE_NAME.padEnd(20)} ${kb(buf.length).padStart(9)}  Live2D 专有（官方取回，哈希相符）`);
    }
  }
}

if (failed) {
  console.error(`\n❌ 看板娘运行时产物未就位（${failed} 项）`);
  process.exit(1);
}
console.log('\n✅ 看板娘运行时产物就位' + (CHECK_ONLY ? '（--check 未写盘）' : ''));

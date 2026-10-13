// ═ 默认 import 一个「带 __esModule 的 CJS 包」必须过 cjsDefault ═══════════════
//   node tests/cjs-default-interop.test.mjs
//
// 背景（20261013 真实事故，用户报的）：Vite 8 把打包内核换成 Rolldown 之后，后台
//   `/dashboard/notes/allcategorize` 与 `/dashboard/usercontrol` 整页炸成
//   `Unexpected Application Error! Minified React error #130 … args[]=object`，
//   文章详情页 likewise。根因逐字读得出来——`vendor/rolldown-runtime-*.js` 里那个
//   `__toESM`：节点模式（产物里写成 `X=n(module(),1)`）下 `X.default` 是
//   **整个 `module.exports`**，而不是 `.default` 那个组件。`__esModule` 是
//   `Object.defineProperty` 定义的**不可枚举**属性，所以抛错信息里
//   `Object.keys(type)` 只剩 `["default"]`——这就是这条判据的指纹。
//
// 判据 = 「这个包的**入口**（含子路径入口）里有 `__esModule`」。
//   ⚠️ **别只扫包根**：`@mui/icons-material/Add`、`antd/lib/locale/zh_CN` 这类子路径
//   要按**文件**解析。第一版补丁只按包根的 `module`/`main` 解析，把
//   `@mui/icons-material/Add` 读成了包根的 `esm/index.js`（那里没有 `__esModule`），
//   于是盘点结论是"只有三个包受影响"——**九个图标就是这么漏掉的**。
//
// 为什么这条判据住在一个 **node 静态测试**里、而不是浏览器测试里：
//   `tests/*.test.py` 那一族是 esbuild 打包后挂无头浏览器的（`scripts/nightly_*`），
//   而 **esbuild 的 CJS 互操作是对的**——同一段源码在那边永远是绿的。
//   把断言写进那边 = 假绿。（这条与 `sass-media-shadow` 那族的教训同源：
//   判据要落在**真正会坏的那一层**上。）
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');            // frontend/
const SRC = path.join(ROOT, 'src');
const NM = path.join(ROOT, 'node_modules');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; return; }
  fail++;
  console.log('  ✗ ' + name + (extra ? '\n      ' + extra : ''));
};

// ── 解析：把一个 import specifier 解析到它真正的入口文件 ──────────────────────
// 覆盖：`type: "module"`（纯 ESM，不走互操作）、`exports["."]` 的
// import/module/default/require 四档、`module` / `main`、以及子路径。
const CANDIDATE_EXT = ['', '.js', '.mjs', '.cjs', '/index.js', '/index.mjs', '/index.cjs'];

const splitSpec = (spec) => {
  const parts = spec.split('/');
  return spec.startsWith('@')
    ? [parts.slice(0, 2).join('/'), parts.slice(2).join('/')]
    : [parts[0], parts.slice(1).join('/')];
};

const tryFile = (base) => {
  for (const ext of CANDIDATE_EXT) {
    const q = base + ext;
    if (existsSync(q) && statSync(q).isFile()) return q;
  }
  return null;
};

function resolveEntry(spec) {
  const [pkg, sub] = splitSpec(spec);
  const dir = path.join(NM, pkg);
  if (!existsSync(dir)) return { missing: true };
  if (sub) return { file: tryFile(path.join(dir, sub)) };   // 子路径：按文件解析
  let meta;
  try { meta = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')); }
  catch { return { file: null }; }
  if (meta.type === 'module') return { esm: true };
  const exp = meta.exports;
  if (exp && typeof exp === 'object') {
    const dot = exp['.'];
    if (typeof dot === 'string') return { file: tryFile(path.join(dir, dot)) };
    if (dot && typeof dot === 'object') {
      for (const k of ['import', 'module', 'default', 'require']) {
        if (typeof dot[k] === 'string') return { file: tryFile(path.join(dir, dot[k])) };
      }
    }
  }
  const f = meta.module || meta.main;
  return { file: f ? tryFile(path.join(dir, f)) : null };
}

// 这个 specifier 是不是「带 __esModule 的 CJS」？
function isEsModuleCjs(spec) {
  const r = resolveEntry(spec);
  if (r.missing || r.esm || !r.file) return false;
  return readFileSync(r.file, 'utf8').includes('__esModule');
}

// 扫 src/**，收 `import X from 'pkg'`（含 `import X, {a} from`）的默认 import
const DEFAULT_IMPORT = /^[ \t]*import[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?:,[ \t]*\{[^}]*\}[ \t]*)?from[ \t]*['"]([^'"]+)['"]/gm;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

// ── ① 反面控制：解析器本身有效，别让下面整段变成空转 ─────────────────────────
//   没有这一条，任何"解析不出来 ⇒ 不报"的退化都会让测试**全绿**。
{
  ok(isEsModuleCjs('@mui/icons-material/Add'),
     '正控：@mui/icons-material/Add 判为「带 __esModule 的 CJS」'
     + '（子路径没解析到文件时这里会红）');
  ok(isEsModuleCjs('antd/lib/locale/zh_CN'),
     '正控：antd/lib/locale/zh_CN 判为「带 __esModule 的 CJS」');
  ok(!isEsModuleCjs('dayjs'), '反控：dayjs 不判危（它的 CJS 不带 __esModule，走这条路是对的）');
  ok(!isEsModuleCjs('antd'), '反控：antd 包根不判危（type/module 指到 ESM 那份）');
}

// ── ② 每一个危险的默认 import 都要被 cjsDefault 包住 ─────────────────────────
{
  const guarded = [], offenders = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(DEFAULT_IMPORT)) {
      const [, local, spec] = m;
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@types/')) continue;
      if (!isEsModuleCjs(spec)) continue;
      const used = new RegExp('cjsDefault\\(\\s*' + local.replace(/[$]/g, '\\$') + '\\s*\\)');
      const rec = `${path.relative(ROOT, file)}  ${local} <- '${spec}'`;
      (used.test(text) ? guarded : offenders).push(rec);
    }
  }
  ok(offenders.length === 0,
     `所有「带 __esModule 的 CJS」默认 import 都过了 cjsDefault（${guarded.length} 处）`,
     offenders.length ? '未加守卫：\n      ' + offenders.join('\n      ')
                      : '');
  // 反向：这条测试不能因为"一处都没扫到"而全绿
  ok(guarded.length >= 10,
     `扫到的守卫处数不为空（实测 14 处，>=10 才不算空转）`, `实际 ${guarded.length}`);
}

// ── ③ cjsDefault 三种形态都要兜住（行为级，不是读源码文本） ─────────────────
//   直接把 `src/utils/cjsDefault.ts` 的类型标注摘掉求值——**摘不掉就抛错**，
//   于是"改了签名忘了改这里"会红，不会静默变成没测。
{
  const src = readFileSync(path.join(SRC, 'utils/cjsDefault.ts'), 'utf8');
  let body = src
    .replace(/export function cjsDefault<T>\(mod: T\): T \{/, 'function cjsDefault(mod) {')
    .replace(/const m = mod as unknown as \{ default\?: \{ default\?: unknown \} \}/, 'const m = mod')
    .replace(/\s+as T\b/g, '');
  let cjsDefault = null;
  try { cjsDefault = new Function(body + '\nreturn cjsDefault;')(); } catch (e) { /* 下面报 */ }
  ok(typeof cjsDefault === 'function',
     'cjsDefault 能从源码里求值出来（类型标注摘除失败会在这里红）');

  if (typeof cjsDefault === 'function') {
    const Comp = function Icon() {};
    // ① 实测形态：拿到的是整个 module.exports
    ok(cjsDefault({ __esModule: true, default: Comp }) === Comp,
       '① 名字空间形态 {__esModule, default: Comp} → Comp（本次事故的形态）');
    // ② 文档写的形态
    ok(cjsDefault({ default: Comp }) === Comp, '② {default: Comp} → Comp');
    // ③ 已经是组件本身（/ 将来上游修好之后）
    ok(cjsDefault(Comp) === Comp, '③ 组件本身 → 组件本身（规则修好后不必再改一次）');
    ok(cjsDefault({ __esModule: true, default: { default: Comp } }) === Comp,
       '①x 双层嵌套 {default:{default: Comp}} → Comp');
  }
}

console.log(`\n${fail ? '✗' : '✓'} cjs-default-interop：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

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

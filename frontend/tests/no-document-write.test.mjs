import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const front = path.join(here, '..');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fail++;
  console.log('  ✗ ' + name + (extra ? '\n      ' + extra : ''));
};

/** 剥掉 `//` 行注释与 `/* *\/` 块注释，保留行结构（行号对得上）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** 返回 [相对路径, 行号] —— 命中 `document.write(` 的位置（注释里的不算）。 */
function findDocumentWrite(src, label) {
  const hits = [];
  stripComments(src).split('\n').forEach((line, i) => {
    if (/document\s*\.\s*write\s*\(/.test(line)) hits.push([label, i + 1, line.trim()]);
  });
  return hits;
}

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

// ── ① 全仓零命中 ───────────────────────────────────────────────────────────
// ⚠️ **本文件自己要被排除**：它正文里就写着这个 API 名（正控那行合成了 `document.write(`），
// 不排掉的话这条判据恒红。这与 `run_all.py` 排除自己同源。
const SELF = fileURLToPath(import.meta.url);
const files = [
  ...walk(path.join(front, 'src'), ['.ts', '.tsx']),
  ...walk(path.join(front, 'public'), ['.js']),
  ...walk(path.join(front, 'tests'), ['.mjs']),
].filter((f) => f !== SELF);
const hits = files.flatMap((f) =>
  findDocumentWrite(readFileSync(f, 'utf8'), path.relative(front, f)));

ok(hits.length === 0, '全仓没有 document.write（用 appendChild / createElement 代替）',
  hits.map(([f, l, t]) => `${f}:${l}  ${t}`).join('\n      '));

// ── ② 覆盖率自检 ──────────────────────────────────────────────────────────
// 没有这一条，"零命中"可能只是路径写错了、或者 walk 扫了个空目录——本仓最贵的失效形状。
const changed = path.relative(front, path.join(front, 'src/pages/Dashboard/Notes/NewNotes/index.tsx'));
ok(files.length > 200, `扫描面不为空（现 ${files.length} 个文件）`, `files=${files.length}`);
ok(files.some((f) => path.relative(front, f) === changed),
  `扫描面包含本次改动的那个文件（${changed}）`);

// ── ③ 正控：判据本身能红 ──────────────────────────────────────────────────
const planted = 'const w = window.open(src);\nw.document.write(image.outerHTML);\n';
ok(findDocumentWrite(planted, 'planted').length === 1,
  '正控：合成的一行 document.write 必须被报出来');
ok(findDocumentWrite('// 说明：以前这里用 document.write(html)\n', 'planted').length === 0,
  '反控：注释里提到它不算违规（否则判据会红在一句解释上）');

console.log(`\nno-document-write：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

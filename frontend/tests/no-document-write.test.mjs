// ═ 不许再用 document.write（20261019，安全审计 SAU-021）══
//   node tests/no-document-write.test.mjs
//
// 为什么单独为一条 API 立套件：`document.write(html)` 是**把字符串当 HTML 解析**。
// 后台图片预览那一处（`pages/Dashboard/Notes/NewNotes/index.tsx`）用它把一张图挂进新窗口，
// 当时三重缓解（后台管理员专用页 / 自建 DOM 元素 / outerHTML 会转义引号）使它没有实际
// 注入路径——但那条 API 的形状意味着**任何一次把来源换成不受控的值**就变成注入口，
// 而"新窗口预览"这件事本身用 DOM API 就能做（`appendChild`），代价是零。
// 所以判据不是"这一处改掉了"，是**这条 API 在全仓不许再出现**：下一个要预览点什么的人
// 会照着旁边最近的写法抄，而旁边那行已经没了。
//
// 扫法（同 `agent-cmd-program-only.test.mjs` 的源码锁）：剥注释后逐行找 `document.write(`。
// 剥注释是必需的——`chatMarkdown.ts` 那几处在**注释里**提到过这个 API 名（讲纪律），
// 把它们算成违规等于让判据红在一句解释上。
//
// 三块：① 全仓零命中（含 `public/` 里那些不进打包器的脚本）；② 覆盖率自检（扫到的文件数
// 不为零、且**确实包含**本次改的那个文件——否则"零命中"可能只是扫了个空目录）；
// ③ 正控：把一行合成源码喂给同一个扫描函数，必须报出来（判据坏了要能看见）。
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

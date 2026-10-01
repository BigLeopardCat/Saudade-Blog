// ═ 看板娘前端就位（20261002：agent 前端拆进 agent 仓）══
//
//   node frontend/scripts/fetch-widget.mjs        （或 npm run fetch:widget）
//   CI 在 `npm ci` 之后、`vite build` 之前自动跑一次（deploy.yml）。
//
// 为什么需要这一步：看板娘与对话面板的**源码不住在本仓**了。它搬进了 agent 仓
// （BigLeopardCat/saudade-blog-agent，那边以 MIT 分发），本仓只留
// `frontend/widget.lock.json` 里钉死的那个提交号，构建前按它稀疏检出、落到
// **和以前完全一样的路径**（frontend/public/live2d-widgets/ 与 .../live2d_model/）。
//
// 路径不变是**有意的**：nginx 那两个 1 年 immutable 的 location 块、仓库外的设备控制台、
// 一批按路径读文件的测试、以及 src/routes/chat.rs 的 `include_str!`，全都因此零改动。
//
// ⚠️ 顺序：**必须在 `npm run vendor:live2d` 之前跑**。后者往 live2d-widgets/vendor/ 里写
// 三份第三方产物，而本脚本整树替换 live2d-widgets/ ⇒ 顺序反了的话，刚取到的 vendor/ 会被
// 这次替换抹掉（脚本会保留**已存在**的 vendor/ 兜底，并把这件事打出来，但那是兜底不是契约）。
//
// ⚠️ 这一层是本仓**唯一**的静默失效点：取不到就不会有这两棵树，而 vite 只拷贝 public/ 下
// **真实存在**的文件 ⇒ 打出来的包里没有它们 ⇒ 部署按"本代清单"做集合差时会把线上正在用的
// 那棵树当**旧块删掉**。症状是站点一切正常、只有看板娘一帧不画。所以本脚本任何一步失败都
// **退出码 1**，CI 里 build 之后还有两条 `test -f` 兜底。
//
// ⚠️ 目标树里**不属于 pin** 的文件一律不删：`vendor/` 原样保留，`*.bak`/`*.orig` 就地留着，
// 其余挪去临时区并打印路径。这个脚本只负责把 pin 的那一份放到位，不负责清理你的工作区。
//
// 只校验、不写盘：`node frontend/scripts/fetch-widget.mjs --check`
// 写到别处（冷克隆验证用）：`node frontend/scripts/fetch-widget.mjs --dest /tmp/probe`
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, '..');
const LOCK_PATH = path.join(FRONTEND, 'widget.lock.json');

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const destArg = argv.indexOf('--dest');
const DEST = destArg >= 0 ? path.resolve(argv[destArg + 1] ?? '') : path.join(FRONTEND, 'public');

// 整树替换时**保留**的子目录：它由 `npm run vendor:live2d` 生成，不属于 agent 仓的源码。
const PRESERVE = ['vendor'];

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const kb = (n) => (n / 1024).toFixed(1) + 'KB';

// 本仓 `.gitignore` 把 *.bak / *.orig 当"编辑中途的手工备份"（见那里的注释）。
// 这类文件既不是 pin 的、也不是脚本的 ⇒ **就地留着，一概不处置**。
const isLocalBackup = (f) => /\.(bak|orig)$/.test(path.basename(f)) || /\.bak\./.test(path.basename(f));

// 跨设备的 rename 会抛 EXDEV（仓库与 /tmp 常常不在同一个文件系统上）。
const moveOut = (from, to) => {
  mkdirSync(path.dirname(to), { recursive: true });
  try { renameSync(from, to); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    cpSync(from, to);
    rmSync(from, { force: true });
  }
};

let failed = 0;
const bad = (msg) => { console.error('  ✗ ' + msg); failed++; };

// ── 读锁 ────────────────────────────────────────────────────────────────────
if (!existsSync(LOCK_PATH)) {
  console.error(`❌ 缺 ${path.relative(process.cwd(), LOCK_PATH)} —— 没有它就无法确定要取哪一版`);
  process.exit(1);
}
const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
// repo 可被环境变量覆盖：fork 的人把自己的 agent 仓地址填进 WIDGET_REPO 即可，
// 不用改这个被 git 跟踪的文件（CI 上也可以用仓库 Variable 注入）。
const REPO = process.env.WIDGET_REPO || lock.repo;
const SHA = lock.sha;
const BASE = lock.base ?? 'frontend/public';
const TREES = lock.trees ?? {};

if (!/^[0-9a-f]{40}$/.test(SHA ?? '')) {
  console.error(`❌ widget.lock.json 的 sha 不是 40 位十六进制：${JSON.stringify(SHA)}`);
  process.exit(1);
}
const paths = Object.keys(TREES);
if (paths.length === 0) {
  console.error('❌ widget.lock.json 的 trees 是空的 —— 没有要取的东西');
  process.exit(1);
}
// 每一条 tree 的 key 必须落在 base 下：目标路径就是把它去掉 base 前缀后的那一段。
// 这条断言防的是"锁里写了个 base 之外的路径"，那种情况下落点会算到 frontend/public 外面去。
const rels = paths.map((p) => {
  if (!p.startsWith(BASE + '/')) {
    console.error(`❌ trees 里的 ${p} 不在 base（${BASE}）之下`);
    process.exit(1);
  }
  return p.slice(BASE.length + 1);
});

// ── 跑 git（任何一步非 0 退出即失败）────────────────────────────────────────
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) return { ok: false, err: r.error.message };
  if (r.status !== 0) return { ok: false, err: (r.stderr || r.stdout || '').trim() };
  return { ok: true, out: (r.stdout || '').trim() };
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'saudade-widget-'));
try {
  // `--filter=blob:none`：只拉 commit+tree，blob 按需取 ⇒ 稀疏检出两棵子树时不会把
  // 整个 agent 仓的历史内容拖下来（本机到 GitHub 的全量克隆会卡在传输）。
  let r = git(['clone', '--filter=blob:none', '--no-checkout', '-q', REPO, tmp]);
  if (!r.ok) {
    bad(`克隆 agent 仓失败：${r.err}\n      ${REPO}\n      （离线/网络不通时先手动准备，或设 WIDGET_REPO 指到可达的镜像）`);
    throw new Error('clone');
  }
  r = git(['sparse-checkout', 'set', ...paths], tmp);
  if (!r.ok) { bad(`设置稀疏锥失败：${r.err}`); throw new Error('sparse'); }
  r = git(['checkout', '-q', SHA], tmp);
  if (!r.ok) {
    bad(`检出 ${SHA} 失败：${r.err}\n      ⇒ 这个提交在远端取不到（被 force-push 改写过？fork 上没同步？）。\n` +
        `      pin 钉的是具体提交，agent 仓的 main 不许改写历史。`);
    throw new Error('checkout');
  }

  // ── 强判据：HEAD 与两棵子树的 tree sha 必须逐条相符 ──────────────────────
  // 一次抓住三件事：pin 挪了、锥配错了、agent 仓那一侧被改写了。
  r = git(['rev-parse', 'HEAD'], tmp);
  const headGot = r.ok ? r.out : '(取不到)';
  if (headGot !== SHA) bad(`检出的 HEAD 是 ${headGot}，不是锁里的 ${SHA}`);
  const staged = {};
  for (const rel of rels) {
    r = git(['rev-parse', `HEAD:${BASE}/${rel}`], tmp);
    const got = r.ok ? r.out : '(取不到)';
    staged[rel] = path.join(tmp, BASE, rel);
    if (!existsSync(staged[rel])) { bad(`检出后没有 ${BASE}/${rel} —— 稀疏锥配错了？`); continue; }
    if (got !== TREES[`${BASE}/${rel}`]) bad(`${rel} 的 tree sha 不符：锁里 ${TREES[`${BASE}/${rel}`]}，实得 ${got}`);
  }
  if (failed) throw new Error('verify');
  console.log(`  ✅ ${REPO.split('/').pop()} @ ${SHA.slice(0, 12)}  两棵子树 tree sha 相符`);

  // ── 列出两边各有哪些文件（vendor/ 不算）────────────────────────────────
  const listFiles = (dir) => {
    const out = [];
    const walk = (d, prefix) => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), rel);
        else out.push(rel);
      }
    };
    walk(dir, '');
    return out;
  };

  // ── 落位 / 校验 ─────────────────────────────────────────────────────────
  if (CHECK_ONLY) {
    let ok = 0;
    for (const rel of rels) {
      const dstDir = path.join(DEST, rel);
      for (const f of listFiles(staged[rel])) {
        const dst = path.join(dstDir, f);
        if (existsSync(dst) && sha256(dst) === sha256(path.join(staged[rel], f))) ok++;
        else bad(`本地那份与 pin 不一致：${path.relative(FRONTEND, dst)}`);
      }
    }
    if (!failed) console.log(`  ✅ 本地 ${ok} 份文件与 pin 逐字节相同（--check 未写盘）`);
  } else {
    let placed = 0;
    let orphaned = 0;
    // 目标树里"不在 pin 里"的文件一律**不删**：搬到这里，打印出来让人自己处置。
    // （曾经就近删过一份 `agent_2.physics3.json.bak`——那是主人自己留的手工备份，
    //  不属于 pin，这个脚本没有处置它的权力。历史里有，但那是侥幸。）
    const orphansDir = path.join(os.tmpdir(), `saudade-widget-orphans-${Date.now()}`);
    for (const rel of rels) {
      const dstDir = path.join(DEST, rel);
      const isPreserved = (f) => PRESERVE.some((k) => f === k || f.startsWith(k + '/'));
      const isBackup = (f) => isLocalBackup(f);
      // 保留 vendor/：把它挪进新树，再整树换过去（见文件头注的顺序说明）。
      const kept = PRESERVE.filter((name) => existsSync(path.join(dstDir, name)));
      const staging = dstDir + '.fetch-new';
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(path.dirname(staging), { recursive: true });
      cpSync(staged[rel], staging, { recursive: true });
      for (const name of kept) {
        renameSync(path.join(dstDir, name), path.join(staging, name));
        console.log(`  ⤵ 保留 ${rel}/${name}/（由 npm run vendor:live2d 生成，不属于 pin）`);
      }
      const incoming = new Set(listFiles(staged[rel]));
      const carry = []; // 手工备份：跟着一起搬进新树 ⇒ 从外面看就是"原地没动"
      for (const f of listFiles(dstDir)) {
        if (isPreserved(f) || incoming.has(f)) continue;
        if (isBackup(f)) { carry.push(f); continue; }
        moveOut(path.join(dstDir, f), path.join(orphansDir, rel, f));
        orphaned++;
      }
      // ⚠️ 得**搬进 staging**，不能只 `continue`：下面整目录 rmSync 会把留在原地的一并带走。
      for (const f of carry) {
        moveOut(path.join(dstDir, f), path.join(staging, f));
        console.log(`  = 留着 ${rel}/${f}（手工备份：既不是 pin 的、也不是脚本的，原地不动）`);
      }
      rmSync(dstDir, { recursive: true, force: true });
      renameSync(staging, dstDir);
      placed += listFiles(dstDir).filter((f) => !isPreserved(f) && !isBackup(f)).length;
      if (kept.length === 0 && rel === 'live2d-widgets') {
        // 不是错误（CI 上本来就没有），但顺序反了的话这里是唯一的提示——见文件头注。
        console.log('  ℹ live2d-widgets/vendor/ 不存在：若你接下来要本地跑 dev，记得再跑 npm run vendor:live2d');
      }
    }
    if (orphaned) {
      console.log(`  ⤵ ${orphaned} 份本地文件不在 pin 里，已**挪到** ${orphansDir}\n` +
                  '     （没删。确认没用就自己清掉；别让它们留在 public/ 下——vite 会当静态资源发出去）');
    }
    const bytes = rels.reduce((n, rel) => n + listFiles(path.join(DEST, rel))
      .reduce((m, f) => m + readFileSync(path.join(DEST, rel, f)).length, 0), 0);
    console.log(`  ✅ 落位 ${placed} 份文件 ${kb(bytes)} → ${path.relative(process.cwd(), DEST) || '.'}`);
  }
} catch {
  /* 具体原因已经打过了，下面统一收尾 */
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n❌ 看板娘前端未就位（${failed} 项）`);
  process.exit(1);
}
console.log('\n✅ 看板娘前端就位' + (CHECK_ONLY ? '（--check 未写盘）' : ''));

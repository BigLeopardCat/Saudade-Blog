// ═ 沙箱临时目录卫生：两个运行器的 TMPDIR 隔离 + 清扫脚本的判据（20261006）══
//   node tests/sandbox-tmp-hygiene.test.mjs
//
// 现场：`frontend/tests/` 下的套件用 `tempfile.mkdtemp(prefix=…)` 建临时目录，**跑完基本不删**
// （37 个 .py 里只有 10 个在 happy path 末尾删一次；.mjs 侧 24 个建目录的套件里只有
// `wordgraph-artifact.test.mjs` 有 finally）。实测 /tmp 因此堆到 **5.6G**，其中 2249 个目录 /
// 4.47G 是这批套件的残留——占整个 /tmp 的八成。最大一族 `comment-layout-` 141 个 / 2.5G；
// 次大 `cmt-` 60 个 / 588M（来自 .mjs 侧，而 `nightly_sandboxes.sh` 只枚举 `*.py`
// ⇒ 那条路漏出来的目录**从来没有东西管**）。
//
// 修法（用户 20261006 拍板：只修运行器 + 夜间清扫，**不动 61 个套件的源码**）：
//   ① 两个运行器给每个套件一个**专属 TMPDIR**——通过就删、失败就**留下**（排障材料）。
//      选这个而不是"每个套件自己清"，因为运行器知道**过没过**，套件自己分不出这两种结局；
//   ② 一个独立清扫脚本收走隔离盖不住的（手跑单套件、被 kill 的轮次），夜跑末尾调它。
//
// ⚠️ 这套东西的**失效方式全是静默的**，所以必须有这份锁：
//   · `mkdir -p` 漏了 ⇒ TMPDIR 指向不存在的目录 ⇒ `tempfile.gettempdir()` **静默回落到 /tmp**，
//     隔离看着生效、实际一行没生效；
//   · 失败那一支误删 ⇒ 排障材料没了（没有别的地方留）；
//   · 清扫脚本"默认就删" ⇒ 半夜自己动手，而它判据错了没人知道；
//   · 前缀改回**手写名单** ⇒ 漏一族就再也不会被扫，**且没有任何东西会变红**
//     （本轮手写的第一个版本就漏了 ann-verify- / comment-layout- / mmzoom- / readcol- /
//      readmob- / uc-verify- 六族，合计 700M+）。
//
// 为什么只做**源码锁**、不去真跑那个 python 脚本：本仓 51 个 .mjs 套件从来没有 spawn 过
// python/bash（只用过 vendored 的 esbuild 二进制），不新开这个口子。真正的**行为**验证
// （诱饵目录、年龄闸、干跑不删）在 `tests/sandbox-tmp-prune.test.py` 里，那一条进了夜跑。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

/** 读仓库里的文件；**读不到就是红**（守卫看不见源码等于守卫不存在）。 */
const read = (rel) => {
    const abs = path.join(repo, rel);
    if (!existsSync(abs)) { ok(false, `读得到 ${rel}`, abs); return null; }
    return readFileSync(abs, 'utf8');
};
/** 空白归一：跨行结构（if/then/else）用整串断言时先摊平。 */
const flat = (s) => s.replace(/\s+/g, ' ').trim();
/** 出现次数（判"只许出现一次"这类形状）。 */
const count = (s, sub) => s.split(sub).length - 1;
/** 剥掉 python 的行注释。**数之前先剥注释**是本仓的负控惯例——否则注释里举的例子会假红。 */
const stripPyComments = (s) => s.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');

const SH = read('scripts/nightly_sandboxes.sh');
const MJS = read('frontend/tests/run-suites.mjs');
const PY = read('scripts/prune_sandbox_tmp.py');

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n① nightly_sandboxes.sh：每个套件一个专属 TMPDIR');
// ═══════════════════════════════════════════════════════════════════════════════
if (SH) {
    const f = flat(SH);
    ok(f.includes('SANDBOX_TMP=${SANDBOX_TMP:-/tmp/saudade-sandboxes}'),
        '临时目录根可覆盖（SANDBOX_TMP，默认落在 /tmp/saudade-sandboxes）');
    ok(f.includes('RUN="$SANDBOX_TMP/$(date +%Y%m%dT%H%M%S)"'), '每轮一个轮次目录 RUN');
    ok(f.includes('suite_tmp="$RUN/${name%.py}"'), '每个套件一格（$RUN/<套件名>）');

    // ★ 顺序：先 mkdir -p 再把它当 TMPDIR 用。反了就是"静默回落到 /tmp"那条半死。
    const mkIdx = f.indexOf('mkdir -p "$suite_tmp"');
    const envIdx = f.indexOf('TMPDIR="$suite_tmp" timeout');
    ok(mkIdx >= 0 && envIdx >= 0 && mkIdx < envIdx,
        '★ `mkdir -p` 在 `TMPDIR=` 之前（TMPDIR 不存在 ⇒ tempfile 静默回落到 /tmp）',
        { mkIdx, envIdx });

    ok(f.includes('if TMPDIR="$suite_tmp" timeout -k 30 480 python3 "$t" >>"$LOG" 2>&1; then rm -rf "$suite_tmp"'),
        '★ 通过那一支才删（then 紧跟 rm -rf）');
    ok(f.includes('现场留在 $suite_tmp'), '★ 失败那一支把现场路径写进日志');
    ok(count(f, 'rm -rf "$suite_tmp"') === 1,
        '★ `rm -rf "$suite_tmp"` 全脚本只有一处（多一处就意味着失败现场也会被删）',
        count(f, 'rm -rf "$suite_tmp"'));
    ok(f.includes('rmdir "$RUN" 2>/dev/null'), '轮次目录只收空的（rmdir 对非空自然失败 ⇒ 留着失败现场）');

    // 清扫：必须 --apply（默认只列不删），且**不能**影响沙箱结果
    ok(f.includes('python3 scripts/prune_sandbox_tmp.py --apply'), '末尾调清扫脚本，且显式 --apply');
    ok(f.includes('scripts/prune_sandbox_tmp.py --apply >>"$LOG" 2>&1')
        && f.includes('|| say "[$TS] 清扫运行异常'),
        '★ 清扫失败只记一行、不改沙箱结果（同 agent 仓 nightly 调 trace_retention.py 的做法）');
    const markIdx = f.lastIndexOf('touch "$MARK"');
    ok(markIdx >= 0 && f.indexOf('scripts/prune_sandbox_tmp.py') > markIdx,
        '★ 清扫在哨兵判定**之后**（先定成败，再打扫卫生）', { markIdx });
    ok(f.includes('SANDBOX_TMP') && f.includes('export PATH='), '仍然是 cron 友好（PATH 显式给全那几条没被碰掉）');
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n② run-suites.mjs：同一套约定（.mjs 侧此前没有任何东西管）');
// ═══════════════════════════════════════════════════════════════════════════════
if (MJS) {
    const f = flat(MJS);
    ok(f.includes("process.env.SANDBOX_TMP"), '共用同一个 SANDBOX_TMP（清扫脚本的第二条规则对两侧一视同仁）');
    ok(f.includes('const runDir = path.join(tmpRoot, stamp)'), '每轮一个轮次目录');
    ok(f.includes('const suiteTmp = path.join(runDir, f.replace(/') && f.includes('mjs$/'),
        '每个套件一格（$RUN/<套件名>，去掉 .test.mjs 后缀）');
    const mkIdx = f.indexOf('mkdirSync(suiteTmp');
    const spIdx = f.indexOf('spawnSync(process.execPath');
    ok(mkIdx >= 0 && spIdx >= 0 && mkIdx < spIdx,
        '★ `mkdirSync` 在 `spawnSync` 之前（同①：不存在就静默回落）', { mkIdx, spIdx });
    ok(f.includes('env: { ...process.env, TMPDIR: suiteTmp }'), '★ 把 TMPDIR 交给子进程');
    ok(count(f, 'rmSync(suiteTmp') === 1 && f.includes('} else { rmSync(suiteTmp'),
        '★ `rmSync(suiteTmp` 只有一处、且在 else（成功）那一支 —— 失败现场不删',
        count(f, 'rmSync(suiteTmp'));
    ok(f.includes('现场留在 ${suiteTmp}'), '★ 失败时把现场路径带进失败列表（末尾会汇总打印）');
    ok(f.includes('rmdirSync(runDir)'), '轮次目录只收空的（rmdirSync 对非空抛错 ⇒ 留着失败现场）');
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n③ prune_sandbox_tmp.py：判据是白名单 + 年龄闸 + 路径必须在根之下');
// ═══════════════════════════════════════════════════════════════════════════════
let pyRe = null;
if (PY) {
    const f = flat(PY);
    ok(/"--apply", action="store_true"/.test(PY) && /只列不删/.test(PY),
        '★ --apply 是开关、不是默认；帮助里写明"默认只列不删"');
    ok(f.includes('if not args.apply: print("（只列不删；要真删加 --apply）") return 0'),
        '★ 不 --apply 就在删之前 return 0（干跑与真删共用同一个 plan()，不会各算各的）');
    ok(count(PY, 'drop = plan(') === 1, '★ 判据只有一处：干跑与 --apply 都走它', count(PY, 'drop = plan('));
    ok(f.includes('min_age_h * 3600') && f.includes('RUN_DIR_MAX_AGE_H * 3600'),
        '★ 两条规则都有年龄闸（绝不碰正在跑的套件 / 本轮）');
    ok(f.includes('if p.is_symlink(): continue') && f.includes('if p.is_symlink() or not p.is_dir(): continue'),
        '★ 不跟随符号链接');
    ok(f.includes('if not root.is_dir():') && f.includes('❌ 根目录不存在或不是一个目录'),
        '根不是目录 ⇒ 报错退出（退出码 1），不是"照删不误"');
    ok(PY.includes('raise SystemExit(main())'), '入口是 raise SystemExit(main())（家法）');
    ok(f.includes('glob("*.py")') && f.includes('glob("*.mjs")'),
        '**前缀是从两侧套件源码里推出来的**（.py 与 .mjs 都扫）');

    // ④ 的正则从这里抽，避免"照抄一份、然后两份各漂各的"
    const m = /_PY_PREFIX_RE\s*=\s*re\.compile\(r"""([\s\S]*?)"""[\s\S]*?_MJS_PREFIX_RE\s*=\s*re\.compile\(\s*r"""([\s\S]*?)"""/.exec(PY);
    ok(!!m, '★ 两条前缀正则都在（第 ④ 组会把它们抽出来当场用）');
    if (m) pyRe = [new RegExp(m[1], 'gs'), new RegExp(m[2], 'gs')];

    // 负空间：前缀不许写成手写名单（先把注释剥掉，否则注释里举的例子会假红）
    const quoted = (stripPyComments(PY).match(/["'][A-Za-z][A-Za-z0-9_.]*-["']/g) || []);
    ok(quoted.length === 0,
        '★ 负空间：源码里没有任何"手写的带连字符前缀字面量"（前缀只能靠推）', quoted.slice(0, 5));
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n④ ★ 完整性：凡是真的建临时目录的套件，推导都必须认得出来');
// ═══════════════════════════════════════════════════════════════════════════════
// 这一组是整份锁里唯一"会随着新增套件而变化"的判据：加一个套件、写成推导认不出的形状，
// 它就会红——否则那一族的残留会永远扫不掉，而且**没有任何东西会变声**。
if (pyRe) {
    const CALL = /mkdtemp(?:Sync)?\s*\(/;      // 只在**非注释行**上判（本仓惯例：负控先剥注释）
    const isComment = (line) => /^\s*(#|\/\/|\*|\/\*)/.test(line);
    // 排除本文件自己：它不是沙箱套件（是守卫），而且 `CALL` 那个正则的字面里就含着 `mkdtemp(`
    // ——不排除的话它会自匹配，变成一条永远红的假警报。**本文件里不该出现真的建目录调用**。
    const files = readdirSync(here)
        .filter((f) => f.endsWith('.py') || f.endsWith('.test.mjs'))
        .filter((f) => f !== path.basename(fileURLToPath(import.meta.url)))
        .sort();
    const blind = [];
    let sites = 0;
    for (const name of files) {
        const src = readFileSync(path.join(here, name), 'utf8');
        const realLines = src.split('\n').filter((l) => CALL.test(l) && !isComment(l));
        if (realLines.length === 0) continue;
        sites += realLines.length;
        const hits = pyRe.reduce((n, rx) => n + (src.match(rx) || []).length, 0);
        if (hits < realLines.length) blind.push({ 文件: name, 调用点: realLines.length, 认得出来: hits });
    }
    ok(sites >= 60, `扫到了${sites} 个真调用点（两侧合计；太少说明扫描本身失效了）`, sites);
    ok(blind.length === 0,
        `★ 每一个建临时目录的套件都能被推导认出前缀（认不出的：${JSON.stringify(blind)}）`, blind);
    ok(files.some((f) => f === 'sandbox-tmp-prune.test.py') && files.some((f) => f === 'comment-render.test.mjs'),
        '两侧的套件都在扫描范围里（.py 与 .test.mjs）');
}

console.log('\n════ ' + pass + '/' + (pass + fail) + ' 项通过 ════\n');
process.exit(fail === 0 ? 0 : 1);

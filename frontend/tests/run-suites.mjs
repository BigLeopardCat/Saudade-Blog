/**
 * 跑 tests/ 下所有 *.test.mjs 套件（20260923）。
 *
 * 本仓库没有 jest：tests/ 下的套件都是 `node tests/xxx.test.mjs` 直接执行 + `node:assert`。
 * **数量不写死在这里**（此前写死过一次，加一个套件就变成新的陈旧注释）：实际条数以
 * 下面的 glob 为准，末尾那行汇总会报 N/N。
 * 此前 package.json 里那句 `"test": "jest"` 是个死脚本——既没有 jest 配置也没有这个依赖，
 * 于是"跑测试"这件事对人和 CI 都不可执行（CI 里干脆一项检查都没有）。
 *
 * 用法：`npm test`（= node tests/run-suites.mjs），CI 的 check job 走同一条路。
 *
 * 不进这里的：`*.test.py`（要 Playwright + 无头 Chrome，CI 的秒级 job 上跑不了；由
 * `scripts/nightly_sandboxes.sh` 每天 04:40 串行跑，结果在 ~/sandbox_regression.log）
 * 与 `eval/*.py`（要真服务与真语料，本机按需跑）。
 * 20260927 变更：`repro-timegap.mjs` / `smoke-harness.mjs` 两支**已修好并升格进 CI**
 * （现名 `chat-time-divider.test.mjs` / `chat-boot-smoke.test.mjs`）——它们当时
 * 各自都跑不到自己声称在测的地方（缺 `document.querySelector`、缺会话桩、时钟没钉死，
 * 详见 `stubs/dom.mjs` 头注），修好后每条断言都确定可判。
 *
 * 20261006 变更（**临时目录隔离**，与 `scripts/nightly_sandboxes.sh` 同一套约定）：
 * 24 个套件用 `mkdtempSync(path.join(tmpdir(), '…'))` 建临时目录，此前一个都不删
 * （只有 `wordgraph-artifact.test.mjs` 有 `finally`）——本机 `npm test` 跑几遍就往
 * /tmp 撒几十个目录，`cmt-` 那一族攒到 60 个 / 588MB。现在每个套件拿到**专属 TMPDIR**，
 * 通过才删、失败留下并打印路径。手跑单个套件（`node tests/xxx.test.mjs`）没人给它
 * TMPDIR，仍旧落在 /tmp，由夜间清扫收掉。
 */
import { readdirSync, mkdirSync, rmSync, rmdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const suites = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()

// 临时目录根与"轮次目录"：与 nightly_sandboxes.sh 共用同一个默认根，这样清扫脚本的
// 第二条规则（收 24h 以上的陈旧轮次目录）对两侧一视同仁。
// 每个套件的格子**必须先 mkdir**——TMPDIR 指向不存在的目录时 `os.tmpdir()` 会静默
// 回落到 /tmp（Python 那边 `tempfile.gettempdir()` 同理）：隔离看着生效、实际没生效。
const tmpRoot = process.env.SANDBOX_TMP || path.join(tmpdir(), 'saudade-sandboxes')
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z')
const runDir = path.join(tmpRoot, stamp)

if (suites.length === 0) {
    console.error('❌ tests/ 下没有 *.test.mjs')
    process.exit(1)
}

const failed = []
for (const f of suites) {
    console.log(`\n──── ${f} ────`)
    const suiteTmp = path.join(runDir, f.replace(/\.test\.mjs$/, ''))
    try {
        mkdirSync(suiteTmp, { recursive: true })
    } catch (e) {
        failed.push(`${f}（建不出临时目录 ${suiteTmp}：${e.message}）`)
        continue
    }
    const r = spawnSync(process.execPath, [path.join(dir, f)], {
        stdio: 'inherit',
        env: { ...process.env, TMPDIR: suiteTmp },
    })
    if (r.status !== 0) {
        // 失败现场**不删**：那是排障材料。路径写进失败列表里（末尾会汇总打印）。
        failed.push(`${f}（退出码 ${r.status}，现场留在 ${suiteTmp}）`)
    } else {
        rmSync(suiteTmp, { recursive: true, force: true })
    }
}
// 轮次目录只收**空的**：失败现场那一格还装着东西，rmdirSync 会自然抛错、不动它。
try {
    rmdirSync(runDir)
} catch {
    // 非空（有失败现场）或还没被建出来——两种都按预期处理，不做任何事
}

console.log(`\n════ ${suites.length - failed.length}/${suites.length} 个套件通过 ════`)
if (failed.length) {
    console.error('失败：' + failed.join('、'))
    process.exit(1)
}

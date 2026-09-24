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
 * 与 `repro-*.mjs` / `smoke-harness.mjs`（手工排查工具，不是断言套件）。
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const suites = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()

if (suites.length === 0) {
    console.error('❌ tests/ 下没有 *.test.mjs')
    process.exit(1)
}

const failed = []
for (const f of suites) {
    console.log(`\n──── ${f} ────`)
    const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' })
    if (r.status !== 0) failed.push(`${f}（退出码 ${r.status}）`)
}

console.log(`\n════ ${suites.length - failed.length}/${suites.length} 个套件通过 ════`)
if (failed.length) {
    console.error('失败：' + failed.join('、'))
    process.exit(1)
}

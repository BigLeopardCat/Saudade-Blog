// ═ 对话额度：余额口径 + 档位色单一真源（20260929b）══
//   node tests/quota-balance.test.mjs
//
// 背景（用户原话）：「额度设计为 500 开始减少而不是 0 开始计数，现在不符合直觉，
// 还有余额条颜色会根据会话余额变色。」
//
// 改动落在 `src/utils/quota.ts`：**存累计、显示余额**。存储那边一个字没动——
// 库里的 `chat_quota_used` 是累计已用，`UPDATE … SET used = used + 1 WHERE used < limit`
// 那条语句是并发不变量的载体，换成余额递减就得读-改-写。
//
// 本套件锁三件事，每件都对应一种**真实的**失效形态：
//   ① 减法与钳制：`limit - used` 只在一个地方算（`used` 超上限时不许印出「剩 -3 / 500」）；
//   ② 四个"不是数字"的形态各说各的话（不限额 / 读不到 / 用尽 / 正常）——合并任意两个
//      都会说出一句假话（把"读不到"印成「剩 0/500」＝对着正在聊天的人说他额度用完了）；
//   ③ 档位阈值只有这一个来源，且**四个显示点都真的 import 它**——这一条是源码锁：
//      阈值/文案一旦被抄成第二份，本套件在**数值上**仍然会绿（两份恰好相等），
//      只有"谁在用"这条断言能抓住漂移。这正是本仓"手抄第二份名单"反复出事的形状。
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = mkdtempSync(path.join(tmpdir(), 'quotabalance-'));

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
    if (ok) { pass++; console.log(`  ✅ ${label}${extra ? `  [${extra}]` : ''}`); }
    else { fail++; console.log(`  ❌ ${label}${extra ? `  [${extra}]` : ''}`); }
};

// quota.ts 是纯 TS、零 import —— esbuild 直接打，不需要任何 stub。
const file = path.join(out, 'quota.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/quota.ts')],
    bundle: true, format: 'esm', outfile: file, logLevel: 'silent',
});
const Q = await import(pathToFileURL(file).href);

console.log('\n① 余额文案：减法在这里做一次，超上限要钳住');
check('剩 363 / 500（正常档）', Q.quotaBalanceText(363, 500) === '剩 363 / 500',
    Q.quotaBalanceText(363, 500));
check('剩 0 / 500（用尽也是**一个数**，不是"读不到"）',
    Q.quotaBalanceText(0, 500) === '剩 0 / 500', Q.quotaBalanceText(0, 500));
check('⭐ `used` 超上限（`CHAT_QUOTA_LIMIT` 被调小之后的存量账号）⇒ 钳到 0，'
    + '**不许**印出「剩 -3 / 500」——那不是人话也不是事实',
    Q.quotaBalanceText(-3, 500) === '剩 0 / 500', Q.quotaBalanceText(-3, 500));
check('⭐ `limit === 0` ⇒ 「不限额」（0 是"不限"，与"上限为零/用完了"正好相反）',
    Q.quotaBalanceText(0, 0) === '不限额', Q.quotaBalanceText(0, 0));
check('⭐ 字段缺席 ⇒ 「额度 —」，**不是** `剩 0 / 0`'
    + '（后者会被读成"这个人用完了"，而同一行上没有别的线索能纠正它）',
    Q.quotaBalanceText(undefined, undefined) === '额度 —'
    && Q.quotaBalanceText(null, 500) === '额度 —', Q.quotaBalanceText(null, 500));
check('  次角那句「已用 N 轮」独立成形；读不出时**是空串**（调用方直接不渲染），'
    + '不是「已用 0 轮」',
    Q.quotaUsedHint(137, 500) === '已用 137 轮'
    && Q.quotaUsedHint(undefined, 500) === '' && Q.quotaUsedHint(137, 0) === '',
    JSON.stringify(Q.quotaUsedHint(undefined, 500)));
check('  账号行那枚 chip 是同一口径（前缀 + 上面那个函数，不是第二份减法）',
    Q.quotaChipText(137, 500) === '额度：剩 363 / 500'
    && Q.quotaChipText(0, 0) === '额度：不限额'
    && Q.quotaChipText(undefined, 500) === '额度 —', Q.quotaChipText(137, 500));

console.log('\n② 档位阈值：三档 + 两处不是档位的形态');
check('≥50% ⇒ ok（250/500 恰好落在边界上，算充足）', Q.quotaLevel(250, 500) === 'ok',
    Q.quotaLevel(250, 500));
check('20–50% ⇒ low', Q.quotaLevel(100, 500) === 'low', Q.quotaLevel(100, 500));
check('⭐ 恰好 100/500 = 20% ⇒ **low**（阈值是"低于 20% 才告急"，边界不许两边都算）',
    Q.quotaLevel(100, 500) === 'low', Q.quotaLevel(100, 500));
check('<20% ⇒ critical', Q.quotaLevel(99, 500) === 'critical', Q.quotaLevel(99, 500));
check('⭐ 0 ⇒ **empty**（与 critical 分开：条是空的，文案「剩 0 / 500」）',
    Q.quotaLevel(0, 500) === 'empty', Q.quotaLevel(0, 500));
check('⭐ 读不到 ⇒ **null**，不是 `empty`——拿"读不到"冒充"用完了"正好说反',
    Q.quotaLevel(undefined, 500) === null && Q.quotaLevel(1, undefined) === null,
    String(Q.quotaLevel(undefined, 500)));
check('不限额 ⇒ unlimited（不上色、也不画条）',
    Q.quotaLevel(0, 0) === 'unlimited', Q.quotaLevel(0, 0));
check('  两个阈值常量导出（改档位只改这两个数）',
    Q.QUOTA_LOW_RATIO === 0.2 && Q.QUOTA_OK_RATIO === 0.5,
    `${Q.QUOTA_LOW_RATIO}/${Q.QUOTA_OK_RATIO}`);

console.log('\n③ 条宽：画的是**余额**（越短＝越该着急）');
check('满额 ⇒ 100%', Q.quotaPct(500, 500) === 100, String(Q.quotaPct(500, 500)));
check('用掉一半 ⇒ 50%（**不是** 50% 的"已用条"——同一个数，反过来的方向）',
    Q.quotaPct(250, 500) === 50, String(Q.quotaPct(250, 500)));
check('⭐ 不限档 ⇒ 0（调用方本就不该画这条：`limit` 是 0，画出来是一条 0% 的空条，'
    + '看着像额度用光了）',
    Q.quotaPct(0, 0) === 0, String(Q.quotaPct(0, 0)));
check('读不到 ⇒ 0，且**钳在 0..100**（超上限/负剩余都不许把条撑出容器）',
    Q.quotaPct(undefined, 500) === 0 && Q.quotaPct(-5, 500) === 0
    && Q.quotaPct(600, 500) === 100,
    `${Q.quotaPct(undefined, 500)}/${Q.quotaPct(-5, 500)}/${Q.quotaPct(600, 500)}`);

console.log('\n④ ⭐ 源码锁：四个显示点都得**真的** import 这个模块');
// 数值断言抓不住"抄了第二份"——两份恰好相等时全绿。只有"谁在用它"这条能抓。
const SITES = [
    ['src/components/UserCenter/index.tsx', '个人中心「对话额度」页签'],
    ['src/pages/Dashboard/Users/index.tsx', '后台账号行那枚 chip'],
    ['src/pages/Dashboard/QuotaManage/index.tsx', '后台额度管理那一列'],
];
for (const [rel, what] of SITES) {
    const src = readFileSync(path.join(root, rel), 'utf8');
    const imports = /from\s+['"][^'"]*utils\/quota(\.ts)?['"]/.test(src);
    check(`⭐ ${what}（${rel}）从 utils/quota 取数`, imports, imports ? '' : '没找到 import');
}
// 反面：被换掉的那套写法不许回来（`used/limit` 与"已用/上限"两种旧口径）
for (const [rel] of SITES) {
    const src = readFileSync(path.join(root, rel), 'utf8');
    check(`  ${rel} 里没有残留的 \`used / limit\` 旧口径文案`,
        !/`\$\{[^}]*\.used\}\s*\/\s*\$\{[^}]*\.limit\}`/.test(src)
        && !/'已用 \/ 上限'/.test(src), '');
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass} 项）`);
process.exit(fail === 0 ? 0 : 1);

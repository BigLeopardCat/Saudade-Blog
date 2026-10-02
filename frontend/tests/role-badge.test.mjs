// ═ 身份徽章：扶正 + 换装（20261003）跨文件契约 ══
//   node tests/role-badge.test.mjs
//
// 这一批改动只有两处文件（`components/RoleBadge/index.tsx` 与 `utils/auth.ts`），但它是
// **形状最容易被悄悄改回去**的那一类：整枚徽章由一张 `SPECS` 表驱动，改一个数字不会有
// 任何编译期反馈，而它的消费方（个人中心 `.ucRoleTag`、后台账号行、评论区）全是靠
// **源码断言**配着无头沙箱在看的——沙箱只在夜间跑，白天改错了没人会知道。
//
// 所以这里把主人这次点的三件事钉成可执行的判据：
//   ① **扶正**：除杂鱼外倾角一律 0（20261003 之前五档各不相同，"歪多少"本身就是特征）；
//   ② **换装**：`admin` 接手原 `superadmin` 那一套（薰衣草→粉、双层白边、两端小星）；
//   ③ **站长的文本只有两个字**：不带表情，且文案只从 `ROLE_LABEL` 取（组件里不许另写一份）。
//
// 不跑浏览器：几何与配色由 `scripts/nightly_sandboxes.sh` 里的 `.test.py` 串在真页面上量。
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')

let passed = 0, failed = 0
const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name) }
    else {
        failed++
        console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : ''))
    }
}
/** 剥注释后再判"代码里没有 X"——本组件的头注**刻意**写着「站长」「管理员」这些词
 *  （就是在解释文案从哪来），不剥的话"文案不在组件里手抄"那条断言恒红。 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const badge = read('src/components/RoleBadge/index.tsx')
const auth = read('src/utils/auth.ts')

/** 从 SPECS 里摘出某一档的对象字面量（从 `role: {` 到配对的 `},`）。 */
function specOf(role) {
    const block = badge.slice(badge.indexOf('const SPECS'), badge.indexOf('const FALLBACK'))
    const i = block.indexOf(`\n    ${role}: {`)
    if (i < 0) return ''
    const j = block.indexOf('},', i)
    return j < 0 ? '' : block.slice(i, j)
}
/** 取一条字段的值（数字或字符串字面量）。 */
function field(spec, key) {
    const m = spec.match(new RegExp(`${key}:\\s*('([^']*)'|(-?[\\d.]+)|(true|false))`))
    if (!m) return undefined
    if (m[2] !== undefined) return m[2]
    if (m[3] !== undefined) return Number(m[3])
    return m[4] === 'true'
}

const TIERS = ['superadmin', 'admin', 'secretary', 'user', 'zako']

console.log('① 五档都在，且各自的取色互不相同')
const specs = Object.fromEntries(TIERS.map((r) => [r, specOf(r)]))
ok(TIERS.every((r) => specs[r].length > 0), 'SPECS 里五档都有对象字面量',
    TIERS.filter((r) => !specs[r]))
const pairs = TIERS.map((r) => `${field(specs[r], 'from')}→${field(specs[r], 'to')}`)
ok(new Set(pairs).size === 5, '五档的渐变两端两两不同（配色仍是主要辨识手段）', pairs)
// 扶正之后倾角不再携带信息 ⇒ 配色若有重复就是真的分不出来了
ok(TIERS.every((r) => field(specs[r], 'ink')), '每一档都显式写了 ink（不靠继承）',
    TIERS.map((r) => [r, field(specs[r], 'ink')]))

console.log('\n② 扶正：除杂鱼外倾角一律 0')
const tilts = Object.fromEntries(TIERS.map((r) => [r, field(specs[r], 'tilt')]))
ok(tilts.zako === -2, '杂鱼保留 -2°（主人样例那一版就是这个角度）', tilts.zako)
ok(TIERS.filter((r) => r !== 'zako').every((r) => tilts[r] === 0),
    '其余四档倾角全部回正', tilts)
ok(TIERS.every((r) => typeof tilts[r] === 'number'), '每一档都显式写了 tilt（不靠默认值）', tilts)

console.log('\n③ 换装：管理员接手原超管那一套')
ok(field(specs.admin, 'from') === '#b9a7f5' && field(specs.admin, 'to') === '#ff9ec9',
    '管理员＝薰衣草→粉（原超管那对色）',
    [field(specs.admin, 'from'), field(specs.admin, 'to')])
ok(field(specs.admin, 'ring') === 'double', '管理员＝双层白描边', field(specs.admin, 'ring'))
ok(field(specs.admin, 'stars') === true, '管理员＝两端小星（这一档现在唯一带星）', field(specs.admin, 'stars'))
ok(field(specs.admin, 'lead') === '🛡', '管理员仍带自己的盾牌（接手的是样式，不是身份）',
    field(specs.admin, 'lead'))
ok(TIERS.filter((r) => field(specs[r], 'stars') === true).join() === 'admin',
    '整张表里只有 admin 带 stars——多一档就是原样式没换干净',
    TIERS.filter((r) => field(specs[r], 'stars') === true))

console.log('\n④ 站长：无表情、有配色、白边独占一档')
ok(field(specs.superadmin, 'lead') === '', '站长的 lead 是空串（主人：不要加表情图标在文本）',
    field(specs.superadmin, 'lead'))
ok(!field(specs.superadmin, 'tail'), '站长没有收尾表情（tail 只有杂鱼有）', field(specs.superadmin, 'tail'))
ok(!field(specs.superadmin, 'stars'), '站长不带小星（小星随样式一起给了管理员）',
    field(specs.superadmin, 'stars'))
ok(field(specs.superadmin, 'ring') === 'solid', '站长的白边是 solid', field(specs.superadmin, 'ring'))
ok(TIERS.filter((r) => field(specs[r], 'ring') === 'solid').join() === 'superadmin',
    'solid 这一档只剩站长在用（形状仍是一根可辨识的支柱）',
    TIERS.filter((r) => field(specs[r], 'ring') === 'solid'))
const glyphs = `${field(specs.superadmin, 'lead') || ''}${field(specs.superadmin, 'tail') || ''}`
ok([...glyphs].every((ch) => (ch.codePointAt(0) ?? 0) < 0x2000),
    '站长那两条表情位上一个表情/符号字符都没有（emoji 有个"悄悄混进 from/to"的同族错法）',
    glyphs)
// 20261003 主人看过对照图后否掉了"把原管理员那对给站长"的写法：那等于管理员接手超管那套
// 的同时、超管穿上管理员刚脱下的那套，两档成了衣服对调。锁死它，别在调色时又绕回去。
const su = `${field(specs.superadmin, 'from')}→${field(specs.superadmin, 'to')}`
ok(su !== '#d94f9a→#ffb38a',
    '站长**不穿**原管理员那对（玫粉→蜜桃）——那一眼看过去像谁也没换新，主人否过', su)

console.log('\n⑤ 文案只有一处实现：ROLE_LABEL')
const labelSuper = (auth.match(/superadmin:\s*'([^']+)'/) || [])[1]
ok(labelSuper === '站长', 'ROLE_LABEL.superadmin == 「站长」', labelSuper)
ok(/ROLE_LABEL\[role\]/.test(strip(badge)),
    '徽章文案仍从 ROLE_LABEL 取（组件里不另抄一份中文名）')
// 组件里**不许**出现身份中文名——注释里刻意写着（那是在解释文案从哪来），只判代码
ok(!/['"`](站长|管理员|秘书|普通用户|杂鱼)['"`]/.test(strip(badge)),
    '组件的代码里没有任何身份中文名字面量（第二份名字表就是这么长出来的）',
    strip(badge).match(/['"`](站长|管理员|秘书|普通用户|杂鱼)['"`]/))
ok(/label = \(role && ROLE_LABEL\[role\]\) \|\| role \|\| '—'/.test(badge),
    '取不到就回退原值（漏改映射时显示英文 role 而不是编一个名字）')
ok(/^\s{4}superadmin:\s*'/m.test(strip(auth)),
    'ROLE_LABEL 的**键名仍是 superadmin**（取值域是后端 authz::KNOWN_ROLES，改键要一次迁移）')

console.log('\n⑥ 渲染路径没被顺手改掉（三条硬约束仍在）')
ok(/display: 'inline-block'/.test(strip(badge)), '① 外层仍是 inline-block（几何断言读的是它）')
ok(/data-role=\{role && SPECS\[role\] \? role : ''\}/.test(badge),
    '② data-role 仍挂在外层 span 上且取值是**角色键**（users-page.test.py 按它取行）')
ok(/aria-label=\{label\}/.test(badge), '② aria-label 挂在外层 span 上，取的是 ROLE_LABEL 那份文案')
ok(/useId\(\)/.test(badge) && /linearGradient id=\{gid\}/.test(badge),
    '③ 渐变 id 仍每实例唯一（同页十几枚徽章，同 id 会串色）')
ok(/spec\.tilt/.test(badge) && /rotate\(\$\{spec\.tilt\}/.test(badge),
    '倾角仍只作用在 SVG 内部的 <g> 上（外层盒子保持正的）')

console.log(`\nrole-badge: ${passed} 通过, ${failed} 失败\n`)
process.exit(failed ? 1 : 0)

// ═ 向量图谱页签的**滚动与布局**判据（20261004 建，用户实测"不能整页滚动看完整的日志框"）══
//   node tests/graph-rebuild-panel.test.mjs      （CI 秒级套件，靠 `npm test` 自动带上）
//
// 症状（用户原话）："向量图谱控制面板布局很奇怪而且不能整页滚动看完整的日志框"。
// 根因是**一条永远不会生效的声明**，属于本仓反复吃亏的「写了但没接上」：
//
//   后台外壳是 `.contain{height:100vh}` → `.content{height:100%}` →
//   `.Card{height:95%; overflow:hidden}`（pages/Dashboard/index.css）——一个**固定高度、
//   且会裁掉溢出**的盒子。页签容器 `.allin` 当时写的是内联 `style={{ padding:20,
//   overflowY:'scroll' }}`：**overflow 有了、高度没有**。块级元素的自动高度由内容决定 ⇒
//   它永远和内容一样高、自己从不溢出 ⇒ 那行 `overflowY` 一条都轮不到生效；超出卡片的部分
//   被 `.Card{overflow:hidden}` 静默裁掉，**没有任何一条滚动条**。日志框（当时写死
//   260px 高）正好在被裁掉的那一段里。
//
// 所以判据分三层，缺一层就还是坏的：
//   ① **滚动容器必须有确切高度**（下面 `scrollable()`）——只判"有没有 overflow"是**假判据**，
//      本文件用一段"修复前的真实形状"做反向对照把这条钉死；
//   ② **高度链的前提**：`.ant-card .ant-card-body` 得给 `height:100%`（index.css），
//      少这一环 `.allin` 的 100% 退化成内容高度，滚动再次失效；
//   ③ **面板自身不许再套一层滚动**、日志区**不许写死高度**——否则"能滚"是能滚了，
//      但滚的是里面那层 260px 的框，外层永远滚不到日志的其余部分（＝用户看到的症状原样保留）。
//
// 已知盲区：判的是**源级性质**（编译产物里的声明），不是浏览器里的几何 —— 沙箱只编译组件
// 的 .sass、拿不到跨文件的 `.Card{overflow:hidden}`（见 tests/comment-layout.test.py 的头注），
// 几何断言在这里会误读。真几何要靠无头浏览器手工量一次，本套件负责的是"这行声明还在不在"。
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as sass from 'sass';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');            // frontend/
const SRC = (...p) => path.join(root, 'src', ...p);

const FAILS = [];
const check = (desc, cond, detail = '') => {
    console.log((cond ? '  ✅ ' : '  ❌ ') + desc + (detail ? `  [${detail}]` : ''));
    if (!cond) FAILS.push(desc);
};

/** 取编译产物里某条规则的声明块（**编译后没有注释**——判"没有"时这一步必须做，
 *  否则源码注释里的示例文本会被当成声明，本仓 20260923 在这上面吃过一次假绿）。 */
function ruleOf(css, selector) {
    const re = new RegExp(`(?:^|[}{])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
    const m = re.exec(css);
    return m ? m[1] : '';
}

/** 一条声明是否在场（`prop` 与取值都按**声明**匹配，不做子串搜索）。 */
const hasDecl = (decls, prop, valueRe) =>
    new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*${valueRe}\\s*(?:;|$)`, 'm').test(decls);

/** ① 的判据本体：一个盒子要真能滚，必须**两件同时在场**——确切高度 + 非 visible 的溢出。
 *  抽成函数是为了能拿"修复前的真实形状"再跑一遍（反向对照）。 */
function scrollable(decls) {
    const height = hasDecl(decls, 'height', '(100%|100vh|\\d+(px|vh|rem))');
    const over = hasDecl(decls, 'overflow(-y)?', '(auto|scroll)');
    return { ok: height && over, height, over };
}

console.log('\n① 页签容器 .allin：滚动容器必须**有确切高度**（这才是当初缺的那件）');
const ucCss = sass.compile(SRC('pages', 'Dashboard', 'UserControl', 'index.sass')).css.toString();
const allin = ruleOf(ucCss, '.allin');
check('取到了 .allin 的声明块', allin.length > 0, allin.slice(0, 60));
const sc = scrollable(allin);
check('★ .allin 同时有确切高度与 overflow ⇒ 内容超高时是"滚"，不是"被裁"',
    sc.ok, `height=${sc.height} overflow=${sc.over}`);

// 反向对照（无头验证法）：把**修复前的真实形状**（内联 style 只写了 overflowY、无高度）
// 喂给同一个判据，必须当场判红 —— 否则这条判据是空的，它只是恒真。
const BEFORE = 'padding: 20px; overflow-y: scroll;';
check('★ 反向对照：只写 overflow、没有高度的那个旧形状会被判红（判据不是恒真）',
    scrollable(BEFORE).ok === false, JSON.stringify(scrollable(BEFORE)));

console.log('\n② 高度链的前提住在 index.css 里（少一环，上面那条当场退化）');
const dashCss = readFileSync(SRC('pages', 'Dashboard', 'index.css'), 'utf8');
check('.ant-card .ant-card-body 给到 height:100%（.allin 的 100% 靠它才有意义）',
    /\.ant-card \.ant-card-body\s*\{[^}]*height:\s*100%/s.test(dashCss));
check('卡片确实是"固定高度 + 裁溢出"（这就是必须有个滚动的容器兜住的原因）',
    /\.Card\s*\{[^}]*overflow:\s*hidden/s.test(dashCss));

console.log('\n③ 面板自身与日志区：不许再叠一层滚动、不许把日志写死高度');
const grCss = sass.compile(SRC('pages', 'Dashboard', 'UserControl', 'GraphRebuild.sass')).css.toString();
const panel = ruleOf(grCss, '.graphRebuild');
check('取到了 .graphRebuild 的声明块', panel.length > 0);
check('★ .graphRebuild 自己**不设高度、不设 overflow**（否则内外两层滚动条，'
    + '滚轮在外层永远到不了日志的其余部分）',
    !hasDecl(panel, 'height', '.+') && !hasDecl(panel, 'overflow(-y)?', '.+'), panel.slice(0, 80));
const log = ruleOf(grCss, '.graphRebuild .grLog');   // sass 嵌套编译出来的就是复合选择器
check('取到了 .grLog 的声明块', log.length > 0);
check('★ 日志区用 max-height 封顶（长日志自己滚），**不写死 height**'
    + '（写死＝短日志也被关在一个矮框里、"看不全"原样保留）',
    hasDecl(log, 'max-height', '.+') && !hasDecl(log, 'height', '.+')
    && hasDecl(log, 'overflow(-y)?', '(auto|scroll)'), log.slice(0, 90));

console.log('\n④ 内联 style 不许回潮（内联 + 无高度＝那行声明形同虚设，正是本次的成因）');
const ucTsx = readFileSync(SRC('pages', 'Dashboard', 'UserControl', 'index.tsx'), 'utf8');
const allinTag = /<div([^>]*className='allin'[^>]*)>/.exec(ucTsx);
check('取到 .allin 那个 div 的开标签', Boolean(allinTag), allinTag ? allinTag[1] : '');
check('★ .allin 的开标签上**没有内联 style**（padding/overflow 都在 index.sass 里）',
    Boolean(allinTag) && !/style=/.test(allinTag[1]), allinTag && allinTag[1].trim());
// 页面本身也别再出现"内联 overflowY"（那是本仓点过名的头号敌人，且这次就是它骗过了所有人）
check('UserControl 的 TSX 里不再出现内联 overflow',
    !/overflow[XY]?\s*:/.test(ucTsx.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));

console.log(`\ngraph-rebuild-panel: ${FAILS.length ? FAILS.length + ' 条红' : '全绿'}`);
process.exit(FAILS.length ? 1 : 0);

// Site settings preserve the dashboard scroll chain.
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

function ruleOf(css, selector) {
    const re = new RegExp(`(?:^|[}{])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
    const m = re.exec(css);
    return m ? m[1] : '';
}

/** 一条声明是否在场（`prop` 与取值都按**声明**匹配，不做子串搜索）。 */
const hasDecl = (decls, prop, valueRe) =>
    new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*${valueRe}\\s*(?:;|$)`, 'm').test(decls);

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

const BEFORE = 'padding: 20px; overflow-y: scroll;';
check('★ 反向对照：只写 overflow、没有高度的那个旧形状会被判红（判据不是恒真）',
    scrollable(BEFORE).ok === false, JSON.stringify(scrollable(BEFORE)));

console.log('\n② 高度链的前提住在 index.css 里（少一环，上面那条当场退化）');
const dashCss = readFileSync(SRC('pages', 'Dashboard', 'index.css'), 'utf8');
check('后台外层卡片与共享内容区延续高度链，不把 100% 强加给所有嵌套卡片',
    /\.Card > \.ant-card-body\s*\{[^}]*height:\s*100%/s.test(dashCss)
    && scrollable(ruleOf(dashCss, '.dashboardPage')).ok);
check('卡片确实是"固定高度 + 裁溢出"（这就是必须有个滚动的容器兜住的原因）',
    /\.Card\s*\{[^}]*overflow:\s*hidden/s.test(dashCss));

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

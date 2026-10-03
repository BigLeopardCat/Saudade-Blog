// ═ 首页卡片入场动画：**缓存命中时不许再放一遍**（20261004 用户第十一报）══
//   node tests/home-enter-animation.test.mjs      （CI 秒级套件，靠 `npm test` 自动带上）
//
// 现场（用户原话）：「每次回到首页都有卡片一张张出来的动画，明明已经加载缓存好了吧，
// 那过渡动画纯纯耗时影响体验」。
//
// 根因是两层的，两边都得钉住：
//   ① `Article` 的 `isVisible` 初值是 `false`、由 IntersectionObserver 置位，且
//      framer-motion 的 `initial={{opacity:0,y:-20}}` + `delay: index * 0.2` 在**每次挂载**
//      都跑一遍 —— 包括数据本来就是从模块级缓存同步拿到的那些挂载。卡片于是"先一片空白、
//      再一张张冒出来"，纯等待、零信息。
//   ② 延迟**不封顶**：`delay: index * 0.2` 按序号线性长，第 20 张卡要等 4 秒才淡入，
//      而它的 `isVisible` 又是"滚到它跟前"才置位的 —— 到底等多久由一个跟可见性无关的
//      序号决定。
//
// 这两条都**不会**让页面报错、也不会让任何东西崩，只是"白白多花几秒"：除了拿秒表量
// （`article-card-hover.test.py` 那类几何沙箱量不了时间轴），就只剩源码结构能拦。所以本套件
// 判的是"那条决策写在该在的地方"，尤其是**负空间**：`initial` 一旦从 `false` 那支退回
// 对象字面量，或者延迟那条 `Math.min` 被拿掉，这里必须当场红。
//
// ⚠️ 不测"缓存里到底存了什么"：那是 `ContentHome` 的运行期行为，桩一份 `location`/`redux`
// 进来只会测到桩自己。这里只锁**接线**，与 `article-grid.test.mjs` / `article-card-hover.test.mjs`
// 的分工一致。
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');            // frontend/
const HOME_TSX = path.join(root, 'src/frontHome/Content/ContentHome/index.tsx');
const ARTICLE_TSX = path.join(root, 'src/frontHome/Content/ContentHome/Article.tsx');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

/** 剥掉注释再判结构。⚠️ 不是洁癖：`Article.tsx` 的注释里**逐字写着**旧写法
 *  （"原来是 `delay: index * 0.2` 且不封顶"），不剥的话每一条负空间断言都会
 *  命中注释自己 —— 判据变成"注释里有没有这句话"，跟代码写没写对无关。
 *  这套件的初版就是这么假红的（`delay: index *` 那条量到的是注释）。 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const home = strip(readFileSync(HOME_TSX, 'utf8'));
const article = strip(readFileSync(ARTICLE_TSX, 'utf8'));

console.log('\n① 决策点：`enterAnimation` 在挂载时冻结，判据是"这一屏是不是现拉的"');
{
    // **必须是 useState 的初始化函数**：写成每次渲染都算的表达式，值中途翻转时
    // 已渲染卡片的 `initial` 语义会一半一半（`Article` 里 `isVisible` 的初值也跟着错）。
    const m = home.match(/const \[enterAnimation\] = useState\((.+?)\)\s*$/m);
    ok(!!m, '`const [enterAnimation] = useState(...)` 存在（挂载时冻结，不是每次渲染重算）', m && m[0]);
    const init = m ? m[1] : '';
    ok(/^\s*\(\)\s*=>/.test(init), '  初值给的是**函数**（惰性求值；写成裸值就是每次渲染算一次）', init);
    ok(/isCachedOther/.test(init) && /cachedOtherArticles\.length\s*>\s*0/.test(init),
        '  判据 = 模块级缓存命中（`isCachedOther` 且缓存非空）', init);
    ok(!/\btrue\b\s*$/.test(init.replace(/\s/g, '')),
        '  没有退化成恒 `true`（恒真 = 缓存命中时照旧一张张冒）', init);
}

console.log('\n② 接线：这个值真的传给了每一张卡');
{
    const tag = home.match(/<Article\b[^>]*\/?>/)?.[0] || '';
    ok(/\benter=\{enterAnimation\}/.test(tag),
        '`<Article ... enter={enterAnimation} />`（少这一处，上面的决策就是个没人读的变量）', tag);
    // 反面：`enter={true}` / 不传参都会静默回到旧行为
    ok(!/\benter=\{(true|!false)\}/.test(home), '  没有别处写死 `enter={true}`');
}

console.log('\n③ Article：不放入场那一档必须"起手即终态"，不是"动画时长 0"');
{
    ok(/enter\s*=\s*true\s*\}/.test(article) || /enter\s*=\s*true\s*[,}]/.test(article),
        '默认值仍是 `enter = true`（别的调用点不传参时行为不变）');
    // `initial={false}` 是 framer-motion 的"不做入场动画、直接以 animate 的值渲染"。
    // 写 `{}` 或 `{opacity:1,y:0}` 都拦不住它先渲染 initial 那一帧。
    ok(/initial=\{enter\s*\?\s*\{[^}]*\}\s*:\s*false\}/.test(article),
        '`initial={enter ? {…} : false}`（那一档恒为 `false` 字面量）',
        article.match(/initial=\{[^\n]*\}/)?.[0]);
    ok(!/initial=\{\{\s*opacity:\s*0/.test(article.replace(/enter\s*\?\s*/, '')),
        '  没有"无条件 opacity:0"的 initial（那正是每次回来都白屏的写法）');
    ok(/useState\(!enter\)/.test(article),
        '`isVisible` 初值取反于 `enter`（不起手就可见的话，封面图那道 `{isVisible && …}` 门是关的）',
        article.match(/useState\([^)]*\)/)?.[0]);
    ok(/if\s*\(!enter\)\s*return;?/.test(article),
        '不放入场那一档直接不建 IntersectionObserver（省掉观察器）');
    ok(/\[enter\]/.test(article), '观察器的 effect 依赖里有 `enter`（否则切换档位不重建）');
}

console.log('\n④ 延迟封顶：最坏 0.5s，不是"按下标线性长"');
{
    ok(/ENTER_DELAY_STEP\s*=\s*0\.1/.test(article) && /ENTER_DELAY_MAX_STEPS\s*=\s*5/.test(article),
        '两个常量是 0.1 / 5');
    // 取到行尾而不是"到下一个逗号"：`Math.min(index, …)` 自己就带逗号，
    // 用 `[^,]+` 会在括号里切断、把一条正确的写法判红（初版踩过）。
    const d = article.match(/delay:\s*([^\n]+)/)?.[1] || '';
    ok(/Math\.min\(\s*index\s*,\s*ENTER_DELAY_MAX_STEPS\s*\)\s*\*\s*ENTER_DELAY_STEP/.test(d),
        '`delay: Math.min(index, ENTER_DELAY_MAX_STEPS) * ENTER_DELAY_STEP`', d);
    ok(!/delay:\s*index\s*\*/.test(article),
        '  没有裸 `delay: index * …`（不封顶：第 20 张卡 4 秒后才有影子）');
    // 上界复核（不引 react）：两个常量相乘必须 ≤ 0.5s，且**不许**是 0
    const step = parseFloat(article.match(/ENTER_DELAY_STEP\s*=\s*([\d.]+)/)?.[1] ?? 'NaN');
    const maxSteps = parseFloat(article.match(/ENTER_DELAY_MAX_STEPS\s*=\s*([\d.]+)/)?.[1] ?? 'NaN');
    ok(step > 0 && maxSteps > 0 && step * maxSteps <= 0.5,
        `  最坏延迟 ${step} × ${maxSteps} = ${(step * maxSteps).toFixed(2)}s ≤ 0.5s`);
}

console.log(`\n${fail ? '✗' : '✓'} home-enter-animation：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

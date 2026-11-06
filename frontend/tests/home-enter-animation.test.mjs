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

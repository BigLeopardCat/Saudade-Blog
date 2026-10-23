// Cross-language legacy contract for reactive talk deep links.
// Search behavior and models moved to tests/unit/aggregate-search.test.tsx and browser/aggregate-search.spec.ts.

import { readFileSync } from 'fs';

import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');       // frontend/
const read = (p) => readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (got, want, name) => ok(got === want, name, got === want ? undefined : { got, want });

/** 剥注释：本文件的注释**刻意**引用反例（"不能是挂载时读一次地址栏"），
 *  不剥的话"不许出现"那类断言会被自己的注释判红。 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\n⑦ 源码契约：说说深链读的是响应式 searchParams');
{
    const talk = strip(read('src/frontHome/Content/Talk/index.tsx'));
    ok(/useSearchParams/.test(talk), '★ 用 useSearchParams（不是挂载时读一次地址栏）',
        talk.match(/import.*react-router-dom[^;]*/)?.[0]);
    ok(/searchParams\.get\(\s*'tk'\s*\)/.test(talk), '读的是 tk 参数',
        talk.match(/searchParams\.get\([^)]*\)/)?.[0]);
    ok(/Number\(searchParams\.get\('tk'\)\)\s*\|\|\s*0/.test(talk),
        'tk 过 Number 且空值归 0（`?tk=abc` 不该当成"定位到 NaN 号"）');
    // 高亮/滚动的入口：行上的 id 与 effect 里查的 id 必须是同一个拼法
    ok(/id=\{`t-\$\{talk\.talkKey\}`\}/.test(talk), '★ 卡片上的锚点 id = `t-${talk.talkKey}`',
        talk.match(/id=\{`[^`]*`\}/g));
    ok(/getElementById\(`t-\$\{tk\}`\)/.test(talk), '★ effect 按同一个拼法找元素',
        talk.match(/getElementById\([^)]*\)/)?.[0]);
    ok(!/window\.location/.test(talk),
        '★ 整页不看 window.location（`/talk → /talk?tk=5` 是同路由，那种读法会静默不定位）');
    // 入场错峰：深链落到第二十张时那张卡还在位移中，scrollIntoView 会量到位移中的盒子
    ok(/delay:\s*tk\s*\?\s*0\s*:/.test(talk),
        '★ 带 tk 时入场 delay 压成 0（否则目标卡还没落位就滚）',
        talk.match(/delay:[^,}]*/)?.[0]);
    ok(/talk-hit/.test(talk), '定位后会闪一下高亮（talk-hit）');
    // `key={index}` 换成 talkKey：深链定位过程中重排不该让卡片换身份
    ok(/key=\{talk\.talkKey\}/.test(talk), '列表 key 用 talkKey（不是 index）');
}


if (fail) process.exit(1);

// ═ 站内聚合搜索（文章 / 说说 / 留言 / 评论）：跳转目标 + 接线契约（20261006）══
//   node tests/site-search.test.mjs
//
// 用户原话：「主页那个检索框升级成聚合检索，不止检索文章，还有说说，留言，评论，然后
// "搜索结果（命中数量）"后面跟上文章（）说说（）留言（）评论（）各种命中数量，单击选中
// 就是筛选对应项。结果列表各自出现的条目点击要能转跳过去。」
//
// 本套件守的是这句话里**最容易静默坏掉**的两半：
//
//   ① `aggregate.ts::hitTarget` ——「点得动能转跳」的唯一出处。四类四条路径，写错一条
//      的症状是"某一类点了没反应 / 跳错地方"，不报错、不白屏，编译也照样过。
//   ② 接线：搜索框打的是新端点、计数栏用固定顺序渲染、说说读的是**响应式**的
//      `useSearchParams`（不是"挂载时读一次地址栏"——`/talk → /talk?tk=5` 是同一条路由，
//      那种写法在已处于 `/talk` 时**静默不定位**，页面上看不出任何异常）。
//
// 真渲染（点行真跳、计数栏折行）由 `tests/site-search.test.py` 的沙箱负责；这里只钉模型
// 与源码契约，跑在 `run-suites.mjs` 里进 CI。
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
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

/** `aggregate.ts` 是**不依赖 React、不碰网络**的纯模块，单文件 esbuild 打成 ESM 直接 import
 *  ——本机禁止 `vite build`（3.7GB 内存会 OOM），单文件 esbuild 是既定替代手段（同 wordgraph）。 */
const out = mkdtempSync(path.join(tmpdir(), 'sst-'));
const bundle = path.join(out, 'aggregate.mjs');
execFileSync(path.join(root, 'node_modules/.bin/esbuild'), [
    path.join(root, 'src/frontHome/Head/aggregate.ts'),
    '--bundle', '--format=esm', '--platform=neutral',
    `--outfile=${bundle}`, '--log-level=error',
], { stdio: ['ignore', 'ignore', 'inherit'] });
const agg = await import(bundle);

/** 造一条命中（只给断言关心的字段）。 */
const hit = (type, key, noteId = null) => ({
    type, key, title: '', snippet: '', author: '', noteId, createTime: '',
});

console.log('\n① 四类的类型、标签、固定顺序');
{
    eq(agg.TYPE_ORDER.join(','), 'note,talk,board,comment', '★ 顺序写死 note→talk→board→comment（不按命中数排）');
    eq(agg.TYPE_LABEL.note, '文章', 'note 的标签是「文章」');
    eq(agg.TYPE_LABEL.talk, '说说', 'talk 的标签是「说说」');
    eq(agg.TYPE_LABEL.board, '留言', 'board 的标签是「留言」');
    eq(agg.TYPE_LABEL.comment, '评论', 'comment 的标签是「评论」');
    // 计数栏上那四枚就是按这个数组渲染的 ⇒ 顺序即用户看到的顺序，扩成 5 类也会在这里露头
    eq(agg.TYPE_ORDER.map((t) => agg.TYPE_LABEL[t]).join('/'), '文章/说说/留言/评论',
        '按 TYPE_ORDER 取标签 = 用户看到的四枚计数（顺序一致）');
}

console.log('\n② hitTarget：四类四条路径（"点得动能转跳"的唯一出处）');
{
    eq(agg.hitTarget(hit('note', 5)), '/article/5', '★ 文章 → /article/5');
    eq(agg.hitTarget(hit('talk', 9)), '/talk?tk=9', '★ 说说 → /talk?tk=9');
    eq(agg.hitTarget(hit('board', 8)), '/guestbook?lid=8', '★ 留言 → /guestbook?lid=8');
    eq(agg.hitTarget(hit('comment', 41, 5)), '/article/5?cid=41', '★ 评论 → /article/5?cid=41');

    // 四条路径**互不相同**：全部写成同一个的话上面四条里必然有两条同值 ⇒ 这里再钉一次
    // "不是复制粘贴改漏了一个"。
    const set = new Set(['note', 'talk', 'board', 'comment'].map((t) => agg.hitTarget(hit(t, 7, 7))));
    eq(set.size, 4, '四类落在四条第**不同**的路径上（复制粘贴改漏一类会被这条抓住）');

    // 前三条都是绝对路径（弹窗在每一页都开着，相对路径会拼错，见 aggregate.ts 的注释）
    for (const t of ['note', 'talk', 'board']) {
        ok(agg.hitTarget(hit(t, 3)).startsWith('/'), `${t} 的目标以 / 开头（绝对路径，不在当前路由上叠加）`);
    }
    // 评论没有 `noteId` 时不许拼出 `/article/null?cid=…` 那种必 404 的地址
    eq(agg.hitTarget(hit('comment', 41, null)), '/', '★ 评论缺 noteId ⇒ 回首页，不拼 /article/null?cid=41');
    eq(agg.hitTarget(hit('comment', 41, 0)), '/', 'noteId=0 与 null 同档（都是"没有"）');
}

console.log('\n③ hitsOf：字段名的复数陷阱只在这一处映射');
{
    const r = {
        total: 4,
        counts: { note: 1, talk: 1, board: 1, comment: 1 },
        notes: [hit('note', 1)], talks: [hit('talk', 2)],
        board: [hit('board', 3)], comments: [hit('comment', 4)],
    };
    eq(agg.hitsOf(r, 'note')[0].key, 1, 'note 取 r.notes');
    eq(agg.hitsOf(r, 'talk')[0].key, 2, 'talk 取 r.talks（复数）');
    eq(agg.hitsOf(r, 'board')[0].key, 3, 'board 取 r.board（**不是** r.boards）');
    eq(agg.hitsOf(r, 'comment')[0].key, 4, 'comment 取 r.comments（复数）');
    // 后端漏字段 / 老响应体：宁可空列表，不许 undefined 让 `.map` 炸掉整个弹窗
    eq(agg.hitsOf({}, 'board').length, 0, '字段缺席 ⇒ 空数组（不是 undefined）');
    eq(agg.hitsOf({}, 'comment').length, 0, '字段缺席 ⇒ 空数组（复数那两支同样兜住）');
}

console.log('\n④ allHits：分组序 = TYPE_ORDER，组内保持服务端的相关度序');
{
    const r = {
        notes: [hit('note', 11), hit('note', 12)],
        talks: [hit('talk', 21)],
        board: [hit('board', 31)],
        comments: [hit('comment', 41), hit('comment', 42)],
    };
    eq(agg.allHits(r).map((h) => h.type + ':' + h.key).join(' '),
        'note:11 note:12 talk:21 board:31 comment:41 comment:42',
        '★ 文章→说说→留言→评论、同类相邻、组内不打乱');
    eq(agg.allHits({}).length, 0, '全空 ⇒ 空列表');
    // 「全部」那一列 = 四类计数之和；这条与后端 total==sum(counts) 对得上，前端不该自己重算
    eq(agg.allHits(r).length, r.notes.length + r.talks.length + r.board.length + r.comments.length,
        '全部列表长度 = 四类之和（与计数栏显示的数同源）');
}

console.log('\n⑤ 源码契约：取数打的是新端点');
{
    const api = strip(read('src/apis/SearchMethods.tsx'));
    ok(api.includes("'/api/public/search'"), '★ SearchMethods 打的是 /api/public/search',
        api.match(/url:\s*'[^']*'/)?.[0]);
    ok(!api.includes('/api/public/notes/search'),
        '聚合这条通道**不**去动只搜文章的旧端点（它还是 agent 的 search_notes 工具 + 分类页）');
    ok(/method:\s*'POST'/.test(api), '是 POST（后端挂的是 post(search::search_all)）');
    // `keyword` 缺席时后端回空结果 ⇒ 调用方不必自己挡；这里钉住参数名没被改成 q/query
    ok(/keyword/.test(api), '参数名是 keyword（与后端请求体同名）');
}

console.log('\n⑥ 源码契约：Head 接了聚合通道，且没有偷偷退回只搜文章');
{
    const head = strip(read('src/frontHome/Head/index.tsx'));
    ok(/import\s*\{\s*searchAll\s*\}\s*from\s*["'][^"']*SearchMethods/.test(head),
        '★ Head 引的是 searchAll（聚合）', head.match(/import.*SearchMethods[^;]*/)?.[0]);
    ok(/await searchAll\(/.test(head), 'performSearch 里真的 await searchAll(...)');
    ok(!/searchNotes/.test(head), '★ Head 里**不再**出现 searchNotes（退回只搜文章要在这里变红）');
    // 结果落 state 前必须判业务码：本站信封是 code，只看 status 会把 code=500 渲染成"没搜到"
    ok(/res\.status === 200 && res\.data\?\.code === 200/.test(head),
        '★ 成功态判的是 status + code 两层', head.match(/res\.status === 200[^\n]*/)?.[0]);
    ok(/setSearchFailed\(true\)/.test(head) && head.includes('搜索失败'),
        '失败有独立文案（不与"未找到相关内容"同形）');
    // 计数栏：四枚按 TYPE_ORDER 渲染、标签走 TYPE_LABEL、选中态是 `is-active`
    ok(/TYPE_ORDER\.map\(/.test(head), '四枚计数按 TYPE_ORDER 渲染');
    ok(/\{TYPE_LABEL\[t\]\}（\{/.test(head) || /TYPE_LABEL\[t\]/.test(head),
        '计数上的标签走 TYPE_LABEL（一处映射，没有第二份中文字面）');
    ok(head.includes('搜索结果（'), '标题是「搜索结果（N）」写法');
    ok(/is-active/.test(head), '选中那一枚有 is-active 类');
    ok(/toggleType/.test(head), '点计数调用 toggleType');
    // 「点一条结果要能转跳过去」——跳转目标**只能**来自 hitTarget
    ok(/navigate\(hitTarget\(item\)\)/.test(head), '★ 点行 navigate(hitTarget(item))',
        head.match(/navigate\([^)]*\)/g)?.slice(-2));
    ok(!/navigate\(\s*['"`]?article\//.test(head),
        '★ 不再有相对的 navigate("article/…")（在 /article/3 上会拼成 /article/article/5）');
}

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

console.log(`\n${pass}/${pass + fail} 项通过`);
if (fail) process.exit(1);

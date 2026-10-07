// ═ 文章评论：渲染安全 + 结构契约（20261002）══
//   node tests/comment-render.test.mjs
//
// 讨论区是**第一个把访客输入原样存库、再原样渲染到别人浏览器里**的功能。
// 所以这里分两半钉：
//
// ① **真跑一遍渲染管线**（把 `src/utils/chatMarkdown.ts` 用 esbuild 打成 ESM 再 import，
//    同 `wordgraph-engine.test.mjs` 的既定做法——本机禁止 vite build）：喂 `<script>`、
//    `<img onerror>`、`javascript:` 链接进去，断言出来的 HTML 里真的没有它们；
//    再喂 `:头疼:` 与 `**粗体**`，断言表情包与 markdown 都还在（防线不能顺手把功能也剥了）。
//    这一半是**行为**断言——注释写得再对也只是注释。
//
// ② **源码契约**：`dangerouslySetInnerHTML` 这个入口在全组件里只能有一处、且内容必须是
//    `renderBlogMarkdown()` 的产物。第二处就是"哪天有人图省事直接塞原文"，而那时
//    sanitize 已经被绕过去了——① 却照样是绿的（它测的是管线，不是调用点）。
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '..');            // 父仓根（Rust 源码）
const read = (p) => readFileSync(path.join(repo, p), 'utf8');

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
/** 剥注释后计数——本仓注释**刻意**引用反例（例如头注里那句「不许直接 innerHTML」） */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const count = (s, needle) => strip(s).split(needle).length - 1;
/** 取一个顶层函数的函数体（从 marker 后第一个 `{` 起做花括号配对，配平处即函数尾）——
 *  同 `review-gate-single-source.test.mjs` 的 `bodyOf`：判"哪个函数里调了它"必须按函数体切，
 *  扫全文会把定义处与另一条路径的调用一起算进来 */
function bodyOf(src, marker) {
    const i = src.indexOf(marker);
    if (i < 0) return '';
    let j = src.indexOf('{', i);
    if (j < 0) return '';
    let depth = 0;
    for (let k = j; k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(j + 1, k); }
    }
    return '';
}

// ── ① 真跑管线 ─────────────────────────────────────────────────────────────
// chatMarkdown.ts 顶层会往 window 上挂两个全局（:271-273），import 前先备好壳
globalThis.window ??= {};
const out = mkdtempSync(path.join(tmpdir(), 'cmt-'));
const bundle = path.join(out, 'chatMarkdown.mjs');
// `--platform=node`（不是 wordgraph 那支用的 neutral）：这条管线链着 math/mermaid 两个插件，
// 它们要 node 内建模块（path/process）。平台只影响打包器的解析策略，产物仍是 ESM。
execFileSync(path.join(root, 'node_modules/.bin/esbuild'), [
    path.join(root, 'src/utils/chatMarkdown.ts'), '--bundle', '--format=esm',
    '--platform=node', `--outfile=${bundle}`, '--log-level=error',
], { stdio: ['ignore', 'ignore', 'inherit'] });

const { renderBlogMarkdown } = await import(bundle);

console.log('渲染管线 —— 危险输入被剥掉：');
{
    const s = renderBlogMarkdown('<script>alert(1)</script>');
    ok(!/<script/i.test(s), '<script> 不出现在输出里', s);
}
{
    const s = renderBlogMarkdown('<img src=x onerror="alert(1)">');
    ok(!/onerror/i.test(s), '行内 onerror 属性被剥掉（标签本身可以留）', s);
}
{
    const s = renderBlogMarkdown('<a href="javascript:alert(1)">点我</a>');
    ok(!/javascript:/i.test(s), 'javascript: 协议的链接被剥掉', s);
}
{
    const s = renderBlogMarkdown('[点我](javascript:alert(1))');
    ok(!/javascript:/i.test(s), 'markdown 语法写的 javascript: 链接同样被剥掉', s);
}
{
    const s = renderBlogMarkdown('<iframe src="https://evil.example"></iframe><svg onload=alert(1)></svg>');
    ok(!/<iframe/i.test(s) && !/onload/i.test(s), 'iframe / svg onload 都被剥掉', s);
}
{
    const s = renderBlogMarkdown('<style>body{display:none}</style>');
    ok(!/<style/i.test(s), '<style> 被剥掉（否则一条评论能改全站样式）', s);
}
{
    // 反向：管线不是"什么都剥"——剥过头会把讨论区变成一个只能看纯文本的地方
    const s = renderBlogMarkdown('**粗体**');
    ok(/<strong>粗体<\/strong>/.test(s), 'markdown 粗体照常渲染', s);
}
{
    const s = renderBlogMarkdown('第一行\n第二行');
    ok(/<br\s*\/?>/.test(s), '换行照常渲染（breaks 插件）', s);
}
{
    // **整条评论只有一个表情**——用表情回一句"贴贴"是最常见的用法，
    // 也正是 20261002 修掉的那个判据洞（旧代码 `pieces.length > 1` 会跳过替换）
    const s = renderBlogMarkdown(':头疼:');
    ok(/<img[^>]*src="\/stickers\/touteng\.png"/.test(s), '单独一个 :名字: 也渲染成 <img>（不留字面文本）', s);
    ok(/class="sticker"/.test(s), '表情 img 带 class="sticker"（尺寸样式靠它）', s);
    const s2 = renderBlogMarkdown('贴贴 :贴贴: 啦');
    ok(/<img[^>]*src="\/stickers\/tietie\.png"/.test(s2) && /贴贴\s/.test(s2),
        '句子中间的表情同样转换，前后文字保留', s2);
    // 20261008 新增那四枚：名字在清单里、素材路径也接上了（只加名字忘了放图会在这里露）
    const s3 = renderBlogMarkdown(':比心: :困困: :躺平: :嫌弃:');
    ok(['bixin', 'kunkun', 'tangping', 'xianqi'].every((f) => s3.includes(`/stickers/${f}.png`)),
        '20261008 新增的四枚（比心/困困/躺平/嫌弃）都渲染成图', s3);
}
{
    // 未知的 :xx: 原样保留（stickers.ts 的既定语义），不该被当成表情
    const s = renderBlogMarkdown(':没这个表情:');
    ok(!/<img/.test(s), '清单外的 :名字: 不转换', s);
}

// ── ② 源码契约 ─────────────────────────────────────────────────────────────
const comp = read('frontend/src/components/CommentSection/index.tsx');
const picker = read('frontend/src/components/CommentSection/StickerPicker.tsx');
const readArticle = read('frontend/src/frontHome/Content/ReadArticle/index.tsx');
const rustComments = read('src/routes/comments.rs');

console.log('\n组件 —— 渲染出口只有一处，且只吃管线产物：');
ok(count(comp, 'dangerouslySetInnerHTML') === 1,
    '整个组件只有一处 dangerouslySetInnerHTML', count(comp, 'dangerouslySetInnerHTML'));
ok(/dangerouslySetInnerHTML=\{\{\s*__html:\s*html\s*\}\}/.test(comp),
    '那一处的 __html 吃的是管线产物（不是评论原文）');
ok(comp.includes('const html = useMemo(() => renderBlogMarkdown(content)'),
    '产物由 renderBlogMarkdown 生成');
ok(/from '\.\.\/\.\.\/utils\/chatMarkdown'/.test(comp),
    '用的是站内那条共享管线（文章页 Viewer / 看板娘同一个实现）');
ok(count(comp, 'renderBlogMarkdown') === 2,
    'renderBlogMarkdown 只出现两处：import 与调用（多出来就是第二份渲染实现）',
    count(comp, 'renderBlogMarkdown'));
ok(!/\.innerHTML\s*=/.test(strip(comp)), '没有对评论原文直接 innerHTML');
ok(!/escapeHtml/.test(strip(comp)), '没有在这里另写一份 escapeHtml');

console.log('\n组件 —— 表情包清单不抄第二份：');
ok(picker.includes('STICKER_NAMES') && picker.includes('STICKERS'),
    '选择器遍历 utils/stickers.ts 的清单（新增表情只改那一处）');
ok(!/头疼|委屈|害羞|比耶|犯错|生气|贴贴|震惊|困困|躺平|嫌弃|比心/.test(strip(picker)),
    '选择器里没有硬编码的表情名');
ok(picker.includes('onPick(name)') && /`:\$\{name\}:`/.test(strip(picker)),
    '选中只回名字，由调用方拼成 :名字: 文本');
ok(!/dangerouslySetInnerHTML|innerHTML/.test(strip(picker)),
    '选择器不碰 HTML（插标签就等于从侧门绕过 sanitize）');

console.log('\n组件 —— 长度上限与后端同源：');
const rustMax = rustComments.match(/const MAX_COMMENT_CHARS: usize = (\d+);/);
const tsMax = comp.match(/const MAX_COMMENT_CHARS = (\d+)/);
ok(!!rustMax && !!tsMax, '两侧都定义了 MAX_COMMENT_CHARS', { rust: rustMax?.[1], ts: tsMax?.[1] });
ok(rustMax && tsMax && rustMax[1] === tsMax[1],
    '前端上限 == 后端上限（前端更松就会让用户提交后才被拒）', { rust: rustMax?.[1], ts: tsMax?.[1] });

console.log('\n组件 —— 三种审核结果说三种话：');
ok(comp.includes("if (approved === 1) message.success('评论已发布')"), '已公开 → 说"已发布"');
ok(/approved === 0\) message\.info\(/.test(comp), '待人工复核 → 另说一句（不含"已发布"）');
ok(/message\.warning\('评论未通过审核/.test(comp), '未通过 → 如实说未通过');
ok(rustComments.includes('pub approved: i8') && rustComments.includes('approved,') ,
    '后端回传 approved（只回 id 的话前端只能含糊其辞）');

console.log('\n挂载点 —— 在正文之后：');
ok(readArticle.includes("import CommentSection from \"../../../components/CommentSection\""),
    'ReadArticle 引入了讨论区');
ok(readArticle.includes('<CommentSection noteId={id} />'), '挂在文章详情页上');
{
    // 挂载点在 `.readContent` 那个 div 之后（正文里，不是导航栏里）
    const at = readArticle.indexOf('<CommentSection noteId={id} />');
    const contentDiv = readArticle.lastIndexOf("className='readContent markdown-body'", at);
    ok(contentDiv > 0 && contentDiv < at, '出现在正文容器之后');
}

// ── ③ 回复通知与深链定位（20261002 第二笔）────────────────────────────────
// 通知这条链路最容易出的不是"发不出去"，而是**发重了**或**发早了**：
// 创建即通过与人工复核 0→1 是两条到达路径，各写一遍必然变成两条通知；
// 而"评论还没公开就通知"会把收件人送到一个找不到东西的页面上。
console.log('\n回复通知 —— 两条路径一个函数，判据都在函数外：');
const calls = count(rustComments, 'notify_comment_reply(');
ok(calls === 3, 'notify_comment_reply 共 3 次出现：1 处定义 + 2 处调用（创建 / 复核）', calls);
ok(/async fn notify_comment_reply\(/.test(rustComments), '函数定义在 comments.rs');
ok(/super::notice::push_notice\(/.test(rustComments), '走现成的 push_notice，不另写一套通知落库');
ok(rustComments.includes('Some(format!("/article/{note_id}?cid={comment_id}"))'),
    '深链格式 = /article/<文章 id>?cid=<评论 id>');
ok(rustComments.includes('super::talks::talk_brief('),
    '摘要复用留言板那条（截断长度只有一份实现）');
{
    const create = bodyOf(rustComments, 'pub async fn create_comment');
    const audit = bodyOf(rustComments, 'pub async fn audit_comment');
    ok(create.includes('notify_comment_reply('), '创建路径会发通知');
    ok(audit.includes('notify_comment_reply('), '人工复核 0→1 路径也会发通知');
    ok(/if was_approved != 1 && new_approved == 1/.test(audit),
        '复核路径只在"本次真的从不可见变成可见"时发（重复点按钮不重复通知）');
    ok(/\(1, Some\(t\)\) if t != uid/.test(create),
        '创建路径只在"已公开 + 是回复 + 不是回自己"时发');
    ok(audit.includes('if t != owner'), '复核路径同样挡掉自我回复');
    for (const [needle, why] of [
        ['review_notice_text', '留言板那条"审核结果"通知的文案映射'],
        ['guestbook?lid=', '留言板的深链'],
        ['push_notice_checked', '另一套通知落库出口'],
    ]) {
        ok(!create.includes(needle) && !audit.includes(needle), `评论通知里没有${why}的副本`);
    }
}
ok(!/notify_review_result/.test(rustComments),
    '审核结果通知**不发**给评论作者（没有「我的评论」入口，点进去看不到自己那条）——'
    + '要接就接在 audit_comment 那一处，别另起链路');

console.log('\n深链定位 —— 读 ?cid= 并滚到那一条：');
ok(comp.includes('useSearchParams'), '用路由的 searchParams 读参数（不是裸解析 location）');
ok(/const cid = Number\(searchParams\.get\('cid'\)\) \|\| 0/.test(comp),
    "参数名是 cid，取不到时是 0（不是 NaN——NaN 会一路传进 getElementById）");
ok(/locatedRef\.current === cid/.test(comp),
    '记的是"定位过哪个 cid"而不是布尔（同页再点另一条通知要能重新定位）');
ok(/document\.getElementById\(`c-\$\{cid\}`\)/.test(comp), '锚点选择器与行上的 id 同源');
ok(comp.includes('id={`c-${c.id}`}'), '每一行都带 #c-<id> 锚点');
ok(/scrollIntoView\(\{ block: 'center', behavior: 'auto' \}\)/.test(comp),
    '**瞬时**滚动（平滑滚动会被本页挂载时的 scrollToTop 顶掉）');
ok(comp.includes("el.classList.add('comment-hit')"), '加高亮类');
ok(/if \(!el\) return/.test(comp), '找不到那一条就安静兜底（页面已经打开了，不弹提示）');
const sass = read('frontend/src/components/CommentSection/index.sass');
ok(/&\.comment-hit\s*\n\s*animation: commentHit/.test(sass), '高亮类有对应动画');
ok(/@keyframes commentHit/.test(sass), '动画关键帧在同一份样式里（不散落到别处）');

console.log(`\ncomment-render: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);

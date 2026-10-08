// ═ 纯文本宿主的表情渲染：两个渲染器必须认出同一批表情（20261008）══
//   node tests/sticker-text.test.mjs
//
// 现场（用户原话）：「给个人中心的公告通知面板也提供表情包渲染，现在 agent 发过去的
// 通知带的表情包没有渲染」。个人中心的通知正文与公告弹窗是**纯文本宿主**（不跑 markdown，
// 换行靠 `white-space: pre-wrap`），此前直接 `{n.content}` ⇒ `:头疼:` 以字面量示人。
//
// 修法不是给它们接一整套 markdown（`.ucBodyText` 的 4 行夹取按行数算，塞个块级 `<p>`
// 进去就判不准了），而是**同一条清单、同一遍扫描、两种产物形状**：
//   · `splitStickerText`（私有）→ mdast 节点，喂 remark-rehype（文章/评论区那条路）；
//   · `splitStickers`（公开）→ 数据片段，喂 React（纯文本宿主那条路）。
//
// 本套件的中心判据是**两条路一致**：同一段文本，mdast 侧产出的 image 节点数必须等于
// 片段侧产出的 sticker 数。少了这条，改匹配规则只会改到一条路——而症状是"某个宿主里
// 表情时灵时不灵"，最难看出来的那种。
//
// 另一条判据是 20261002 那个已修缺陷的回归锁：**整段只有一个表情**时也必须替换
// （当时 mdast 侧用了 `pieces.length > 1` 当判据，于是"只发表情"渲染成字面文本）。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name, { got, want });

// 纯 TS（无 DOM 无 React）⇒ 摊平成 .mjs 直接 import（`import type { Root } from 'mdast'`
// 是类型导入，esbuild 直接抹掉，不引入任何依赖）
const out = mkdtempSync(path.join(tmpdir(), 'sticker-'));
const file = path.join(out, 'stickers.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/stickers.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
});
const { splitStickers, remarkStickers, STICKERS, STICKER_NAMES } = await import(pathToFileURL(file).href);

/** mdast 侧跑一遍，数产出多少个 image 节点（走的正是 remark 插件那条路） */
const mdastImages = (value) => {
    const tree = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value }] }] };
    remarkStickers()(tree);
    return tree.children[0].children.filter((n) => n.type === 'image');
};
const stickerCount = (value) => splitStickers(value).filter((p) => p.kind === 'sticker').length;

// ═══ 一、片段层的形状 ═══
console.log('\n── splitStickers ──');
{
    eq(splitStickers(''), [{ kind: 'text', text: '' }], '空串 ⇒ 一个空文本片段（不是空数组：调用方不必特判）');
    eq(splitStickers(':不存在的:'), [{ kind: 'text', text: ':不存在的:' }],
        '不在清单里的名字原样保留为文本（不转换成空 img）');
    eq(splitStickers(':smile:'), [{ kind: 'text', text: ':smile:' }],
        '**:smile: 不是本站表情**——ASCII 名字由 markdown 那条路的 gemoji 管，这里不认（两族别混）');
    eq(splitStickers(':1234567890123:'), [{ kind: 'text', text: ':1234567890123:' }],
        '名字超过 12 字 ⇒ 正则不认（长度上限就是为此设的：别把正文里的普通冒号对吃进来）');

    // 整段只有一个表情：**没有空文本片段**（20261002 那个缺陷的形状）
    eq(splitStickers(':头疼:'), [{ kind: 'sticker', name: '头疼', url: '/stickers/touteng.png' }],
        '整段只有一个表情 ⇒ 恰好一个 sticker 片段，不留空文本（此前正是这条渲染成了字面文本）');

    eq(splitStickers('晚安 :头疼: 好梦'), [
        { kind: 'text', text: '晚安 ' },
        { kind: 'sticker', name: '头疼', url: '/stickers/touteng.png' },
        { kind: 'text', text: ' 好梦' },
    ], '文本/表情/文本三段：**空格原样切在文本里**（不 trim，靠 pre-wrap 排版）');

    eq(splitStickers(':头疼::比耶:').map((p) => p.kind), ['sticker', 'sticker'],
        '两个表情紧挨着 ⇒ 中间不插空文本片段');
    ok(splitStickers(':头疼::比耶:').every((p) => p.kind === 'sticker'),
        '紧挨着的两个表情各自独立（第一刀的 : 不被第二个吃掉）');

    eq(splitStickers('a:b:c').map((p) => p.kind), ['text'], '半截冒号对（名字为空/含冒号）不误判');
}

// ═══ 二、清单本身：每个名字都能双向命中 ═══
console.log('\n── 清单 ──');
{
    ok(STICKER_NAMES.length === 12, `清单 12 个（20261008 口径），实测 ${STICKER_NAMES.length}`,
       { names: STICKER_NAMES });
    const bad = STICKER_NAMES.filter((n) => {
        const p = splitStickers(`:${n}:`);
        return p.length !== 1 || p[0].kind !== 'sticker' || p[0].url !== STICKERS[n];
    });
    eq(bad, [], '每个名字单独出现都命中自己那条素材路径');
    ok(STICKER_NAMES.every((n) => STICKERS[n].startsWith('/stickers/') && STICKERS[n].endsWith('.png')),
        '素材路径同族（/stickers/*.png —— index.css 的全局 img.sticker 与它同一族约定）');
    const dupes = STICKER_NAMES.filter((n, i) => STICKER_NAMES.indexOf(n) !== i);
    eq(dupes, [], '清单无重名');
}

// ═══ 三、两条路一致（本套件的中心判据）═══
console.log('\n── mdast 侧 ⇄ 片段侧 ──');
{
    const samples = [
        ':头疼:', '晚安 :头疼: 好梦', ':头疼::比耶:', '前后都贴着文字:比心:尾巴',
        ':不存在的: 与 :smile:', '', 'a:b:c', ':1234567890123:', '换行\n:委屈:\n第二行',
        `五个：:头疼::委屈::害羞::比耶::犯错:`,
    ];
    const mismatch = samples.filter((s) => mdastImages(s).length !== stickerCount(s));
    eq(mismatch, [], '同一段文本：mdast 的 image 节点数 == 片段层的 sticker 数（10 个样本）');

    // mdast 侧的产物形状（片段侧没有 class 这一层，那条走 React 的 className）
    const imgs = mdastImages('晚安 :头疼: 好梦');
    ok(imgs.length === 1 && imgs[0].url === '/stickers/touteng.png' && imgs[0].alt === '头疼',
        'mdast 侧：url 与 alt 都对（alt 是名字）');
    ok(imgs[0].data?.hProperties?.className?.[0] === 'sticker',
        'mdast 侧：<img> 带 class="sticker"（index.css 的全局尺寸规则认的就是它）');
    ok(mdastImages(':头疼:').length === 1,
        'mdast 侧整段只有一个表情也要替换（20261002 缺陷的回归锁：判据不能写成 pieces.length > 1）');

    // 代码里的 :xx: 不转表情（插件自写遍历靠"code/inlineCode 是叶子、无 children"实现）
    const codeTree = { type: 'root', children: [{ type: 'code', value: ':头疼:' }] };
    remarkStickers()(codeTree);
    ok(codeTree.children.length === 1 && codeTree.children[0].type === 'code',
        '代码块里的 :头疼: 不动（叶子节点没有 children，遍历自动跳过）');
}

// ═══ 四、接线锁：新宿主确实用了这条渲染器 ═══
// 判据再对，没接上也白搭——这三处是本次改动的真实落点。
console.log('\n── 接线 ──');
{
    const uc = readFileSync(path.join(root, 'src/components/UserCenter/index.tsx'), 'utf8');
    const ann = readFileSync(path.join(root, 'src/components/AnnouncementModal/index.tsx'), 'utf8');
    const comp = readFileSync(path.join(root, 'src/components/StickerText.tsx'), 'utf8');
    // 断言前先剥掉 CSS 注释：注释里为了讲道理会引用选择器文本（本条注释里就写着
    // `[src^="/stickers/"]`），不剥的话"源码文本"里到处都是判据自己
    const css = readFileSync(path.join(root, 'src/index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

    ok(/<StickerText text=\{n\.content\} \/>/.test(uc), '个人中心通知列表：正文过 StickerText');
    ok(/className="ucNoticeDetailBody">\s*<StickerText text=\{n\.content\}/.test(uc),
        '个人中心通知详情：正文同样过 StickerText（放大后不许退回字面量）');
    ok(/<StickerText text=\{pending\?\.content \|\| ''\} \/>/.test(ann),
        '公告弹窗：正文过 StickerText（同一条内容两处显示，不能只修个人中心）');
    ok(!/<div className="ucBodyText">\{n\.content\}<\/div>/.test(uc),
        '旧的裸文本渲染已经没有了（防止只加新的一处、旧的没删）');

    ok(/img\.sticker \{/.test(css) && !/img\[src\^="\/stickers\/"\]/.test(css),
        '全局尺寸规则只认 class（带 src 前缀那条会把评论区表情选择器的 <img> 拖进同优先级的平局）');
    ok(/height: 1\.8em/.test(css) && !/height/.test(comp),
        '四个值仍在 index.css 那一份里（组件只管结构，不写尺寸）');

    // 整行可点 + 两颗按钮必须拦住冒泡（不拦就是"点一下既标已读又展开详情"）
    ok(/className="ucNoticeRow"/.test(uc) && /onClick=\{\(\) => setNoticeOpenId\(n\.id\)\}/.test(uc),
        '通知整行可点 ⇒ 展开详情');
    ok((uc.match(/e\.stopPropagation\(\)/g) || []).length >= 2,
        '行内两颗按钮（去看看 / 标记已读）都 stopPropagation',
        { n: (uc.match(/e\.stopPropagation\(\)/g) || []).length });
    ok(/ucNoticeDetailFoot/.test(uc) && /标记为已读/.test(uc),
        '详情底部有「标记为已读」（主人点名的按钮）');

    const sass = readFileSync(path.join(root, 'src/components/UserCenter/index.sass'), 'utf8');
    const foot = sass.slice(sass.indexOf('.ucNoticeDetailFoot'), sass.indexOf('.ucCompose'));
    ok(/justify-content: center/.test(foot), '页脚**居中**（主人指定：居中，不是两端对齐）', { foot });
    ok(/min-height: 100%/.test(sass.slice(sass.indexOf('.ucNoticeDetail'), sass.indexOf('.ucNoticeDetailBar'))),
        '详情 min-height:100% ⇒ 真的占满窗格（不给它，一条两行的通知会缩成两行）');
}

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail) {
    console.error(`失败 ${fail} 条（临时目录留在 ${out}）`);
    process.exit(1);
}
rmSync(out, { recursive: true, force: true });

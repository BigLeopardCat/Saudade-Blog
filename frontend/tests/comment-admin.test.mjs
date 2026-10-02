// ═ 评论管理页（后台第四个页签）源码契约（20261002）══
//   node tests/comment-admin.test.mjs
//
// 这一页的全部风险都不在"画得对不对"，而在**它和留言管理长得太像**：两张表、两条接口、
// 两对审核开关、两套驳回理由预设，界面结构几乎逐行同构。所以抄错一个接口路径、抄错一对
// 键名、抄错一次本地写回，**都不会报错**——页面照常渲染，只是：
//   · 接口抄成 `/api/protect/board` ⇒ 管理员在「评论管理」里审的是河灯留言；
//   · 键名抄成留言板那对 ⇒ 点「AI 审核」开关把河灯那一侧的开关翻了个个儿；
//   · 本地写回抄成入参值 ⇒ 驳回之后那一行永远停在「待审」（后端其实已改成未通过）。
// 这三条都是"静默"的，只有把两边的字面钉在一起比对才拦得住。
//
// 因此本套件分成两半：
//   ① **前端↔后端同源**：键名、上限、接口路径、落库值，凡是「两侧必须是同一个值」的地方，
//      都从**两边的源码里各取一次**再比对，而不是把期望值写死在断言里（写死的话，
//      将来两侧一起漂移时它仍然是绿的）。
//   ② **路由挂在哪一半**：`/api/protect/comments` 三条必须在 `protected_routes`（后台管理员），
//      公开三条必须在 `public_routes`——挂错了由 `auth_guard` 对**全体普通用户** 403，
//      而"评论区对访客关闭"这个症状出现在文章页、根因在路由表里，最不好找。
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');       // 父仓根
const read = (p) => readFileSync(path.join(repo, p), 'utf8');

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
/** 剥注释后计数——本仓注释**刻意**引用反例（例如本页头注里那句 `/api/protect/board`，
 *  它是用来写清"这一页不碰那个接口"的），扫注释会把反例当成正例 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const count = (s, needle) => strip(s).split(needle).length - 1;
/** 取一个顶层函数体（同 `comment-render.test.mjs` 的 `bodyOf`）：判"守卫在不在这条路径上"
 *  必须按函数体切——扫全文会把定义处和另一条路径一起算进来 */
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

const users = read('frontend/src/pages/Dashboard/Users/index.tsx');
const comp = read('frontend/src/pages/Dashboard/CommentManage/index.tsx');
const board = read('frontend/src/pages/Dashboard/BoardManage/index.tsx');
const shared = read('frontend/src/pages/Dashboard/ContentManage/shared.tsx');
const home = read('frontend/src/pages/Dashboard/Home/index.tsx');
const rustComments = read('src/routes/comments.rs');
const rustWebInfo = read('src/routes/web_info.rs');
const rustMod = read('src/routes/mod.rs');

// ── ① 页签接线 ─────────────────────────────────────────────────────────────
console.log('页签 —— 标签名与内容这次必须对上：');
ok(users.includes("import CommentManage from '../CommentManage';"), 'Users 页引入了评论管理页');
{
    const review = users.match(/key: 'review',[\s\S]{0,160}?children: <BoardManage \/>/);
    ok(!!review, '「留言管理」页签挂的仍是 BoardManage（河灯，行为零改动）', review && review[0].slice(0, 60));
    ok(!!review && review[0].includes('label: <h3>留言管理</h3>'),
        '它的标签是「留言管理」——20260905 那次合并正是坏在这里（叫「评论管理」却装着留言）');
}
{
    const comment = users.match(/key: 'comment',[\s\S]{0,160}?children: <CommentManage \/>/);
    ok(!!comment, '「评论管理」页签挂的是新的 CommentManage', comment && comment[0].slice(0, 60));
    ok(!!comment && comment[0].includes('label: <h3>评论管理</h3>'), '它的标签是「评论管理」');
}
ok(count(users, '<BoardManage />') === 1 && count(users, '<CommentManage />') === 1,
    '两个组件各挂一次（合并/复制粘贴的痕迹会在这里露出来）',
    { board: count(users, '<BoardManage />'), comment: count(users, '<CommentManage />') });
ok(/t === 'review' \|\| t === 'comment' \|\| t === 'quota' \? t : 'accounts'/.test(users),
    '?tab= 深链白名单放行了 comment（漏一项会静默落回账号管理）');
ok(/import '\.\/index\.sass'/.test(comp), '本页带自己的样式表（不加这行整页是裸表格）');

// ── ② 接口面相：打的是评论那两条，不是留言板那两条 ──────────────────────────
console.log('\n接口 —— 四个动作各自打到哪条路径：');
ok(comp.includes("http.get('/api/protect/comments')"), '列表 = GET /api/protect/comments');
ok(/http\.put\(`\/api\/protect\/comments\/\$\{id\}\/audit`, \{ approved, reason \}\)/.test(comp),
    '裁决 = PUT /api/protect/comments/:id/audit，体是 {approved, reason}');
ok(/http\.delete\(`\/api\/protect\/comments\/\$\{id\}`\)/.test(comp),
    '删除 = DELETE /api/protect/comments/:id');
ok(comp.includes("http.get('/api/protected/websetting')")
    && comp.includes("http.post('/api/protected/websetting', { [key]: on })"),
    '两个开关走站点设置那条共享通道（读 + 写）');
ok(count(comp, '/api/protect/board') === 0,
    '**这一页不碰留言板的接口**（/api/protect/board 只出现在注释里，剥掉注释后应为 0）',
    count(comp, '/api/protect/board'));

console.log('\n接口 —— Rust 侧确实挂着这三条，且 DTO 的键名对得上：');
ok(rustComments.includes('pub async fn list_comments_admin')
    && rustComments.includes('pub async fn audit_comment')
    && rustComments.includes('pub async fn delete_comment_admin'),
    '三个 handler 都在 comments.rs');
{
    // 后台列表的 DTO 与前端 `CommentAdminItem` 是**跨语言契约**：字段名必须逐字对上
    for (const [field, why] of [
        ['noteTitle', '文章标题列'],
        ['replyToNickname', '「回复对象」列'],
        ['aiResult', 'AI 审核列（⚠️ 留言板那个 DTO 叫 ai_result，别照抄）'],
        ['isDeleted', '已删除标记'],
    ]) {
        const rustKeys = [...rustComments.matchAll(/#\[serde\(rename = "([^"]+)"\)\]/g)].map((m) => m[1]);
        ok(rustKeys.includes(field), `后端 DTO 回了 ${field}（${why}）`, rustKeys);
    }
    ok(!/rename = "ai_result"|rename = "is_deleted"/.test(rustComments),
        '没把实体列名直接当 JSON 键发出去（读错时前端拿到 undefined：不报错，只是那一列永远「未审」）');
    ok(comp.includes('aiResult') && !/\.ai_result|\.is_deleted/.test(strip(comp)),
        '前端读的是 aiResult / isDeleted（不是下划线版）');
}

// ── ③ 两个开关只认评论那对键 ────────────────────────────────────────────────
console.log('\n审核开关 —— 键名两侧同源，且不与留言板那对混用：');
{
    const rustKeys = rustWebInfo.match(
        /pub const COMMENT_REVIEW_KEYS: \(&str, &str\) =\s*\r?\n?\s*\("([^"]+)",\s*"([^"]+)"\);/);
    const feAi = comp.match(/const AI_KEY = '([^']+)';/);
    const feManual = comp.match(/const MANUAL_KEY = '([^']+)';/);
    ok(!!rustKeys && !!feAi && !!feManual, '两侧都定义了这一对键',
        { rust: rustKeys?.slice(1), fe: [feAi?.[1], feManual?.[1]] });
    ok(rustKeys && feAi && rustKeys[1] === feAi[1],
        'AI 开关键名前后端逐字相同（漂一处 = 开关点了没反应）',
        { rust: rustKeys?.[1], fe: feAi?.[1] });
    ok(rustKeys && feManual && rustKeys[2] === feManual[1],
        '人工复核开关键名前后端逐字相同', { rust: rustKeys?.[2], fe: feManual?.[1] });
    const boardKeys = rustWebInfo.match(
        /pub const BOARD_REVIEW_KEYS: \(&str, &str\) = \("([^"]+)", "([^"]+)"\);/);
    ok(!!boardKeys && boardKeys[1] !== rustKeys?.[1] && boardKeys[2] !== rustKeys?.[2],
        '两对键确实不同（共用一对的话，一页的开关会改到另一页）', boardKeys?.slice(1));
    ok(!/aiReviewEnabled|manualReviewEnabled/.test(strip(comp)),
        '本页的源码里没有留言板那对裸键名（只用常量，防手抄）');
    ok(comp.includes("setAiOn(!!d[AI_KEY])") && comp.includes("setManualOn(!!d[MANUAL_KEY])"),
        '读取按常量取（不是写死的字符串）');
    // 界面上要说清"这对开关不管留言"——两个页签挨着、两对开关长得一样，
    // 不说清就会被当成同一个开关（点错了页面的开关就以为点重了）
    ok(comp.includes('这对开关只管评论，与「留言管理」那对互不影响'),
        '界面上印了「这对开关只管评论」的界定语');
}
console.log('\n审核开关 —— 常量在后端也只有一个出处：');
{
    const pair = rustWebInfo.match(
        /COMMENT_REVIEW_KEYS: \(&str, &str\) =\s*\r?\n?\s*\("([^"]+)",\s*"([^"]+)"\);/);
    const lit = pair ? `("${pair[1]}", "${pair[2]}")` : '()';
    // 这对字面量应当只在常量定义那一处成对出现；DTO 上那个 `#[serde(rename)]` 是**同一个
    // JSON 键名**的第二个落点（前端一次 websetting 响应里读的就是它），所以单键名出现两次
    // 是对的——判"成对出现几次"才是判"有没有第二个出处"。
    ok(count(rustWebInfo, lit) === 1,
        '这对键**成对**只出现一次（= 常量定义），别处一律取常量',
        count(rustWebInfo, lit));
    ok(pair && rustWebInfo.includes(`#[serde(rename = "${pair[1]}")]`),
        'DTO 的 JSON 字段名与 KV 键名是同一个（前端按同一份 JSON 读设置）');
}
ok(count(rustComments, '"commentAiReviewEnabled"') === 0
    && rustComments.includes('super::web_info::COMMENT_REVIEW_KEYS'),
    'comments.rs 从常量取键名，不手抄字面量');
ok(count(rustWebInfo, '= COMMENT_REVIEW_KEYS;') === 2,
    '读写两面都走同一个常量（读 get_web_settings / 写 update_web_info 各一处解构）',
    count(rustWebInfo, '= COMMENT_REVIEW_KEYS;'));

// ── ④ 已删除的行：留着、标出来、不可审（前端 + 后端两处）────────────────────
console.log('\n已删除的评论 —— 评论是软删，这一页必须如实显示"它已经没了"：');
ok(comp.includes('已删除（公开侧不再显示）'), '已删除的行在列表里带一句标记（不是无声消失）');
{
    const op = comp.slice(comp.indexOf("title: '操作'"));
    ok(/if \(r\.isDeleted !== 0\) \{/.test(op), '操作列先判 isDeleted');
    ok(op.includes('<span className="cm-dim">已删除</span>'),
        '已删除的行渲染的是**没有按钮**的说明文字');
    const guard = op.indexOf('if (r.isDeleted !== 0) {');
    const btn = op.indexOf('const rejectBtn =');
    ok(guard >= 0 && btn > guard, '那三条按钮的渲染都在守卫**之后**（否则已删行照样能审）');
}
ok(/key: 'deleted', label: '已删除', match: \(r\) => r\.isDeleted !== 0/.test(comp),
    '状态筛单独有一档「已删除」（溯源用）');
{
    // 从 `= [` 起切：那行**类型注解**自己也含 `match: (r: …) => boolean`，
    // 连注解一起扫会多捕一条假的（这正是这套断言要防的那类"看着像"）
    const from = comp.indexOf('const STATUS_FILTERS');
    const filters = comp.slice(comp.indexOf('= [', from) + 3, comp.indexOf('const AI_KEY'));
    const m = [...filters.matchAll(/match: \(([^)]*)\) => ([^}]+)\}/g)].map((x) => x[2]);
    ok(m.length === 5, '状态筛五档都在（全部/待审/已通过/未通过/已删除）', m.length);
    ok(m.slice(1, 4).every((expr) => expr.includes('r.isDeleted === 0')),
        '中间三档（讨论区当前的样子）都排除已删除的行——否则会出现一行标着「已通过」却永不展示的评论', m);
    ok(m[4] && m[4].includes('r.isDeleted !== 0'), '最后一档只收已删除的行', m[4]);
}
console.log('\n已删除的评论 —— 后端有一道同样的闸（脚本 / 老前端 / 直接打接口也走得到）：');
{
    const audit = bodyOf(rustComments, 'pub async fn audit_comment');
    ok(audit.includes('if c.is_deleted != 0'), 'audit_comment 里判了 is_deleted');
    ok(/is_deleted != 0[\s\S]{0,120}?ApiResponse::error\(/.test(audit),
        '已删除就直说拒绝，不静默照办');
    const guard = audit.indexOf('if c.is_deleted != 0');
    const write = audit.indexOf('am.approved = Set(');
    ok(guard >= 0 && write > guard, '守卫在写库**之前**（写在后面等于没守）');
}

// ── ⑤ 裁决后的本地写回：入参值 ≠ 落库值 ─────────────────────────────────────
console.log('\n本地写回 —— 驳回落库的是 2，不是入参那个 0：');
ok(comp.includes('const stored = approved === 1 ? 1 : 2;'),
    '本地写回显式换算成落库值');
ok(/\{[\s\S]{0,80}approved: stored,/.test(comp), '写回的是 stored');
ok(rustComments.includes('am.approved = Set(if reject { 2 } else { 1 });'),
    '后端驳回落的确实是 2（未通过），与待审 0 区分——两侧换算必须同源');
ok(/approved === 0 \? \([\s\S]{0,260}?待审/.test(comp),
    '「待审」只在 approved 为 0 时显示（2 要另行渲染）');
ok(comp.includes('<Tag color="red">未通过</Tag>'), '2 渲染成「未通过」而不是「待审」');
console.log('\n本地写回 —— 删除是软删，所以本地**标记**而不是抹掉：');
ok(/it\.id === id \? \{ \.\.\.it, isDeleted: 1 \} : it/.test(comp),
    '删除后本地把那一行标成已删除');
ok(!/filter\(\(it\) => it\.id !== id\)/.test(strip(comp)),
    '没有把行从列表里删掉——后端软删，刷新后它会带着「已删除」回来（那会被读成"删了没删掉"）');
ok(/am\.is_deleted = Set\(1\)/.test(rustComments), '后端确实是软删（写 is_deleted）');
console.log('\n本地写回 —— 驳回理由必填，且有回落链：');
ok(/disabled: !rejectReason\.trim\(\),/.test(comp),
    '理由为空时「确认驳回」不可点');
ok(comp.includes('reason?.trim() || it.rejectReason || it.aiReason || null'),
    '本地理由的回落链与后端一致（人工 > 已存 > AI 说明），不显示成空');

// ── ⑥ 两页共用一份预设 / 上限 / tooltip ────────────────────────────────────
console.log('\n共享件 —— 共用的是"同一件事"，不是"长得像"：');
ok(shared.includes('export const REJECT_REASON_MAX = 200'), '理由上限定义在 shared');
ok(count(board, 'REJECT_REASON_MAX') === 2 && count(comp, 'REJECT_REASON_MAX') === 2,
    '两页都 import 再使用（不是各自写死 200）',
    { board: count(board, 'REJECT_REASON_MAX'), comment: count(comp, 'REJECT_REASON_MAX') });
ok(!/maxLength=\{200\}|maxLength=\{ 200 \}/.test(board + comp), '两页都没有写死的 200');
ok(count(board + comp + shared, '广告引流') === 1,
    '违规类型词表只有一处（抄第二份就会出现"两页理由不一样"）');
ok(shared.includes("export const BOARD_REJECT_PRESETS = withVenue('与留言板无关')")
    && shared.includes("export const COMMENT_REJECT_PRESETS = withVenue('与文章无关')"),
    '两组预设各有一条场地专属的离题项（河灯说留言板、评论说文章）');
ok(shared.includes('COMMON_REJECT_PRESETS.slice(0, 5)')
    && !/COMMENT_REJECT_PRESETS\.slice|BOARD_REJECT_PRESETS\.slice/.test(shared),
    '场地那条固定插在第 6 位 ⇒ 两页按钮顺序逐字相同（肌肉记忆）');
ok(board.includes('BOARD_REJECT_PRESETS.map') && comp.includes('COMMENT_REJECT_PRESETS.map'),
    '各页用各页那组');
ok(count(shared, 'export const aiTip') === 1
    && !/const aiTip/.test(strip(board) + strip(comp)),
    'aiTip 只有一处实现（两个页签挨着，tooltip 的换行/宽度漂了最容易被看出来）');
ok(count(shared, 'content-ai-tip') === 1 && shared.includes("import './shared.sass'"),
    'tooltip 的样式跟着它自己走（不挂在哪一页的样式表上——那一页不加载就静默变形）');
ok(!/bm-ai-tip/.test(strip(board)), '留言板那份本地副本已删干净');

// ── ⑦ 路由挂在哪一半 ───────────────────────────────────────────────────────
console.log('\n路由 —— 后台三条在 protected 域内，公开三条在 public 域内：');
{
    const pub = rustMod.indexOf('let public_routes = Router::new()');
    const prot = rustMod.indexOf('let protected_routes = Router::new()');
    ok(pub > 0 && prot > pub, '路由表里两半的起点都找得到', { pub, prot });
    for (const r of ['/api/protect/comments', '/api/protect/comments/:id/audit', '/api/protect/comments/:id']) {
        const at = rustMod.indexOf(`"${r}"`);
        ok(at > prot, `后台那条 ${r} 在 protected 域内（admin 守卫）`, at);
    }
    for (const r of ['/api/public/notes/:id/comments', '/api/public/comments/:id']) {
        const at = rustMod.indexOf(`"${r}"`);
        ok(at > pub && at < prot,
            `公开那条 ${r} 留在 public 域内（挂到 protected 上 = 全体普通用户 403，评论区对访客关闭）`, at);
    }
    ok(/delete\(comments::delete_my_comment\)/.test(rustMod)
        && /delete\(comments::delete_comment_admin\)/.test(rustMod),
        '作者自删与管理员删除是两个 handler，没并成一个');
}

// ── ⑧ 首页待办那一行的名字 ─────────────────────────────────────────────────
console.log('\n后台首页待办卡 —— 数的是留言，就该说留言：');
ok(home.includes('条留言待人工审核'), '写着「条留言待人工审核」');
ok(!home.includes('条评论待人工审核'),
    '没有出现「条评论待人工审核」（那个数来自 profile.rs::board_pending_count，是河灯留言的量；'
    + '评论要有自己的一行 + 自己新加的 pendingComments 字段，别并进这一个数）');

console.log(`\ncomment-admin: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);

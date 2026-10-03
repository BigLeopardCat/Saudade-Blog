// ═ 评论点赞/踩的**跨语言契约**（20261003 用户第 4 条）══
//   node tests/comment-vote.test.mjs
//
// 交互本身由 `tests/comment-layout.test.py` 的 ⑪ 组在真浏览器里量（高亮跟 myVote、
// 计数为 0 不显示、乐观更新、失败回滚、发出去的 value）。**本套件量的是它量不到的那一半**：
// 那些"两边必须写成同一个值、写错了不会报错只会静默走错路"的地方。
//
// 三族静默失败，每一族都只有把两侧字面钉在一起才拦得住：
//   · **端点/路由域**：`POST /api/public/comments/:id/vote` 落到 `protected_routes`，
//     症状是"访客点不动、普通用户 403"，而根因在路由表里——评论区看上去一切正常；
//   · **身份**：少带一个 `X-Visitor-Key`，游客就退化成"没有身份"⇒ 每次都被回「未登录」；
//     而投票与发评论**在同一个文件里**有相反的要求（评论强制登录、票对访客开放），
//     谁抄谁一句话就反了，且反了以后本地登录态测试全绿；
//   · **键名/值域**：`myVote` 与 `up`/`down` 两头对不上 ⇒ 前端静默读到 undefined
//     （高亮永不亮、数字恒 0）；`0` 被当成"缺省"而不是"撤回" ⇒ 想撤回反而投了一票。
//
// 另一半是**迁移**：本套件只钉"文件在不在、表名键名 flag 与 entity 张不张嘴一致"。
// 跑没跑是另一回事——按本仓约定，迁移要用户点名（库名 + 文件）才执行，跑之前不 push。
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');       // 父仓根
const read = (p) => readFileSync(path.join(repo, p), 'utf8');
const has = (p) => existsSync(path.join(repo, p));

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
/** 剥注释后计数——本仓注释**刻意**引用反例（例如 `CommentMethods.tsx` 头注专门写明
 *  "评论不带访客头、投票必须带"），扫注释会把反例当成正例 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const count = (s, needle) => strip(s).split(needle).length - 1;
/** 取函数体：先找到第一个 `{` 再配平。**不要**用"最后一个 `}`"那种取法——
 *  同一个文件里后面还有别的函数，取到的是它们的并集，判"某函数里有没有 X"会假绿。 */
function bodyOf(src, marker) {
    const i = src.indexOf(marker);
    if (i < 0) return '';
    const j = src.indexOf('{', i);
    if (j < 0) return '';
    let depth = 0;
    for (let k = j; k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(j + 1, k); }
    }
    return '';
}

const rustVotes = read('src/routes/comment_votes.rs');
const rustComments = read('src/routes/comments.rs');
const rustMod = read('src/routes/mod.rs');
const rustEntityMod = read('src/entity/mod.rs');
const rustEntityVote = read('src/entity/note_comment_vote.rs');
const tsApis = read('frontend/src/apis/CommentMethods.tsx');
const tsTypes = read('frontend/src/interface/CommentType.d.ts');
const tsVisitor = read('frontend/src/utils/visitorKey.ts');
const MIGRATION = 'scripts/migration/note_comment_vote_20261003.sql';
const sql = has(MIGRATION) ? read(MIGRATION) : '';

// ── ① 路由与域 ─────────────────────────────────────────────────────────────
console.log('\n路由 —— 一条公开写路由，挂在 public 域内：');
{
    const pub = rustMod.indexOf('let public_routes = Router::new()');
    const prot = rustMod.indexOf('let protected_routes = Router::new()');
    ok(/pub mod comment_votes;/.test(rustMod), '模块已登记（漏了这句 handler 根本挂不上）');
    const at = rustMod.indexOf('"/api/public/comments/:id/vote"');
    ok(at > pub && at < prot,
        '投票路由留在 public 域内（挂到 protected 上 = auth_guard 对全体普通用户 403，'
        + '症状是"访客点不动"而根因在路由表里）', at);
    ok(/post\(comment_votes::vote_comment\)/.test(rustMod),
        '用 POST 挂的是 comment_votes::vote_comment');
    ok(count(rustMod, '"/api/public/comments/:id/vote"') === 1,
        '这条路由只挂了一次（同一个资源挂两次 = 有一条静默生效、改的时候只改到另一条）',
        count(rustMod, '"/api/public/comments/:id/vote"'));
    ok(/\/api\/public\/comments\/\$\{id\}\/vote/.test(tsApis),
        '前端拼的是同一条路径（前后端各写一份字面量，这是它们必须逐字相同的地方）');
}

// ── ② 身份：一个实现、一个头 ───────────────────────────────────────────────
console.log('\n身份 —— 复用文章点赞那一份，不另写一遍：');
{
    ok(/use super::note_stats::\{identify, Who\}/.test(rustVotes),
        '投票走 note_stats 的 identify / Who（"登录认领同一访客的匿名行"那条规则绝不能抄第二份）');
    ok(rustVotes.includes('who.cond_on('),
        '撤回用 `Who::cond_on` 覆盖两种身份（抄成只匹配 user_id 的话，登录后就撤不掉自己匿名投的那票）');
    ok(count(rustVotes, 'X-Visitor-Key') === 0,
        '投票模块里没有第二处解析访客头的字面量（头的名字只有 `utils/visitorKey` 一处事实源）');

    const voteBody = bodyOf(tsApis, 'function voteComment');
    const createBody = bodyOf(tsApis, 'function createComment');
    ok(/\[VISITOR_HEADER\]: getVisitorKey\(\)/.test(voteBody),
        'voteComment 带上了访客标识（少了它 ⇒ 游客被回「未登录」，而登录态测试全绿）');
    ok(/VISITOR_HEADER/.test(tsVisitor) && /'X-Visitor-Key'/.test(tsVisitor),
        '常量名字面量与后端读到的那一个相同', 'X-Visitor-Key');
    ok(createBody !== '' && count(createBody, 'VISITOR_HEADER') === 0,
        'createComment 仍然不带访客头（评论强制登录、票对访客开放——'
        + '两条接口在同一个文件里要求相反，正是最容易"顺手统一"掉的一处）');
}

// ── ③ 值域：−1 / 0 / 1，且 0 是撤回 ────────────────────────────────────────
console.log('\n值域 —— ±1 是票，0 是撤回（不是缺省）：');
{
    ok(/matches!\(payload\.value, -1 \| 0 \| 1\)/.test(rustVotes),
        '后端校验三种取值，0 被显式认成合法（当缺省处理 ⇒ 想撤回反而投了一票）');
    ok(/0 => withdraw_vote\(/.test(rustVotes) && /=> set_vote\(/.test(rustVotes),
        '0 走撤回（DELETE 行）、±1 走 upsert —— 库里没有"0 分票"这一档');
    ok(/pub value: i8/.test(rustEntityVote), 'entity 的 value 是 i8（TINYINT，够放 ±1）');
    const tsComment = read('frontend/src/components/CommentSection/index.tsx');
    ok(/const next: -1 \| 0 \| 1 = c\.myVote === dir \? 0 : dir/.test(bodyOf(tsComment, 'const vote = async')),
        '前端"再点一次已点亮的那一侧 = 撤回"发的是 0（不是再投一遍）');
    ok(/myVote: -1 \| 0 \| 1/.test(tsTypes),
        'TS 那一侧 myVote 的类型写着 −1 | 0 | 1（写宽成 number，改主意那支就没人管了）');
}

// ── ④ 键名：DTO ↔ DTO ↔ TS ────────────────────────────────────────────────
console.log('\n键名 —— 列表行与投票回执是**同一种东西**（前端只写一份解析）：');
{
    for (const [name, src] of [['投票回执', rustVotes], ['列表行', rustComments]]) {
        ok(/pub up: i64,\s*\n\s*pub down: i64,\s*\n\s*#\[serde\(rename = "myVote"\)\]\s*\n\s*pub my_vote: i8,/
            .test(src.replace(/\r/g, '')),
            `${name} DTO 是 up/down(myVote) —— 与 TS 的 CommentVote 逐字对应`, name);
    }
    const voteDto = bodyOf(tsTypes, 'export interface CommentVote');
    ok(/up: number/.test(voteDto) && /down: number/.test(voteDto) && /myVote: -1 \| 0 \| 1/.test(voteDto),
        'TS 侧三个字段的名字与后端 serde 输出相同（对不上 tsc 不报错，只会运行时读到 undefined）');
    ok(/export interface CommentItem extends CommentVote/.test(tsTypes),
        'CommentItem **继承** CommentVote（列表行带着这三个字段，所以列表不必为每行再打一次接口）');
    const dto = bodyOf(rustComments, 'fn to_dto');
    ok(/up: vote\.up/.test(dto) && /down: vote\.down/.test(dto) && /my_vote: vote\.my_vote/.test(dto),
        '列表的 to_dto 真的把票数填进去了（字段加了但没填 ⇒ 恒 0，页面照常渲染）');
    ok(/vote_counts_for\(/.test(bodyOf(rustComments, 'pub async fn list_comments')),
        '列表用**批量**计数（一次 GROUP BY），不是每行一次查询');
}

// ── ⑤ 「访客也能点、不改排序」在代码里成立 ────────────────────────────────
console.log('\n排序 —— 讨论区仍是时间序（不是热榜）：');
{
    const listBody = bodyOf(rustComments, 'pub async fn list_comments');
    const orders = [...listBody.matchAll(/order_by_\w+\(([^)]*)\)/g)].map((m) => m[1]);
    ok(orders.length > 0, '列表确实带排序', orders);
    ok(orders.every((o) => /CreatedAt|Id/.test(o)),
        '排序只看时间与 id（把 up/down 掺进排序 = 一条新评论永远沉底，而这是讨论区不是热榜）',
        orders);
}

// ── ⑥ 迁移与 entity 同源 ──────────────────────────────────────────────────
console.log('\n迁移 —— 文件、表名、键名、flag 四处对得上：');
{
    ok(has(MIGRATION), `迁移文件在（${MIGRATION}）`);
    ok(rustEntityVote.includes(MIGRATION),
        'entity 头注指的迁移路径就是这一个文件（文档指向不存在的文件时没人会去核）');
    ok(/pub mod note_comment_vote;/.test(rustEntityMod), 'entity 已登记进 entity/mod.rs');
    ok(/CREATE TABLE IF NOT EXISTS `note_comment_vote`/.test(sql),
        '建的表名与 `#[sea_orm(table_name = ...)]` 相同（写错 ⇒ 编译期全绿、运行期 1146）');
    ok(/UNIQUE KEY `uq_comment_vote_user`\s*\(`comment_id`, `user_id`\)/.test(sql)
        && /UNIQUE KEY `uq_comment_vote_visitor`\s*\(`comment_id`, `visitor_key`\)/.test(sql),
        '两条唯一键都在（幂等靠它们，不靠"先查再插"）');
    ok(/INSERT INTO migration_flags \(flag_name\) VALUES \('note_comment_vote_20261003'\)/.test(sql),
        'flag 名与文件名同源（`note_comment_vote_20261003`）');
    ok(/USE saudade_blog;/.test(sql),
        'USE 的是现库名（改名那次留的教训：只有 saudade-rust 连这个库）');
}

console.log(`\ncomment-vote: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);

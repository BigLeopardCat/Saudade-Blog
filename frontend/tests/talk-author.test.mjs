// ═ 说说：创建时的标题归属 + 卡片上的发布者身份（20261005）══
//   node tests/talk-author.test.mjs
//
// 用户原话：「说说的创建怎么和留言板窜了，说说标题取 1 变成愿了，而且不是以登录用户发的，
// 说说卡片显示对应用户信息（类似讨论区那样）」。三件事，一个根：
//
//   ① **说说与河灯留言共用一张表、共用一个写路径**（`insert_talk`，src 分派）。写路径是
//      从河灯那头长出来的：河灯没有独立标题，`title` 列存的是**印章**（愿/寄/忆/诉），
//      于是那一行 `title = cat` 对两个来源一视同仁 ⇒ 后台发说说时，"标题"那一栏被印章
//      覆盖，默认落成「愿」。**而 `update_talk` 一直是按 `payload.title` 写的** ——
//      同一篇说说"新建时叫愿、编辑一次才对"，这个不一致正是它是 bug 而非设计的证据。
//   ② 卡片上的头像取的是 `state.user.avatar` —— **看的人自己**的头像：未登录是空串
//      （每张卡一个空头像），登录了则每条都显示自己的脸。说说卡片从来没有过"是谁发的"。
//   ③ 读失败与"一条都没有"在页面上同形（接口回 code=500 + 空数组，走的是 `.then`）。
//
// 这三条都是**静默**的：改错了照样编译、照样渲染，只是内容不对。所以本套件按源码契约
// 钉住两侧（Rust 的写路径与 DTO / 前端的取数与渲染），几何与真渲染由
// `tests/talk-time.test.py` 的 ⑤ 节负责（含"把组件换回 HEAD 版要变红"的红基线）。
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');        // frontend/
const repo = path.resolve(root, '..');       // 父仓根
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const readRepo = (p) => readFileSync(path.join(repo, p), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

/** 剥注释：本文件的注释**刻意**引用反例（"两个来源共用一行 `title = cat`"），
 *  不剥的话"这行不许再出现"会被自己的注释判红。 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** 按花括号配对取函数体（从 marker 后第一个 `{` 起）。
 *  ⚠️ **必须跳过参数表里的括号**：`State(state): State<Arc<AppState>>` 这类 axum 提取器
 *  参数自身带括号，取错位置会让配对从参数表内部开始跑 —— 一切"函数体里有什么"的断言
 *  就全对着半截签名说话（本仓已经假绿过一整组，见 content-risk.test.mjs 的注释）。 */
function bodyOf(src, marker) {
    const i = src.indexOf(marker);
    if (i < 0) return '';
    let paren = 0, start = -1;
    for (let k = i; k < src.length; k++) {
        const c = src[k];
        if (c === '(') paren++;
        else if (c === ')') paren--;
        else if (c === '{' && paren === 0) { start = k; break; }
    }
    if (start < 0) return '';
    let depth = 0;
    for (let k = start; k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(start + 1, k); }
    }
    return '';
}

const talksRaw = readRepo('src/routes/talks.rs');
const talks = strip(talksRaw);
const insert = bodyOf(talks, 'async fn insert_talk(');
const listBySrc = bodyOf(talks, 'async fn list_by_src(');
const myBoards = bodyOf(talks, 'async fn list_my_boards(');
const update = bodyOf(talks, 'pub async fn update_talk(');
const dtoStruct = bodyOf(talks, 'pub struct TalkDto {');

const front = strip(read('src/frontHome/Content/Talk/index.tsx'));
const adminFront = strip(read('src/pages/Dashboard/Talks/index.tsx'));
const typeFile = read('src/interface/TalkType.d.ts');

console.log('\n① 标题：按来源分派（说说用自己的标题，河灯保持 title = 印章）');
{
    ok(insert.length > 0, '取到 insert_talk 的函数体（判据都跑在函数体里，不是整个文件）');
    // ★ 主判据：写 `title` 的那一处必须按 src 分叉
    ok(/let title = if src == "talk"/.test(insert),
        '★ 落库的 title 按 src 分派（src=talk 用自己的标题）',
        insert.match(/let title[\s\S]{0,200}/)?.[0]);
    ok(insert.includes('payload.title'), '说说那一支取的是 payload.title（后台表单的"标题"）');
    ok(insert.includes('title: Set(Some(title))'), 'ActiveModel 用的是分派后的 title');
    // 负空间：旧的那一行不许回来
    ok(!/title:\s*Set\(Some\(cat/.test(insert),
        '★ title 不再等于 cat（"说说标题取 1 变成愿了"就是这一行）');
    // 河灯那一侧保持原样：换掉它会让 agent 的 list_guestbook 摘要与存量数据形状变样
    ok(/cat\.clone\(\)/.test(insert), '河灯那一支仍是 title = cat.clone()（原样保留）');

    // 同一列的两个写者必须对同一个字段负责：新建写 payload.title、编辑也写 payload.title。
    // 一个说"标题"、另一个说"印章"的话，症状就是"新建时叫愿、编辑一次才对"。
    ok(/active_model\.title = Set\(Some\(payload\.title\)\)/.test(update),
        'update_talk 也写 payload.title（新建与编辑对同一字段负责）');
    // 长度封顶：DB 列是 varchar(255)，别让 100 字以上的标题进去把整行写失败
    ok(/chars\(\)\.count\(\) > 100/.test(insert), '说说标题有长度上限（100 字，远低于列宽 255）');
}

console.log('\n② 发布者身份：说说带 nickname/avatar，河灯留言不带');
{
    ok(/pub nickname: Option<String>/.test(dtoStruct), 'TalkDto 有 nickname（Option：河灯行是 null）');
    ok(/pub avatar: Option<String>/.test(dtoStruct), 'TalkDto 有 avatar');

    ok(/if src == "talk"/.test(listBySrc) && listBySrc.includes('peer_map'),
        '发布者信息只在 src=talk 那一档查（peer_map 是展示名的唯一实现）');
    ok(listBySrc.includes('HashMap::new()'),
        '另一档返回空表（不查库、也就发不出身份）');
    // 负空间：别把 board 也带上身份 —— 河灯公开面刻意只给自由留名，
    // 而 agent 的 list_talks 整行读这个接口（每条挂 avatar URL 会让帧凭空变大）。
    ok(!/src == "board"[\s\S]{0,80}peer_map/.test(listBySrc),
        '河灯那一档不查发布者身份');
    ok(/nickname: None/.test(myBoards) && /avatar: None/.test(myBoards),
        '「我的河灯」也不带（自己的身份自己知道）');
    ok(/nickname: peer\.map/.test(listBySrc) && /avatar: peer\.and_then/.test(listBySrc),
        'DTO 从 peer_map 取值（拿不到用户行时后端兜 `用户#<id>`，不是编一个空名）');
}

console.log('\n③ 前端：卡片取每行自己的发布者，不取看的人');
{
    ok(!/useSelector/.test(front),
        '★ 说说页不再读 redux 的用户（`state.user.avatar` 正是那个"看的人自己"）');
    ok(front.includes('talk.avatar'), '头像取这一行的 avatar');
    ok(front.includes('talk.nickname'), '展示名取这一行的 nickname');
    ok(!/src=\{avatar\}/.test(front), '没有裸的 `src={avatar}`（那个变量已不再是登录用户）');
    ok(/talk-who/.test(front), '卡片上渲染了发布者展示名的元素（.talk-who）');

    ok(!/state\.user\.avatar/.test(adminFront),
        '后台说说页同样不取登录用户的头像');
    ok(adminFront.includes('talk.avatar') && adminFront.includes('talk.nickname'),
        '后台卡片也用这一行的 avatar/nickname');

    // 跨语言：前端读的键名必须与 Rust 序列化出来的键名逐字一致（Rust 侧没有 rename，
    // 字段名即键名）。两侧一起改字面量时这条会跟着绿——所以它两边各钉一次。
    ok(/nickname\??:/.test(typeFile) && /avatar\??:/.test(typeFile),
        'TalkType 里声明了 nickname/avatar（前端读得到这两个键）');
    ok(!/rename = "nickName"/.test(talks) && !/rename = "avatarUrl"/.test(talks),
        'Rust 侧没有给这两个字段改名（改了要同步前端，这里钉住"没改"）');
}

console.log('\n④ 读失败 ≠ 没有：空态与失败态是两件事');
{
    ok(/res\.data\.code !== 200/.test(front),
        '★ 说说页判了业务码（HTTP 200 + code=500 走的是 `.then`，只看 status 会落成空列表）');
    ok(/loadFailed/.test(front), '失败有独立状态');
    ok(/talkEmpty/.test(front) && /talkRetry/.test(front), '失败态有文案与重试入口');
    // 两句话必须在场且不相同：一句是"一条都没有"，一句是"没读出来"。
    ok(front.includes('还没有说说'), '空态文案在场');
    ok(front.includes('没能读取出来'), '失败态文案在场');
    ok(/res\.data\.code === 200/.test(adminFront),
        '后台说说页也判了业务码（原来只判 `res.status`）');
}

console.log(`\n${pass}/${pass + fail} 项通过`);
if (fail) process.exit(1);

// ═ 审核闸只有一份实现（20261002）══
//   node tests/review-gate-single-source.test.mjs
//
// 背景：文章评论要复用留言板那条审核链路（AI 闸 + 人工闸 + 四路回落）。**复用**与
// **照抄一份**在当时的代码里长得一模一样——都是"评论也走了一遍同样的判断"。区别要等到
// 将来：照抄的那份必然只改一处，而这条链路是全仓最敏感的（宁可多一次人工复核，
// 也绝不放行一条未经审核的公开内容）。
//
// 所以这里钉的不是"评论能审核"，而是**结构**：裁决只有 `decide_review` 一份，
// `board_approved` 退化成一个读开关的薄壳；四路异常回落一条不少（每一条都倒向转人工）；
// 会直接放行内容的出口只有两处、放到"未通过"的只有一处——**数目**变了就说明有人加了
// 分支，那正是该有人来看一眼的时候。
//
// 同 `nickname-unique.test.mjs` 的形态：不跑 DB、不跑浏览器，只读父仓源码做契约断言。
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '..');          // 父仓根

const read = (p) => readFileSync(path.join(repo, p), 'utf8');

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
/** 剥注释后再计数/断言——本仓的注释**刻意**引用旧实现与反例，注释里的字不算数 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const count = (s, needle) => strip(s).split(needle).length - 1;

/** 取一个顶层函数的函数体（从 marker 后第一个 `{` 起做花括号配对，配平处即函数尾） */
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

const talks = read('src/routes/talks.rs');
const webInfo = read('src/routes/web_info.rs');

const decide = bodyOf(talks, 'pub(crate) async fn decide_review');
const boardApproved = bodyOf(talks, 'async fn board_approved');

console.log('裁决本体 —— 只有一份：');
ok(decide.length > 0, 'decide_review 存在');
ok(talks.includes('pub(crate) async fn decide_review('), 'decide_review 是 pub(crate)（评论模块要调它）');
ok(/pub\(crate\) async fn decide_review\(\s*tag: &str,\s*uid: i32,\s*content: &str,\s*ai_on: bool,\s*manual_on: bool,/.test(talks),
    '开关**收成参数**（自己不去读库 ⇒ 评论可以用另一对键）');
ok(talks.includes('\"{tag}\"') || /\[\{tag\}\]/.test(talks),
    '日志标签也是参数（两类内容共用一个实现后，日志里分不出是谁在失败等于白记）');
ok(talks.includes('decide_review("board", uid'), '留言板传 tag=\"board\"');
ok(!decide.includes('state.db'), 'decide_review 不碰库（签名里也没有 state）');
ok(!/fn decide_review[\s\S]{0,120}state: &Arc<AppState>/.test(talks), 'decide_review 不收 AppState');

console.log('\n裁决本体 —— 出口的数目就是安全边界：');
ok(count(decide, '(0, None, None, None)') === 4,
    '**四路回落**（AI 未开+人工开 / 响应解析失败 / 非 2xx / 请求失败）各回一次转人工',
    count(decide, '(0, None, None, None)'));
ok(count(decide, '(0, Some("flag"') === 1, '存疑（flag）也倒向转人工，且只有一处');
ok(count(decide, 'Some("pass".to_string())') === 2, 'AI 说 pass 只有两处出口（人工闸开→待审 / 关→放行）');
ok(count(decide, '(1, ') === 2,
    '会**直接放行**内容的出口只有两处：两个开关全关、AI pass 且人工关',
    count(decide, '(1, '));
ok(decide.includes('if manual_on { 0 } else { 2 }'),
    'AI reject 的去向仍是"人工闸开→待审 / 关→未通过"（判 2 只有这一处，且是变量不是字面量）');
ok(decide.includes('verdict') && decide.includes('"reject"'), '采纳的是 agent 的 verdict 三值');
ok(decide.includes('create_agent_assertion'), '调 agent 时仍带服务间身份断言（20260925 A5）');
ok(decide.includes('from_secs(20)'), '网络超时仍短于模型裁决上限（20s < 25s）');

console.log('\n留言板侧 —— 只剩一个读开关的壳：');
ok(boardApproved.length > 0, 'board_approved 仍在');
ok(boardApproved.includes('review_switches'), '壳里只读留言板的开关');
ok(boardApproved.includes('decide_review('), '壳里把裁决交给 decide_review');
for (const [needle, why] of [
    ['AGENT_URL', 'AI 端点地址'],
    ['review_http', 'HTTP 客户端'],
    ['verdict', '裁决词'],
    ['create_agent_assertion', '身份断言'],
]) {
    ok(!boardApproved.includes(needle), `壳里**没有**${why}的副本（这是"照抄一份"的第一征兆）`);
}

console.log('\n全仓 —— 只有一处能调 agent 的 /review：');
const aiReviewUrl = 'http://127.0.0.1:8010/review';
ok(talks.includes(aiReviewUrl), '兜底地址写在 talks.rs');
ok(count(talks, aiReviewUrl) === 1, '整个 talks.rs 里只出现一次', count(talks, aiReviewUrl));
ok(!webInfo.includes('review_http') && !webInfo.includes('verdict'), 'web_info.rs 不掺和裁决');

console.log('\n通知文案 —— 参数化后老句子一字不改：');
ok(/pub fn review_notice_text_for\(\s*noun: &str,\s*venue: &str,/.test(talks), 'review_notice_text_for 收 (noun, venue)');
ok(/review_notice_text_for\("留言", "留言板", approved, brief, reject_reason\)/.test(talks),
    '留言板的薄包装传的正是「留言」「留言板」');
ok(talks.includes('format!("你的{noun}「{brief}」已提交，正在等待人工复核；结果出来我再通知你。")'),
    '待审那句的骨架与旧文案逐字一致');
ok(talks.includes('format!("你的{noun}「{brief}」已通过审核，现在可以在{venue}看到了。")'),
    '通过那句的骨架与旧文案逐字一致（去处也参数化了）');
ok(talks.includes('format!("你的{noun}「{brief}」未通过审核，理由：{reason}")'),
    '未通过那句的骨架与旧文案逐字一致');
ok(talks.includes('review_notice_text(0, "河灯很好看", None)'),
    '既有单测仍按老签名调 review_notice_text（"零改动"的实证）');

console.log('\n审核开关 —— 留言板与评论各一对，互不影响：');
ok(/pub const BOARD_REVIEW_KEYS: \(&str, &str\) = \("aiReviewEnabled", "manualReviewEnabled"\)/.test(webInfo),
    '留言板的键名照旧（**没有改名**——改名等于把已打开的闸静默变成关）');
ok(/pub const COMMENT_REVIEW_KEYS: \(&str, &str\) =\s*\("commentAiReviewEnabled", "commentManualReviewEnabled"\)/.test(webInfo),
    '评论另起一对键（留言板与评论可以分别开关）');
ok(webInfo.includes('review_switches_of') && /review_switches_of\(db, ai_key, manual_key\)\.await/.test(webInfo),
    'review_switches 委托给 review_switches_of（规则一份、键名两份）');
/** 取某个键常量**定义处**那一对字面量（不扫全文件——DTO/setter 里也会出现同一批字符串） */
function keysOf(name) {
    const m = webInfo.match(new RegExp(`pub const ${name}: \\(&str, &str\\) =\\s*\\(([^)]*)\\)`));
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}
const boardKeys = keysOf('BOARD_REVIEW_KEYS');
const commentKeys = keysOf('COMMENT_REVIEW_KEYS');
ok(boardKeys.length === 2 && commentKeys.length === 2, '两对键各是两个字面量', { boardKeys, commentKeys });
ok(boardKeys.every((k) => !commentKeys.includes(k)),
    '两对键**没有重叠**（重叠 = 改一个开关会连带改另一个）', { boardKeys, commentKeys });

console.log('\n评论 —— 复核的是同一份裁决，不是照抄的一份：');
const comments = read('src/routes/comments.rs');
ok(comments.includes('super::talks::decide_review("comment", uid'),
    '评论调的是 talks::decide_review（tag=\"comment\"）');
for (const [needle, why] of [
    ['AGENT_URL', 'AI 端点地址'],
    // ⚠️ 判据是**带引号的 JSON 键** `"verdict"`，不是裸词：评论模块 20261002 起有
    // 一个同名的局部变量（`Ok(risk_verdict) =>`，是 `risk::RiskVerdict` 的**风控三档**，
    // 与 agent 回的裁决词毫无关系）。裸词判据会把那个变量误判成"照抄了一份裁决"，
    // 而这条断言的真正对象一直是 `v.get("verdict")` 那一步。
    ['"verdict"', '裁决词的读取'],
    ['"pass"', 'pass 分支'],
    ['AiReason', 'AI 说明的裁决映射'],
    ['Some("flag"', '存疑分支'],
]) {
    ok(!comments.includes(needle), `评论模块里**没有**${why}的副本`);
}
const routes = read('src/routes/mod.rs');
const pubBlock = routes.slice(routes.indexOf('let public_routes'), routes.indexOf('let protected_routes'));
const protBlock = routes.slice(routes.indexOf('let protected_routes'));
ok(pubBlock.includes('/api/public/notes/:id/comments'),
    '评论的公开读写挂在 public_routes（挂进 protected 域就是普通用户 403）');
ok(pubBlock.includes('/api/public/comments/:id'), '自删也挂在 public_routes');
ok(!protBlock.includes('/api/public/notes/:id/comments'), 'protected 域里没有它');
ok(protBlock.includes('/api/protect/comments'), '后台三条挂在 protected_routes（要 admin 守卫）');
ok(!pubBlock.includes('/api/protect/comments'), '后台接口没漏进公开域');
ok(/COMMENT_REVIEW_KEYS/.test(comments) && comments.includes('review_switches_of'),
    '评论读的是自己那对开关键');

console.log(`\nreview-gate-single-source: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);

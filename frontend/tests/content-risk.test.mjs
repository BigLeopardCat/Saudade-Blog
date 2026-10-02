// ═ 内容风控与分级禁言：跨语言契约（20261002）══
//   node tests/content-risk.test.mjs
//
// 这一批的代码横跨四门语言/四层（Rust 判据 / Rust 数据库列 / 前端后台页 / 前端个人中心），
// 而它们之间**全是靠"同一个字符串"连起来的**——键名、哨兵值、两句拒绝话术。这类契约
// 的共同失败模式是**静默的**：改一侧不改另一侧，编译全过、测试全绿，只是那一档再也
// 没生效（或"永久禁言"在某处显示成 9999 年）。
//
// 所以本套件只干两件事：
//   ① **同源断言**：五组键名 / 默认值 / 哨兵值，在各自的语言里各自解析出来，然后
//      **互相比对**——不是各自"包含某个字面量"，那种断言在两边一起改字面量时照样绿。
//   ② **分野断言**：禁言与冻结最容易被后来者顺手合并（"反正都是限制账号"），
//      而合并之后的症状是**假话**（通知里说"登录已失效"）与**越权**（把令牌作废、
//      把读也挡了）。这一半把"禁言绝不碰 status/token_version/middleware"钉死。
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');            // 父仓根
const read = (p) => readFileSync(path.join(repo, p), 'utf8');

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });
/** 剥注释后计数——本仓注释**刻意**引用反例（如迁移头注里那句"绝不改 middleware.rs"），
 *  不剥的话"断言某物不存在"永远失败。 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const count = (s, needle) => strip(s).split(needle).length - 1;
/** 按花括号配对取一段（从 marker 后第一个 `{` 起）。取函数体/impl 块用。
 *  ⚠️ **必须跳过参数表里的括号**：`State(state): State<Arc<AppState>>` 这类 axum 提取器
 *  参数本身带括号，第一个 `{` 若取错位置（取到参数表内部），配对会从那里开始跑，
 *  一切"函数体里有什么/没有什么"的断言就全部对着半截签名说话——本套件第一版就是这样
 *  **假绿**了一整组（`token_version` 断言失败才发现）。 */
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
/** 去掉文件末尾的 `#[cfg(test)]` 模块——**测试里刻意写着反例字面量**
 *  （如 `assert!(!forever.contains("9999"))`），不剥掉的话"生产代码里不许有这个字面量"
 *  会被自己的测试判红，而那条断言恰好是最该留下的。 */
const codeOnly = (s) => { const i = s.indexOf('#[cfg(test)]'); return i < 0 ? s : s.slice(0, i); };
/** 取一段 JSX（从 marker 到其后第一个 `</Modal>`）——判"某个弹窗的正文说了什么"。 */
const jsxBlock = (src, marker, end) => {
    const i = src.indexOf(marker);
    if (i < 0) return '';
    const j = src.indexOf(end, i);
    return j < 0 ? '' : src.slice(i, j);
};

const risk = read('src/risk.rs');
const webInfo = read('src/routes/web_info.rs');
const comments = read('src/routes/comments.rs');
const talks = read('src/routes/talks.rs');
const tempUser = read('src/routes/temp_user.rs');
const authz = read('src/authz.rs');
const authRs = read('src/routes/auth.rs');
const profileRs = read('src/routes/profile.rs');
const usersPage = read('frontend/src/pages/Dashboard/Users/index.tsx');
const cmPage = read('frontend/src/pages/Dashboard/CommentManage/index.tsx');
const ucPage = read('frontend/src/components/UserCenter/index.tsx');
const profileType = read('frontend/src/interface/ProfileType.d.ts');
const migration = read('scripts/migration/user_mute_20261002.sql');

// ── ① 五组键名：Rust 常量 ⇄ web_info 的 JSON 契约 ⇄ 前端设置卡 ⇄ setter 的位置配对 ──
console.log('\n① 风控键名四处同源');

const keysBlock = risk.slice(
    risk.indexOf('pub const RISK_KEYS'),
    risk.indexOf('];', risk.indexOf('pub const RISK_KEYS')));
const riskKeys = [...keysBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
eq(riskKeys.length, 5, 'RISK_KEYS 恰好五个键');
ok(riskKeys.every((k) => /^content[A-Z]/.test(k)), '键名前缀是 content*（管评论+留言两种内容）', riskKeys);

// web_info 的 serde 契约：前端按这串读 JSON 字段。**顺序也要一致**——setter 是按
// 下标（RISK_KEYS[i] ↔ payload.<第 i 个字段>）配对的，错位会静默写串档。
const serdeKeys = [...webInfo.matchAll(/#\[serde\(rename = "(content[A-Za-z]+)"\)\]/g)]
    .map((m) => m[1]);
eq(serdeKeys, riskKeys, 'web_info 的 JSON 契约与 RISK_KEYS 逐字同序');

// 前端设置卡：`key` 就是上面那串，顺序照旧
const cmFields = [...cmPage.matchAll(/key: '(content[A-Za-z]+)', label: '[^']*', def: (\d+), unit: '([^']*)'/g)]
    .map((m) => ({ key: m[1], def: Number(m[2]), unit: m[3] }));
eq(cmFields.map((f) => f.key), riskKeys, '评论管理页设置卡的键与 RISK_KEYS 逐字同序');
ok(cmFields.every((f) => f.unit), '每一档都带单位（秒/条/小时）', cmFields);

// setter 的位置配对：`(RISK_KEYS[i], payload.<snake>)` 里那个 snake 名必须是同一个键
const snakeOf = (k) => k.replace(/([A-Z])/g, (_, c) => '_' + c.toLowerCase());
const pairs = [...webInfo.matchAll(/\(crate::risk::RISK_KEYS\[(\d)\], payload\.([a-z_0-9]+)\)/g)]
    .map((m) => [Number(m[1]), m[2]]);
eq(pairs.length, 5, 'update_web_info 五个键各写一次');
ok(pairs.every(([i, field]) => snakeOf(riskKeys[i]) === field),
    'setter 的下标配对与键序一致（错位会静默写串档）', pairs.map(([i, f]) => [riskKeys[i], f]));
ok(count(webInfo, 'crate::risk::RISK_KEYS') >= 3,
    'web_info 三处（读 map / 组装 / 写回）都引用常量而不是手抄');
ok(count(webInfo, '"contentRateWindowSecs"') === 1,
    '键名字面量在 web_info 里只出现在 serde 属性这一处');

// 默认值：Rust 的 Default 与前端设置卡的 placeholder 必须是同一组数
const defBlock = bodyOf(risk, 'impl Default for RiskConfig');
const rustDefs = {};
for (const m of defBlock.matchAll(/(window_secs|min_interval_secs|rate_limit|mute_limit|mute_hours): (\d+)/g)) {
    rustDefs[m[1]] = Number(m[2]);
}
const fieldToRust = {
    contentRateWindowSecs: 'window_secs',
    contentMinIntervalSecs: 'min_interval_secs',
    contentRateLimit: 'rate_limit',
    contentMuteLimit: 'mute_limit',
    contentMuteHours: 'mute_hours',
};
eq(Object.keys(rustDefs).length, 5, 'RiskConfig 的五个默认值都在');
eq(cmFields.map((f) => f.def), riskKeys.map((k) => rustDefs[fieldToRust[k]]),
    '前端设置卡的默认值与 RiskConfig::default() 同一组数');

// 解析规则：缺键/非整数 → 回落默认；非正数 → 该档显式关闭
const parse = bodyOf(risk, 'pub fn parse_config');
ok(/None => fallback/.test(parse), '缺键回落默认值（不是关闸）');
ok(/Err\(_\) => fallback/.test(parse), '解析失败回落默认值（填 abc 不会关掉闸门）');
ok(/Ok\(v\) => v/.test(parse), '数值原样留着（<= 0 是"显式关闭"的下游判据）');

// ── ② 闸接在哪：两条写入口、同一份实现 ─────────────────────────────────────
console.log('\n② 风控闸接在两个写入口');

ok(count(comments, 'crate::risk::screen') === 1, '发评论过闸');
ok(count(talks, 'crate::risk::screen') === 1, '发留言过闸');
ok(count(risk, 'pub async fn screen') === 1 && count(risk, 'pub async fn apply_verdict') === 1,
    '判据与施加各只有一份实现（两处调用同一份）');
ok(/src == "board"/.test(talks) && /if src == "board" \{\s*\n\s*let cfg = crate::risk::load_config/.test(talks),
    '留言侧只在 src=board 过闸（管理员的说说不受限流）');

// 闸的位置：comments.rs 里必须在**审核裁决之前**（限流的那条不该白烧一次 AI 审核），
// 且在 uid 落地之后（要按人计数）
const cmAuthIdx = comments.indexOf('let uid = super::talks::current_uid');
const cmScreenIdx = comments.indexOf('crate::risk::screen');
const cmReviewIdx = comments.indexOf('super::talks::decide_review(');
ok(cmAuthIdx >= 0 && cmScreenIdx > cmAuthIdx, '过闸在鉴权之后（要按 uid 计数）');
ok(cmReviewIdx > cmScreenIdx, '过闸在审核裁决之前（限流的条目不烧 AI 审核）');

// 「只把 1 压成 0」：AI 已判驳回(2)的内容不因"发得快"退回"没人裁过"
eq(count(comments, 'if forced && approved == 1 { 0 } else { approved }'), 1,
    '评论侧只把 1 压成 0');
eq(count(talks, 'if forced && approved == 1 { 0 } else { approved }'), 1,
    '留言侧只把 1 压成 0（两侧同形）');
ok(count(strip(codeOnly(risk)), 'forced && approved') === 0,
    '压 0 的判据不在 risk.rs（它只回 verdict，不碰 approved）');

// 「`<= 0` = 这一档显式关闭」这条规则**只许住一处**。20261003 CI 抓到的真实缺陷：
// 原来调用方判 `min_interval_secs > 0`，而 `check_and_mark` 内部又写 `gap_secs.max(1)`
// —— 同一个规则两份实现、且下面那份把 0 悄悄变成"1 秒"（一个关不掉的闸）。
// 这类 bug 本地 `cargo check` 永远看不见（测试跑不了），只有 CI 的 Rust 用例能抓。
const limiter = bodyOf(risk, 'fn check_and_mark');
ok(/gap_secs <= 0/.test(limiter) && /return Ok\(\(\)\)/.test(limiter),
    'check_and_mark 自己认「<= 0 = 关闭」（不是 `gap_secs.max(1)` 那种把 0 变 1 秒的写法）');
ok(count(strip(risk), 'min_interval_secs > 0') === 0,
    '调用方不再自己判一遍（规则一份，不在两处各实现一次）');

// 三档行为：拒发 / 转人工 / 自动禁言，各有一处
const apply = bodyOf(risk, 'pub async fn apply_verdict');
ok(/RateLimited \{ count \}/.test(apply) && /notify_rate_limited/.test(apply), '限流档：通知本人');
ok(/Muted \{ until, count \}/.test(apply) && /apply_auto_mute/.test(apply), '禁言档：落库 + 通知本人');

// 窗口计数：两条 COUNT，评论与留言**合起来算**
const countRecent = bodyOf(risk, 'async fn count_recent');
ok(/note_comment/.test(countRecent) && /talk/.test(countRecent),
    '窗口计数同时数评论表与留言表');
ok(/talk::Column::Src\.eq\("board"\)/.test(countRecent), '留言侧只数 src=board（管理员的说说不算）');
ok(count(risk, 'UNION') === 0, '不写 UNION（两条独立 COUNT，注释里解释过）');

// ── ③ 禁言 ≠ 冻结：绝不碰 status / token_version / middleware ───────────────
console.log('\n③ 禁言与冻结的分野');

const setMuted = bodyOf(tempUser, 'pub async fn set_user_muted');
ok(setMuted.length > 0, 'set_user_muted 存在');
ok(/muted_until = Set\(/.test(setMuted), '只写 muted_until 一列');
// ⚠️ 用剥注释后的文本判"没有"：这个函数体里**刻意**写着一条注释
// 「**不碰 status / token_version**（见头注）」——不剥的话本条断言恒红，
// 而它恰好是本套件最该留下的那一条。
ok(count(strip(setMuted), 'token_version') === 0, '绝不 bump token_version（与冻结正相反）');
ok(!/\.status\s*=/.test(strip(setMuted)), '绝不改 status（那是冻结的地盘）');
ok(/crate::authz::check_freeze/.test(setMuted),
    '权限判据复用 check_freeze（规则一份、话术两份，不复制规则表）');
ok(/mute_denial_message/.test(setMuted), '拒绝话术走禁言自己那份（动词是"禁言"）');

// 拒绝话术四分支，动词参数化
const denial = bodyOf(tempUser, 'fn mute_denial_message');
ok(/if muted \{ "禁言" \} else \{ "解除禁言" \}/.test(denial), '动词按方向参数化');
const denialArms = [...denial.matchAll(/D::(NotPermitted|SelfTarget|TargetSuperadmin|PeerAdmin) =>/g)]
    .map((m) => m[1]);
eq(denialArms, ['NotPermitted', 'SelfTarget', 'TargetSuperadmin', 'PeerAdmin'],
    '四个拒绝分支都在（与冻结那张规则表一一对应）');
// 四句话里三句带动词、一句不带（"只有管理员…"对两个方向都成立）
eq(count(denial, '{verb}'), 3, '三句按方向换动词');

// 拦截点只在写入口：读路径（令牌校验/中间件）完全不认识 muted
const middleware = read('src/middleware.rs');
ok(!/muted/.test(middleware), 'middleware.rs 不认识 muted（禁言不挡读）');
ok(!/muted/.test(read('src/auth_jwt.rs')), 'auth_jwt.rs 不认识 muted（令牌照旧有效）');

// is_muted 的读者：只允许这四处（多出来的就是有人把它接到了别处）
const readers = ['src/risk.rs', 'src/routes/temp_user.rs', 'src/routes/auth.rs', 'src/routes/profile.rs'];
ok(readers.every((p) => /is_muted\(/.test(read(p))), '四个已知读者都在', readers);
ok(!/is_muted\(/.test(read('src/routes/talks.rs')) && !/is_muted\(/.test(read('src/routes/comments.rs')),
    '两个写入口不自己判禁言（走 risk::screen 的 AlreadyMuted）');

// 通知正文：禁言**必须另写一份**，照抄冻结那句就是假话
ok(/fn mute_change_body/.test(tempUser) && /fn account_change_body/.test(tempUser),
    '存在两份通知正文（冻结的、禁言的）');
const muteBody = bodyOf(tempUser, 'fn mute_change_body');
ok(!/登录的全部设备已失效/.test(muteBody) && !/需要重新登录/.test(muteBody),
    '禁言通知不说"登录失效/需要重新登录"（禁言不 bump 代次）');
ok(/仍可登录|照常|不受影响/.test(muteBody), '禁言通知说清"还能登录、还能看"');

// 自动禁言那条通知同样要说清分野，且已禁言时不重复写（防脚本无限续期）
const autoMute = bodyOf(risk, 'async fn apply_auto_mute');
ok(/is_muted/.test(autoMute), '已处于禁言期时不再续期（脚本刷不出来）');
const noticeBody = bodyOf(risk, 'fn mute_notice_body');
ok(/仍可登录/.test(noticeBody) && !/设备已失效/.test(noticeBody),
    '自动禁言的通知正文同样不说"设备失效"');

// ── ④ 哨兵值：「未禁言」= NULL，「永久」= 一个常量 ─────────────────────────
console.log('\n④ 未禁言 / 永久 可区分');

const forever = (authz.match(/pub const MUTE_FOREVER: &str = "([^"]+)"/) || [])[1];
ok(!!forever, 'authz.rs 定义了 MUTE_FOREVER 常量', forever);
eq(count(codeOnly(authz), '"9999-12-31 23:59:59"'), 1, '哨兵字面量在 Rust 侧只出现一处');
eq(count(codeOnly(tempUser), '"9999'), 0, 'temp_user.rs 的代码里没有哨兵字面量（走常量）');
// 解禁方向的 no-op 判据必须是 NULL 而不是 is_muted：对"禁言已过期但列里还留着旧值"
// 的账号点解禁，是在清残留值，**应当写下去**（写完后台那一列才真是空的）
ok(/if !muted && target\.muted_until\.is_none\(\)/.test(setMuted), '解禁的 no-op 判据是 NULL');

// 前端镜像：账号列表是裸数组的跨语言契约，显示用的哨兵必须与后端同字面
const frontForever = (usersPage.match(/const MUTE_FOREVER = '([^']+)'/) || [])[1];
eq(frontForever, forever, '前端账号页的哨兵与 authz::MUTE_FOREVER 同字面');
ok(/'永久'/.test(usersPage), '哨兵翻译成"永久"而不是把 9999 年显示出来');

// 到期文案只有一个实现，三处共用
ok(/pub fn mute_until_text/.test(authz), 'mute_until_text 住在 authz（与 is_frozen 同位置）');
ok(count(tempUser, 'mute_until_text') >= 1, '后台回执的"永久/至 X"走共享实现');
ok(count(risk, 'mute_span_text') >= 1 && count(authz, 'pub fn mute_span_text') === 1,
    '自动禁言通知的期限短语也走 authz（不是第三份日期 format!）');
// 哨兵**判据**（比较）只在 authz：别处出现就是又一个"永久"判法
const foreverJudgements = ['src/risk.rs', 'src/routes/temp_user.rs', 'src/routes/auth.rs',
    'src/routes/profile.rs'].filter((p) => />=\s*crate::authz::mute_forever_at\(\)/.test(read(p)));
eq(foreverJudgements, [], '哨兵比较只在 authz.rs（别处一比，改哨兵值就会漏）');
// 3 处判 + 1 处定义（`pub fn mute_forever_at()` 自己也含这个子串）
eq(count(codeOnly(authz), 'mute_forever_at()'), 4,
    'authz 里只有三处判"永久"（拒绝话术 / 标签 / 短语）');

// NULL 与永久在判据上必须不同：NULL 恒 false，永久恒 true
const isMuted = bodyOf(authz, 'pub fn is_muted');
ok(/None => false/.test(isMuted), 'NULL（从未禁言）判 false');
ok(/now <|> now|< now|<= now/.test(isMuted), '到期时刻与现在比（不是看有没有值）');

// ── ⑤ 前端：账号页的禁言控件 + 个人中心横幅 ───────────────────────────────
console.log('\n⑤ 前端控制面');

ok(/\/api\/temp-users\/' \+ user\.id \+ '\/mute'/.test(usersPage), '账号页打的是 /mute 端点');
ok(/\{ muted, hours: muted \? hours : null \}/.test(usersPage),
    '传目标状态（muted）+ 时长；解禁方向不带 hours');
ok(/const isMuted = \(u: any\) => !!u\.muted/.test(usersPage),
    '禁言判据取后端算好的 muted（前端不自行比时间）');
ok(/MUTE_DURATIONS/.test(usersPage) && /hours: 0, label: '永久'/.test(usersPage),
    '四个时长档，其中"永久"用 0 表达（后端认 <=0）');
ok(/muteBlocked/.test(usersPage) && /不能禁言自己的账号/.test(usersPage)
    && /管理员之间不可互相禁言/.test(usersPage),
    '按钮禁用话术与后端 mute_denial_message 同源');
ok(/已禁言\{u\.mutedUntil \? ` · \$\{muteUntilText\(u\.mutedUntil\)\}` : ''\}/.test(usersPage),
    '已禁言行显示到期时刻（不是只有"已禁言"三个字）');
ok(/danger=\{!isFrozen\(u\)\}/.test(usersPage) && !/danger=\{!muted\}|danger=\{muted\}/.test(usersPage),
    '禁言按钮两侧都不给 danger（红按钮在这一页 = 把人赶走）');

// 弹窗正文：必须说清"禁了多少、什么被拒、什么照常"，且**一个字都不提下线**
const muteModal = jsxBlock(usersPage, "title={'禁言账号 - '", '</Modal>');
ok(muteModal.length > 0, '禁言弹窗存在');
ok(!/失效|下线|重新登录/.test(muteModal), '禁言弹窗不提"失效/下线/重新登录"');
ok(/不能发布文章评论与留言/.test(muteModal), '禁言弹窗说清被拒的是什么');
ok(/仍可登录/.test(muteModal) && /点赞也不受影响/.test(muteModal), '禁言弹窗说清照常的是什么');
ok(/Radio\.Group/.test(muteModal), '时长选择在弹窗里（Radio.Group 四档）');
ok(/okText="禁言"/.test(muteModal), '确认按钮写动作词而不是"确定"');
const unmuteModal = jsxBlock(usersPage, "title={'解除禁言 - '", '</Modal>');
ok(/okText="解除禁言"/.test(unmuteModal) && /登录\n?\s*状态一直有效|登录状态一直有效/.test(unmuteModal),
    '解禁弹窗单开一个，并说清与冻结无关');

ok(/\.\.\.\(\(\) => \(muted \? setUnmuteTarget\(u\) : askSetMute\(u\)\)\)/.test(usersPage)
    || /muted \? setUnmuteTarget\(u\) : askSetMute\(u\)/.test(usersPage),
    '一个按钮两向：按当前状态取反');
ok(/\|\| !!muteTarget \|\| !!unmuteTarget/.test(usersPage),
    '两个新弹窗也进了 useLiveRefresh 的 skip（不覆盖正在确认的东西）');

// 设置卡
ok(/风控设置/.test(cmPage) && /RISK_FIELDS/.test(cmPage), '评论管理页有风控设置卡');
ok(cmPage.includes('/^-?\\d+$/'), '设置卡的输入做整数校验');
ok(/return;\s*\n\s*\}\s*\n\s*payload\[f\.key\] = Number\(raw\)/.test(cmPage),
    '填了但不是整数 ⇒ 整份不提交（静默丢弃 = 主人以为存上了）');
ok(cmPage.includes("riskForm[f.key] ?? ''"), '缺键回空串（不替管理员决定"就是 0"）');
ok(cmPage.includes("'没有要保存的项"), '全空时不发请求（"存了个空"与"什么都没改"不是一回事）');
ok(/http\.post\('\/api\/protected\/websetting'/.test(cmPage), '保存走既有的 web_info 接口');
ok(/await loadSwitches\(\)/.test(bodyOf(cmPage, 'const saveRisk = async () =>')),
    '保存成功后**回读**（库是真值，输入框不是）');

// 个人中心横幅
ok(/profile\?\.muted &&/.test(ucPage), '个人中心按 profile.muted 渲染横幅');
ok(/你暂时不能发布评论与留言/.test(ucPage) && /仍可登录/.test(ucPage),
    '横幅说清"能做什么、不能做什么"');
ok(/ucMuteBanner/.test(ucPage) && /ucMuteBanner/.test(read('frontend/src/components/UserCenter/index.sass')),
    '横幅有类名也有样式（只压字号，颜色交给 antd 主题）');

// 类型契约
ok(/muted\?: boolean/.test(profileType) && /mutedUntil\?: string \| null/.test(profileType),
    'ProfileType 声明了 muted / mutedUntil');
ok(/#\[serde\(rename = "mutedUntil"\)\]/.test(authRs), 'ProfileDto 的 JSON 契约字段名是 mutedUntil');
ok(/pub muted: bool/.test(authRs) && /pub muted_until: Option<String>/.test(authRs),
    'ProfileDto 两个字段都在');
// 口径必须两处逐字相同（登录返回 / 改资料返回都带这两列）
const authMuteLines = authRs.slice(authRs.indexOf('let muted = crate::authz::is_muted'),
    authRs.indexOf('let muted = crate::authz::is_muted') + 200);
ok(/crate::authz::is_muted\(u\.muted_until, chrono::Local::now\(\)\.naive_local\(\)\)/.test(profileRs)
    && /crate::authz::is_muted\(u\.muted_until, chrono::Local::now\(\)\.naive_local\(\)\)/.test(authMuteLines),
    'auth::profile 与 profile::update_profile 的判据逐字相同');
ok(/map\(crate::authz::mute_until_text\)/.test(profileRs), '到期文案两处共用同一个实现');

// 后台列表的契约字段（agent 与探针也读这个裸数组）
ok(/pub muted: bool/.test(tempUser) && /pub muted_until: Option<String>/.test(tempUser),
    'TempUserInfo 加了 muted / mutedUntil（只加字段，不改形状）');
ok(/原样回库值|原始库值|原样回/.test(tempUser), '注释写明 mutedUntil 是原始库值（永久是那个哨兵）');

// ── ⑥ 迁移：纯加列、无需回填 ───────────────────────────────────────────────
console.log('\n⑥ 迁移 C');

ok(/ALTER TABLE\s+`?user`?\s+ADD COLUMN\s+`?muted_until`?\s+datetime\s+NULL/i.test(migration),
    '纯加列 datetime NULL');
eq(count(migration, 'UPDATE '), 0, '没有 UPDATE（存量行 NULL = 未禁言，正是正确语义）');
ok(/flag: user_mute_20261002/.test(migration), '带 migration flag（勿重跑）');
ok(/先跑.*后 push|本文件必须\*\*先跑/.test(migration), '头注写明硬顺序：迁移先跑、代码后 push');

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

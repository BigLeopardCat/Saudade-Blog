// ═ 昵称唯一（20261002）跨层契约 ══
//   node tests/nickname-unique.test.mjs
//
// 用户原话：「昵称也启用唯一不可重复。」这条特性跨了四层，而**每一层单独看都像做完了**：
//   迁移（函数索引 + 存量去重改名）→ Rust 写入侧（预检 + 1062 兜底 + 清标记）
//   → DTO（nicknameAutoRenamed）→ 前端（个人中心横幅）
// 任何一层漏掉，症状都是"看起来对但没生效"：索引漏了就静默允许重名；预检漏了就每次
// 改动都弹"保存失败"（其实是 1062）；DTO 漏了横幅永远不出现（`undefined` 是 falsy，
// 渲染分支安静地不走）；迁移的 `IS NOT NULL` 漏了，"三个人都没设昵称"会被当成重名组，
// 执行者在建索引前白白停手。
//
// 这里不跑 DB、不跑浏览器，只做**源码契约**（同 `agent-cmd-program-only.test.mjs` 的形态）：
// 把"改一处忘一处就会静默失效"的那几处逐条钉住。真正的行为验证在迁移执行与无头沙箱。
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '..');          // 父仓根（Rust 与迁移在这边）

const read = (p) => readFileSync(path.join(repo, p), 'utf8');
const readFe = (p) => readFileSync(path.join(root, p), 'utf8');

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
/** 剥注释后再断言"代码里没有 X"（本仓的文件头注里**刻意**写着旧实现/反例） */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*--.*$/gm, '');

const profileRs = read('src/routes/profile.rs');
const authRs = read('src/routes/auth.rs');
const entityRs = read('src/entity/user.rs');
const migration = read('scripts/migration/nickname_unique_20261002.sql');
const pageTsx = readFe('src/components/UserCenter/index.tsx');
const types = readFe('src/interface/ProfileType.d.ts');
const sass = readFe('src/components/UserCenter/index.sass');

console.log('迁移 —— 函数索引与存量去重：');
ok(/ADD UNIQUE KEY `uk_user_nickname` \(\(NULLIF\(TRIM\(nickname\), ''\)\)\)/.test(migration),
    '唯一索引是**函数索引**且表达式外有双层括号（单层会被 MySQL 当成列名）');
ok(migration.includes('VERSION()'), '先打印 MySQL 版本（函数索引需要 ≥ 8.0.13）');
// 判据是"归一后非空"，且**必须经别名**引用：MySQL 8 在 HAVING 里把 GROUP BY 那个表达式
// 原样重写一遍会报 `ERROR 1054 Unknown column 'nickname' in 'having clause'`（20261003 实跑
// 发现——这文件从写出来到跑之前从没被执行过）。别名只是给它起个名字，判据一字未改。
ok(/NULLIF\(TRIM\(nickname\), ''\) AS 归一组/.test(migration),
    '分组表达式被**命名**（`AS 归一组`）——HAVING 里只能引别名，重写表达式会 1054');
ok(migration.includes('GROUP BY 归一组') && migration.includes('HAVING COUNT(*) > 1 AND 归一组 IS NOT NULL'),
    '重复组判据带 IS NOT NULL——没设昵称的账号会一起落进 NULL 组，少了它"三个人都没设昵称"会被报成重名组');
// ④ 的**分组口径必须与 ①/⑤ 和索引逐字相同**。20261003 生产实跑踩到：原来写的是
// `PARTITION BY nickname`（原始值），4 个没设昵称的账号共享空串 ⇒ 落进同一分区、
// rn = 1..4 ⇒ 其中 3 行被改成 `_<id>` 并置了自动改名标记。而 ①/⑤ 都带 `IS NOT NULL`、
// 报"0 个重名组"——**两句并列出现而不矛盾**，正是这个 bug 最难自己发现的地方。
// 所以这两条不是"把字符串换成新的"，而是把"全文件只有一种口径"变成可执行的判据。
ok(migration.includes("ROW_NUMBER() OVER (PARTITION BY NULLIF(TRIM(nickname), '') ORDER BY id)"),
    '存量去重的**分组口径 == 索引口径**（不是原始的 nickname）——按原始值分组会把空昵称账号算成一族');
ok(/WHERE NULLIF\(TRIM\(nickname\), ''\) IS NOT NULL/.test(migration),
    '④ 的派生表**排除空昵称**：NULL 在窗口分区里互为 peer，只换成 NULLIF 而不加 WHERE 等于 bug 挪个位置');
ok(!/PARTITION BY (?!NULLIF)/.test(strip(migration)) && !/GROUP BY nickname\b/.test(strip(migration)),
    '全文件再无**裸 nickname 分组**（strip 掉注释后仍不许出现——注释里刻意留着旧写法当反例）');
ok(migration.includes('ROW_NUMBER() OVER'), '存量去重按注册先后编号（最早的保留原名）');
ok(/nickname_auto_renamed` tinyint\(1\) NOT NULL DEFAULT 0/.test(migration),
    '新增标记列 nickname_auto_renamed，默认 0');
ok(migration.includes("AFTER `nickname`"), '列序 AFTER nickname（与 entity 的字段顺序一致）');
ok(migration.includes("SET u.nickname = CONCAT(LEFT(TRIM(u.nickname), 64 - CHAR_LENGTH(CONCAT('_', u.id))), '_', u.id)"),
    '改名用 LEFT(...) 截到留得下后缀，不会把 varchar(64) 撑爆');
ok(migration.indexOf('ADD UNIQUE KEY') < migration.indexOf("VALUES ('nickname_unique_20261002')"),
    '打 flag 在建索引之后');
ok(/回滚[\s\S]*DROP INDEX `uk_user_nickname`/.test(migration), '回滚段里有 DROP INDEX');

console.log('\nRust 实体 —— 列必须与迁移同时在场：');
ok(/pub nickname_auto_renamed: i8,/.test(entityRs),
    'entity 有 nickname_auto_renamed: i8（tinyint(1) → i8）');
ok(entityRs.includes('nickname_unique_20261002.sql'),
    '实体注释里指回迁移文件（改列的人得知道有份迁移要跑）');

console.log('\nRust 写入侧 —— 唯一性的三条腿：');
const upBody = profileRs.slice(profileRs.indexOf('pub async fn update_profile'));
ok(upBody.includes('const NICKNAME_TAKEN') || profileRs.includes('const NICKNAME_TAKEN'),
    '重复话术是**一个常量**（预检与 1062 兜底回同一句）');
ok(/Column::Id\.ne\(uid\)[\s\S]{0,200}Column::Nickname\.eq\(nick\)/.test(upBody),
    '预检排除了自己那一行（否则"把自己的昵称改成同一个"会自己撞自己）');
ok(upBody.includes('if taken.is_some()'), '预检命中 → 友好提示');
ok(upBody.includes('am.nickname_auto_renamed = Set(0)'),
    '改昵称同时清 nickname_auto_renamed（横幅的唯一出口）');
ok(upBody.includes('if is_duplicate_key(&e)'), 'Err 分支再认一次 1062（兜住两个请求同时提交的竞态）');
ok(upBody.includes('is_duplicate_key(&e)') && upBody.includes('NICKNAME_TAKEN'),
    '1062 回的是同一句话术，不是「保存失败，请稍后再试」');
ok(upBody.includes('tracing::error!'), '错误原文只进 tracing');
function dupFn() {
    const i = profileRs.indexOf('fn is_duplicate_key');
    return i < 0 ? '' : profileRs.slice(i, i + 900);
}
ok(dupFn().includes('as_database_error') && /matches!\(c\.as_ref\(\), "1062"/.test(dupFn()),
    'is_duplicate_key 走**错误码**，不是 `contains("Duplicate entry")`（后者会把别人的报错也算成重复键）');
ok(!strip(dupFn()).includes('to_string().contains'),
    '代码里没有字符串匹配错误信息那一套');

console.log('\nDTO —— 跨语言键名：');
ok(authRs.includes('#[serde(rename = "nicknameAutoRenamed")]'),
    'ProfileDto 用驼峰线上键名（本仓 DTO 口径，同 oldPassword）');
ok(/nickname_auto_renamed: u\.nickname_auto_renamed != 0/.test(authRs),
    'profile() 把列翻译成 bool 再出接口（不是把 i8 直接吐出去）');

console.log('\n前端 —— 类型与横幅：');
ok(/nicknameAutoRenamed\?: boolean/.test(types),
    'ProfileType 里是**可选**字段（缺失 = 老后端 = 不显示横幅）');
ok(pageTsx.includes('{profile?.nicknameAutoRenamed && ('),
    '横幅用 `profile?.nicknameAutoRenamed &&` 门控（undefined 安静地不渲染）');
ok(pageTsx.includes('你的昵称和其他用户重复了'), '横幅标题是这句话');
const iBanner = pageTsx.indexOf('ucNickBanner');
const iField = pageTsx.indexOf('<span className="ucLabel">昵称</span>');
ok(iBanner > 0 && iField > iBanner, '横幅排在昵称输入框**之前**（说的是"去改掉"，改的地方就在下一行）');
ok(pageTsx.includes("import { Alert,"), 'Alert 已从 antd 引入');
ok(/\.ucNickBanner[\s\S]{0,160}\.ant-alert-message/.test(sass),
    'sass 把字号落在 antd 自己的类上（写在 .ucNickBanner 上继承不下去）');
ok(!/\.ucNickBanner[\s\S]{0,300}background\s*:/.test(strip(sass)),
    '不写死底色（夜间走 darkAlgorithm，自写会翻车）');

console.log(`\nnickname-unique: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);

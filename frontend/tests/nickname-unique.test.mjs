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
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*--.*$/gm, '');

const profileRs = read('src/routes/profile.rs');
const authRs = read('src/routes/auth.rs');
const entityRs = read('src/entity/user.rs');
const migration = read('scripts/migration/pg/0000_schema.sql');
const pageTsx = readFe('src/components/UserCenter/index.tsx') + readFe('src/components/UserCenter/useUserCenterModel.tsx');
const types = readFe('src/interface/ProfileType.d.ts');
const sass = readFe('src/components/UserCenter/index.sass');

console.log('PostgreSQL 昵称约束：');
ok(/CREATE UNIQUE INDEX IF NOT EXISTS "uk_user_nickname" ON "user" \(\(NULLIF\(TRIM\("nickname"\), ''\)\)\)/.test(migration),
    '当前 PostgreSQL 对非空白昵称建立表达式唯一索引');
ok(/"nickname_auto_renamed" smallint NOT NULL DEFAULT 0/.test(migration),
    '当前基线保留自动更名标记，默认值为 0');

console.log('\nRust 实体 —— 列必须与迁移同时在场：');
ok(/pub nickname_auto_renamed: i16,/.test(entityRs),
    'entity 有 nickname_auto_renamed: i16（PG smallint）');

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
ok(dupFn().includes('as_database_error') && /matches!\(c\.as_ref\(\),[^)]*"1062"/.test(dupFn()),
    'is_duplicate_key 走**错误码**，不是 `contains("Duplicate entry")`（后者会把别人的报错也算成重复键）');
ok(/"23505"/.test(dupFn()),
    'PG 的唯一键冲突码 23505 与 MySQL 的 1062 并列在同一处 —— 切库后前者才是真会命中的那个');
ok(!strip(dupFn()).includes('to_string().contains'),
    '代码里没有字符串匹配错误信息那一套');

console.log('\nDTO —— 跨语言键名：');
ok(authRs.includes('#[serde(rename = "nicknameAutoRenamed")]'),
    'ProfileDto 用驼峰线上键名（本仓 DTO 口径，同 oldPassword）');
ok(/nickname_auto_renamed: u\.nickname_auto_renamed != 0/.test(authRs),
    'profile() 把列翻译成 bool 再出接口（不是把整数宽度直接吐出去）');

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

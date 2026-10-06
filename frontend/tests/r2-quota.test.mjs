// ═ 图库 R2 图床：用量条与"能不能传"的纯映射（20261006，用户第 3 条）══
//   node tests/r2-quota.test.mjs
//
// 现场（用户要求）：图库可以把图片传到 R2 存储桶，**严格控制用量、超过 9.5G 直接停用上传**，
// 防止产生账单。于是后台多了一条用量条、一颗能被灰掉的上传按钮 —— 这两个面是用户唯一
// 看得见的"会不会产生账单"。它们只要与真正拦人的那条判据分家，就会出现
// "条子显示 30%、上传却被拒"这种没人能解释的状态。
//
// 所以本套件钉两层：
//  ① 纯映射本身的边界（GiB 口径、百分比钳位、恰好等于上限、读数不可信时的显示）；
//  ② **跨语言守卫**（读 `src/r2.rs` / `src/routes/upload.rs` / `src/routes/mod.rs`）：
//     前端这份判据、键名、单位必须与 Rust 那份同形，外加**配置只有一处入口**
//     （20261006 起：表单在站点设置·图库存储，图库页只留用量与灰态）。形状一变就红
//     —— 这一层才是本套件真正在防的东西，第 ① 层只是它的前提。
//
// 为什么进 CI：全是纯函数（无 DOM 无 React），而它们判错的表现是"账单"或"假成功"。
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');            // frontend/
const repo = path.resolve(root, '..');            // 父仓根

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

// 纯 TS（无 DOM 无 React）⇒ 摊平成 .mjs 直接 import
const out = mkdtempSync(path.join(tmpdir(), 'r2quota-'));
const file = path.join(out, 'r2Quota.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/r2Quota.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
});
const { DEFAULT_QUOTA_GB, gibToBytes, bytesToGib, usagePercent, isOverQuota,
        uploadBlocked, usageText, formatGib } = await import(pathToFileURL(file).href);

const GIB = 1024 ** 3;
/** 1 GiB 的字节数（**不是** 10^9：本仓"GB"一律按 1024³ 算，见 ①）。 */
const ONE_GB = GIB;

/** 造一份读数（默认是一份"一切正常、用了一半"的读数，用例只覆盖自己关心的字段）。 */
const usage = (over = {}) => ({
    enabled: true, configured: true, credentials: true,
    bucket: 'b', prefix: 'gallery', publicBase: 'https://img.example.com',
    quotaGB: DEFAULT_QUOTA_GB, limitBytes: gibToBytes(DEFAULT_QUOTA_GB), usedBytes: gibToBytes(DEFAULT_QUOTA_GB) / 2,
    listError: null, ...over,
});

console.log('\n① 单位：GB 实为 GiB（1024³），与 Rust 同一把尺子');
{
    ok(gibToBytes(1) === GIB, '1 GB = 1024³ 字节（不是 10^9）', gibToBytes(1));
    // ⚠️ 这个数在两处各钉一次：这里与 src/r2.rs 的 quota_boundaries。
    // 两边一起改才算改对 —— 只改一处时，这条断言会红。
    ok(gibToBytes(DEFAULT_QUOTA_GB) === 10200547328,
        `默认配额 ${DEFAULT_QUOTA_GB} GB = 10200547328 字节（= 10.2 个十进制 GB）`,
        gibToBytes(DEFAULT_QUOTA_GB));
    ok(bytesToGib(GIB) === 1, 'bytesToGib(1024³) = 1');
    ok(Math.abs(bytesToGib(gibToBytes(0.5)) - 0.5) < 1e-9, '往返无漂移');
    ok(DEFAULT_QUOTA_GB === 9.5, '默认配额就是用户点名的那条线：9.5');
}

console.log('\n② 用量条百分比：恒在 0..100，算不出来时不许显示成"很空"');
{
    const limit = ONE_GB;
    ok(usagePercent(0, limit) === 0, '空桶 = 0%');
    ok(usagePercent(limit / 2, limit) === 50, '一半 = 50%');
    ok(usagePercent(limit, limit) === 100, '恰好等于上限 = 100%');
    ok(usagePercent(limit * 2, limit) === 100, '超了也钳在 100（Progress 收到 200 只会画怪）');
    ok(usagePercent(-5, limit) === 0, '负值（脏读数）钳到 0');
    ok(usagePercent(0, 0) === 100, '上限为 0/缺省 ⇒ 100，**不是 0**');
    ok(usagePercent(0, NaN) === 100, '上限是 NaN ⇒ 100（不显示成空）');
}

console.log('\n③ 超限判据：与服务端 `quota_exceeded` 同一条（严格大于的等价位）');
{
    const limit = ONE_GB;
    ok(isOverQuota(limit - 1, limit) === false, '差 1 字节 ⇒ 还能传');
    ok(isOverQuota(limit, limit) === true, '恰好等于上限 ⇒ 灰（任何非空文件都会被拒）');
    ok(isOverQuota(limit + 1, limit) === true, '已超 ⇒ 灰');
    ok(isOverQuota(0, 0) === true, '配额没配出正数 ⇒ 灰（不冒超支的险）');
    ok(isOverQuota(0, -1) === true, '负数配额 ⇒ 灰');
}

console.log('\n④ 上传按钮的灰态（返回原因串是要给人看的）');
{
    // 没配 / 还没拉到读数 ⇒ 不灰：界面不抢在数据前面拦人（拉取失败多半是刚打开页面）
    ok(uploadBlocked(null).blocked === false, '读数还没到 ⇒ 不灰');
    ok(uploadBlocked(usage({ configured: false })).blocked === false, 'R2 未配置 ⇒ 不灰（走本地盘）');
    ok(uploadBlocked(usage({ enabled: false, configured: false })).blocked === false, '开关关着 ⇒ 不灰');

    const full = uploadBlocked(usage({ usedBytes: gibToBytes(DEFAULT_QUOTA_GB) }));
    ok(full.blocked === true, '刚好用满 ⇒ 灰');
    ok(full.reason.includes('9.50 GB') && full.reason.includes('调高配额'),
        '灰的理由里带上了实际用量与上限', full.reason);

    const unreadable = uploadBlocked(usage({ listError: '列桶失败：HTTP 403', usedBytes: 0 }));
    ok(unreadable.blocked === true, '读数不可信 ⇒ 灰（服务端 fail-closed，点了也只会被拒）');
    ok(unreadable.reason.includes('HTTP 403'), '把服务端给的失败原因原样带出来', unreadable.reason);

    ok(uploadBlocked(usage()).blocked === false, '用了一半 ⇒ 不灰');
}

console.log('\n⑤ 用量文案：读数不可信时只显示原因，绝不显示数字');
{
    const bad = usageText(usage({ listError: 'R2 凭据没配', usedBytes: 0 }));
    ok(bad.ok === false, '读数不可信 ⇒ ok=false（调用方据此转灰）');
    ok(bad.text === 'R2 凭据没配', '显示的就是原因原文', bad.text);
    // 判据落在"体积/百分比"上而不是"整串无数字"：原因原文里出现 "R2"、端口号之类的数字是
    // 合法的，不该为此变红 —— 要拦住的是 "0.00 GB"「0%」这种会被读成"用量是 0"的形状。
    ok(!/[\d.]+\s*(GB|GiB|MB)|%/.test(bad.text), '**不许出现用量数字或百分比**（"0.00 GB" 会被读成"用量是 0"）', bad.text);

    const good = usageText(usage({ usedBytes: gibToBytes(5), limitBytes: gibToBytes(10) }));
    ok(good.ok === true, '读数可信 ⇒ ok=true');
    ok(good.text.includes('5.00 GB') && good.text.includes('10.00 GB') && good.text.includes('50%'),
        '可信时三样都在（已用/上限/百分比）', good.text);
    ok(usageText(null).ok === false, '还没拉到读数 ⇒ ok=false（不显示 0%）');
    ok(formatGib(0) === '0.00 GB', 'formatGib(0) 是给人看的 0.00 GB');
}

console.log('\n⑥ 跨语言守卫：前端的判据/键名/单位必须与 Rust 同形，且配置只有一处入口');
{
    const rust = readFileSync(path.join(repo, 'src/r2.rs'), 'utf8');
    const upload = readFileSync(path.join(repo, 'src/routes/upload.rs'), 'utf8');
    const mod = readFileSync(path.join(repo, 'src/routes/mod.rs'), 'utf8');
    const albums = readFileSync(path.join(root, 'src/pages/Dashboard/Albums/index.tsx'), 'utf8');
    const form = readFileSync(path.join(root, 'src/pages/Dashboard/UserControl/R2Storage.tsx'), 'utf8');
    const self = readFileSync(path.join(root, 'src/utils/r2Quota.ts'), 'utf8');

    ok(/pub const DEFAULT_QUOTA_GB: f64 = 9\.5;/.test(rust),
        'Rust `DEFAULT_QUOTA_GB` 仍是 9.5（用户点名的那条线）');
    ok(/pub fn quota_exceeded\(used: u64, incoming: u64, limit: u64\) -> bool \{[\s\S]*?saturating_add\(incoming\) > limit/.test(rust),
        'Rust `quota_exceeded` 仍是 `used + incoming > limit`（严格大于；`>=` 会让等于上限的那一张被拒）');
    // 单位必须两边都是 1024³：Rust 那边算字节、前端这边算显示
    ok(rust.includes('1024.0 * 1024.0 * 1024.0'), 'Rust 侧的 GiB 是 1024³');
    ok(upload.includes('bytes as f64 / (1024.0 * 1024.0 * 1024.0)'), 'Rust 把字节换算回 GB 用的是同一个 1024³');
    ok(/const GIB = 1024 \* 1024 \* 1024;/.test(self), '前端这份也是 1024³（改成 1000 会与服务端分家）');

    // 五个键名：Rust 常量是本仓的唯一事实源，页面提交的载荷必须逐字与它一致
    const keys = [...rust.matchAll(/"(r2Image[A-Za-z]+)"/g)].map((m) => m[1]);
    const declared = [...new Set(keys)].sort();
    ok(declared.length === 5, `Rust \`R2_KEYS\` 仍是五个键名`, declared);
    const used = [...new Set([...form.matchAll(/r2Image[A-Za-z]+/g)].map((m) => m[0]))].sort();
    ok(used.length === 5 && used.every((k, i) => k === declared[i]),
        '图库存储页签提交/读取的五个字段名与 R2_KEYS 逐个相同（改名漏一处 = 面板填了不生效）',
        { declared, used });
    // **配置只有一处入口**（20261006 用户拍板「挪到站点设置，单一入口」）：图库页
    // 从此一个 `r2Image*` 键都不该有。谁要把表单加回去，先看这条 —— 同一份数据挂两个
    // 表单，结果是"改了一处、另一处还是旧值"，谁也说不清以哪个为准。
    ok(!/r2Image[A-Za-z]*/.test(albums),
        '图库页不再出现任何 r2Image* 键（配置的唯一入口是站点设置·图库存储）');
    // 那颗按钮必须真的跳过去（它现在只是入口，跳错地方 = 点开啥也改不了）
    ok(albums.includes("navigate('/dashboard/usercontrol'") && /tab:\s*'4'/.test(albums),
        '图库页那颗「R2 存储」按钮跳向站点设置的图库存储页签');
    ok(form.includes("getR2Usage") && form.includes("'/api/protected/websetting'"),
        '图库存储页签自己读用量（/api/protect/images/r2）与存值（/api/protected/websetting）');

    // 读取用的路由名与 Rust 挂的那条必须一致（否则用量永远读不到，条子恒显示"读取中"）
    const api = readFileSync(path.join(root, 'src/apis/ImageMethods.tsx'), 'utf8');
    ok(mod.includes('"/api/protect/images/r2"') && api.includes("'/api/protect/images/r2'"),
        '用量接口的路径两边一致（Rust 挂载点 vs 前端请求）');
    // 这条路由必须挂在"要登录"的那组上：用量是运维读数，别顺手挪到公开组
    // （按行号切出 protected_routes 那一块来判，不是全文找一遍关键字 —— 那样挪走了也照样绿）
    const lines = mod.split('\n');
    const pstart = lines.findIndex((l) => l.includes('let protected_routes'));
    const tail = lines.slice(pstart + 1);
    const pend = tail.findIndex((l) => /let \w+_routes\s*=\s*Router::new\(\)/.test(l));
    const block = pend < 0 ? tail : tail.slice(0, pend);
    ok(pstart >= 0 && block.some((l) => l.includes('"/api/protect/images/r2"')),
        '用量接口挂在 `protected_routes` 那一块里（挪出这一块 = 匿名可读运维读数）');

    // JSON 字段名：Rust 用 camelCase 序列化，前端按 camelCase 读
    ok(/#\[serde\(rename_all = "camelCase"\)\]/.test(upload) && /pub list_error: Option<String>/.test(upload),
        'Rust `R2Usage` 用 camelCase 序列化 `list_error`');
    ok(self.includes('listError'),
        '前端那份读的就是 `listError`（缺它就会把"读不到"当"很空"）');
    // 前端不许绕过那份判据自己写"能不能传"（第二份判据 = 条子与按钮迟早各说各话）。
    // 两个面都查：图库页（灰态）与站点设置那页（条子）。
    for (const [where, src] of [['图库页', albums], ['图库存储页签', form]]) {
        ok(!/limitBytes\s*[<>]=?|>=?\s*\w*\.?limitBytes/.test(src),
            `${where}没有第二份超限判据（一律走 utils/r2Quota）`);
    }

    // ── 上传目标（20261006，用户第 1 条）：图库页两颗按钮分别上传 ─────────────
    // 契约两侧都锁：Rust 只认 local / r2，前端只拼这两个字面量。这条链路里最贵的错
    // 是"打错一个字就悄悄按缺省处理"——人以为传到了 R2，图却躺在服务器上。
    ok(/Some\("local"\)\s*=>\s*Some\(UploadTarget::Local\)/.test(upload)
        && /Some\("r2"\)\s*=>\s*Some\(UploadTarget::R2\)/.test(upload),
        'Rust 的 `target` 认 `local` / `r2` 两个字面量');
    ok(/Some\(_\)\s*=>\s*None/.test(upload),
        '认不出的 target 返回 None ⇒ 调用方**报错**（不是按缺省处理）');
    // 结构判据：`local` 那一次必须**整段跳过** R2 —— 这正是"R2 开着时服务器那条路还能用"
    // 的实现。哪天有人把这段合并回"先试 R2、失败再本地"，这条会红。
    ok(/if target != UploadTarget::Local \{[\s\S]*?try_r2_upload\(/.test(upload),
        '`target=local` 时不走 try_r2_upload（R2 开着也照样存本机盘）');
    ok(/async fn try_r2_upload\([\s\S]{0,300}?required: bool/.test(upload) && upload.includes('if required {'),
        '`try_r2_upload` 收 `required`：点名 R2 却没配全时返回错误，**绝不回落本机盘**');
    ok(/formData\.append\('target'/.test(api) && /'local' \| 'r2'/.test(api),
        '前端只在 ImageMethods 一处拼 `target` 字段名，取值就是那两个（改名漏一处 = 静默走缺省）');
    ok(/uploadImages\(formData,\s*uploadTarget\)/.test(albums),
        '图库页把自己选的那颗钮的 target 传下去（不传 = 又变成由面板开关替用户决定）');
}

console.log(`\n${pass}/${pass + fail} 项通过`);
if (fail > 0) process.exit(1);

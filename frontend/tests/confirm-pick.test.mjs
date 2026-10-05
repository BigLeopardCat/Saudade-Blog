// ═ 确认卡「只办其中一件」（20260929 批 F）══
//   node tests/confirm-pick.test.mjs
// 背景：确认卡从"两枚按钮（确定/取消）"扩成"全部办 + 逐条只办第 i 件 + 取消"，
//   按钮的值走既有的 `data-ask-value` 通道（`pick:<i>`，0 基下标），点下去带
//   `confirm_pick` 发隐藏请求，服务端在验签之后按它把**已签名**的清单收窄
//   （见 agent/confirm.py::narrow——只可能变小，读不懂就零执行）。
//
// 本测试锁的是**前端那一半的判据**（源码级，同 agent-cmd-program-only 的扫法）：
//   ① 取消判据只有 `'no'`。旧写法是「不等于 yes 就算取消」——卡上多了挑选按钮之后，
//      那一条会把**每一次挑选都当成取消**：卡片写「已取消」、系统一件都不办，而主人
//      以为自己办了一件。这是本批最容易悄悄复发的一处（改动小、看着无害）。
//   ② 挑选值原样带进隐藏请求（`confirmPick` → 请求体的 `confirm_pick`），且
//      「全部办」传空串（空 = 不传 = 旧语义，旧客户端逐字兼容）。
//   ③ 卡片重建时按钮值仍来自帧里的 `opts`（不是写死两枚）——自愈钩子重建卡片时
//      若丢了下标，主人点「只办 1」会退化成「全部办」。
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(path.join(here, '../public/live2d-widgets/chat-stream.js'), 'utf8');
// 判据扫的是**代码**，注释里提到旧写法不算数（本批的注释恰恰在解释它为什么被换掉）
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
const code = strip(raw);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; return; }
    fail++;
    console.log('  ✗ ' + name + (extra ? '\n      ' + extra : ''));
};

// ── ① 只有「取消」是取消 ─────────────────────────────────────────────────────
{
    ok(/if \(value === 'no'\)/.test(code), "取消判据是 `value === 'no'`");
    ok(!/value !== 'yes'/.test(code), '  旧判据「不等于 yes 就算取消」已不在代码里',
       '它会把「只办第 i 件」当成取消：卡片写已取消、系统一件都不办');
    ok(!/value != 'yes'/.test(code), '  同一条的宽松写法也没留下');
    // 取消分支必须**早退**且在结算文案之前——否则挑选按钮会先被写成"已取消"
    const iNo = code.indexOf("if (value === 'no')");
    const iSettle = code.indexOf("askSettle('已取消'", iNo);
    ok(iNo > 0 && iSettle > iNo, '  取消分支里结算成「已取消」（且在这一支之内）');
}

// ── ② 挑选值进隐藏请求 ───────────────────────────────────────────────────────
{
    ok(/confirmPick: \(value === 'yes' \? '' : String\(value\)\)/.test(code),
       "挑选值原样带进 sendMessage（`confirmPick`），「全部办」传空串");
    const iPick = code.indexOf('confirmPick:');
    const iMsg = code.indexOf('message: ask.msg ||', iPick);
    ok(iPick > 0 && iMsg > iPick, '  它挂在同一个隐藏请求上（confirmToken 那条通路旁）');
    ok(/opts\.confirmPick/.test(code), '  请求体按 `opts.confirmPick` 透传（空串不传字段）');
    ok(/'confirm_pick'|confirm_pick:/.test(code), '  字段名与 Python/Rust 侧一致：`confirm_pick`');
    // 只在那条隐藏请求上带：普通发言绝不能带这个字段
    const iBody = code.indexOf('confirm_pick');
    const iGuard = code.lastIndexOf('silent && opts.confirmToken', iBody);
    ok(iGuard > 0 && iBody - iGuard < 400, '  且由 `silent && opts.confirmToken` 把着（普通发言不带）');
}

// ── ③ 卡片重建：按钮值仍来自帧里的 opts ──────────────────────────────────────
{
    ok(/b\.setAttribute\('data-ask-value', op\.value \|\| 'yes'\)/.test(code),
       '按钮的 data-ask-value 取自帧里的 opts（不是写死两枚）');
    ok(/\(ask\.opts \|\| \[\]\)\.forEach/.test(code),
       '  重建时逐个渲染 opts（N 枚按钮的自愈路径与首渲染同源）');
}

// ── ④ 卡片内改口（20261006）：「其他（我来说）」是**入口**，不是选择记号 ──────
// 点它不结算、不发请求，只把卡片里的输入行露出来；提交出去的是**普通新轮**
// （非 silent、不带 confirmToken/confirmPick）。它一旦漏进下面那条隐藏确认请求，
// 服务端 `confirm.narrow` 对认不出的取值 fail-closed（零执行），而卡片已经写成
// 「确认中…」——屏幕上看不出异常、系统里一个字节都没动。所以这里锁**两件事**：
// 这一支在不在，以及它在不在"结算 → 发请求"那条路之前。
{
    ok(/if \(value === 'other'\)/.test(code), "改口的拦截支在场（`value === 'other'`）");
    const iOther = code.indexOf("if (value === 'other')");
    const iSettle = code.indexOf("askSettle('确认中…'");
    const iPick = code.indexOf('confirmPick:');
    ok(iOther > 0 && iSettle > iOther && iPick > iOther,
       '  且排在「确认中…」结算与 confirmPick 隐藏请求**之前**',
       '排在后面 = 卡片结算了、服务端 fail-closed 拒掉、零执行');
    ok(code.indexOf("if (value === 'no')") > iOther,
       '  「取消」那一支仍在它之后（两个早退的相对次序没被换过）');
    // 露输入框那一半必须**只**露输入框：这里是"还没做结论"的时刻，一旦顺手
    // 写了结算文案，卡片就有了一个不作数的结论。（取到这一支自己的 `return;`
    // 为止，不往后扫——后面正常路径上的结算不该算到它头上。）
    const seg = code.slice(iOther, code.indexOf('return;', iOther));
    ok(seg.length > 0 && !/askSettle\(/.test(seg),
       '  拦截支内没有任何结算调用（此刻卡片仍 live）');
    ok(/reveal/i.test(seg), '  它做的是"露出输入行"（reveal），不是别的');
}

console.log(`\n${pass} 项通过` + (fail ? `、${fail} 项失败` : ''));
process.exit(fail ? 1 : 0);

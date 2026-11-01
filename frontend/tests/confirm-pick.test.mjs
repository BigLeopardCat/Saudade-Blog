// 当前确认交互的来源、撤销、选项与模块边界回归。
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = ['chat-stream.js', 'chat-approval.js'].map(file =>
    readFileSync(path.join(here, '../public/live2d-widgets', file), 'utf8')).join('\n');
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

{
    ok(/if \(value === 'no'\)/.test(code), "取消判据是 `value === 'no'`");
    ok(!/value !== 'yes'/.test(code), '  旧判据「不等于 yes 就算取消」已不在代码里',
       '它会把「只办第 i 件」当成取消：卡片写已取消、系统一件都不办');
    ok(!/value != 'yes'/.test(code), '  同一条的宽松写法也没留下');
    ok(/if \(value === 'no'\) \{ cancelAsk\(ask\); return; \}/.test(code),
       '取消分支请求服务端撤销后早退，不进入确认执行');
    const start = code.indexOf('const cancelAsk = async');
    const end = code.indexOf('const handleAskChoice', start);
    const cancellation = code.slice(start, end);
    ok(cancellation.includes("fetch('/api/chat/confirmation/cancel'"), '撤销必须请求服务端');
    ok(cancellation.indexOf('body.cancelled !== true') < cancellation.indexOf("askSettle('已撤销"),
       '服务端确认撤销后才能显示已撤销');

}

{
    ok(/confirmPick: \(value === 'yes' \? '' : String\(value\)\)/.test(code),
       "挑选值原样带进 sendMessage（`confirmPick`），「全部办」传空串");
    const iPick = code.indexOf('confirmPick:');
    const hidden = code.slice(code.lastIndexOf('sendMessage({', iPick), code.indexOf('});', iPick));
    ok(hidden.includes('confirmToken: ask.token') && hidden.includes("message: ''"),
       '隐藏批准携带凭据与选择，不添加合成用户发言');
    ok(/opts\.confirmPick/.test(code), '  请求体按 `opts.confirmPick` 透传（空串不传字段）');
    ok(/'confirm_pick'|confirm_pick:/.test(code), '  字段名与 Python/Rust 侧一致：`confirm_pick`');
    const iBody = code.indexOf('confirm_pick');
    const iGuard = code.lastIndexOf('silent && opts.confirmToken', iBody);
    ok(iGuard > 0 && iBody - iGuard < 400, '  且由 `silent && opts.confirmToken` 把着（普通发言不带）');
}

{
    ok(/b\.setAttribute\('data-ask-value', op\.value \|\| 'yes'\)/.test(code),
       '按钮的 data-ask-value 取自帧里的 opts（不是写死两枚）');
    ok(/\(ask\.opts \|\| \[\]\)\.forEach/.test(code),
       '  重建时逐个渲染 opts（N 枚按钮的自愈路径与首渲染同源）');
}

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
    const seg = code.slice(iOther, code.indexOf('return;', iOther));
    ok(seg.length > 0 && !/askSettle\(/.test(seg),
       '  拦截支内没有任何结算调用（此刻卡片仍 live）');
    ok(/reveal/i.test(seg), '  它做的是"露出输入行"（reveal），不是别的');
}

console.log(`\n${pass} 项通过` + (fail ? `、${fail} 项失败` : ''));
process.exit(fail ? 1 : 0);

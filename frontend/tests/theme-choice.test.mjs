import { execFileSync } from 'child_process';
import { runtime, frame, sse } from './helpers/widget-runtime.mjs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = mkdtempSync(path.join(tmpdir(), 'thm-'));

const RealDate = Date;
let NOW = 0;
class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
    static now() { return NOW; }
}
globalThis.Date = FakeDate;

const at = (h, m = 0, day = 15) => { NOW = new RealDate(2026, 8, day, h, m, 0).getTime(); };

const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
};

function bundle(rel, name) {
    const file = path.join(out, name);
    execFileSync(path.join(root, 'node_modules/.bin/esbuild'), [
        path.join(root, rel), '--bundle', '--format=esm', '--platform=node',
        `--outfile=${file}`, '--log-level=error',
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
    return file;
}

const theme = await import(bundle('src/theme.ts', 'theme.mjs'));

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (got, want, name) => ok(got === want, name, { got, want });

function tick(now) {
    const next = theme.autoThemeDecision(now);
    if (next !== null) localStorage.setItem('isDarkMode', JSON.stringify(next));
    return next;
}
const dark = () => theme.readDarkMode();

console.log('== 23:00 进窗：自动切夜，且只切一次 ==');
{
    store.clear(); at(22, 59);
    localStorage.setItem('isDarkMode', '"false"');
    eq(tick(new Date()), null, '22:59（窗口外）：完全不动');

    at(23, 0);
    eq(tick(new Date()), true, '23:00 进窗：自动切夜一次');
    eq(dark(), true, '状态已落到夜间');

    for (const m of [[23, 1, 15], [23, 2, 15], [23, 30, 15], [0, 15, 16], [5, 58, 16], [5, 59, 16]]) {
        at(m[0], m[1], m[2]);
        eq(tick(new Date()), null, `${String(m[0]).padStart(2, '0')}:${String(m[1]).padStart(2, '0')} 窗内不再动作`);
    }
    eq(dark(), true, '整段夜窗保持夜间');
}

console.log('== 窗口内访客自己改：让位，本窗口不再自动改 ==');
{

    store.clear(); at(23, 30);
    localStorage.setItem('isDarkMode', '"true"');
    eq(tick(new Date()), null, '已夜间 → 入窗不动作');
    theme.recordUserChoice('light');
    localStorage.setItem('isDarkMode', '"false"');
    let cur = false;

    for (const m of [[23, 31, 15], [0, 15, 16], [3, 40, 16], [5, 59, 16]]) {
        at(m[0], m[1], m[2]);
        const d = tick(new Date());
        if (d !== null) cur = d;
    }
    eq(cur, false, '窗内切浅色后每分钟都不再被顶回夜间');
}
{

    store.clear(); at(22, 50);
    localStorage.setItem('isDarkMode', '"false"');
    theme.recordUserChoice('dark');
    at(23, 0);
    eq(tick(new Date()), null, '进窗前已有的意愿 → 边界让位，不改成夜间');
}
{

    store.clear(); at(2, 0);
    localStorage.setItem('isDarkMode', '"false"');
    theme.recordUserChoice('dark');
    ok(theme.userChoiceActive(), '深夜手动切夜间记意愿');
    eq(tick(new Date()), null, '深夜入窗（闩未处理）也不动作：已是夜间且有意愿');
}

console.log('== 06:00 出窗：切回白天 + 清意愿与闩 ==');
{
    store.clear(); at(23, 0, 15);
    localStorage.setItem('isDarkMode', '"false"');
    eq(tick(new Date()), true, '23:00 进窗切夜');
    at(5, 59, 16);
    eq(tick(new Date()), null, '05:59 仍在窗内（主题日未翻篇）→ 不动');
    eq(dark(), true, '凌晨仍是夜间');
    at(6, 0, 16);
    eq(tick(new Date()), false, '06:00 出窗：切回白天');
    eq(dark(), false, '状态已回日间');
    ok(!theme.userChoiceActive(), '出窗顺手清掉意愿（新的一天重新开始）');
    ok(!localStorage.getItem('darkModeInWindow'), '出窗闩也清了');
    at(6, 1, 16);
    eq(tick(new Date()), null, '出窗后不再动作');

    at(23, 0, 16);
    eq(tick(new Date()), true, '次日 23:00 又能自动切夜（闩已复位）');
}
{

    store.clear(); at(23, 30, 15);
    localStorage.setItem('isDarkMode', '"true"');
    eq(tick(new Date()), null, '入窗：已夜间 → 不动作');
    theme.recordUserChoice('light');
    localStorage.setItem('isDarkMode', '"false"');
    at(6, 0, 16);
    eq(tick(new Date()), null, '出窗时已是白天 → 不重复切');
    ok(!theme.userChoiceActive(), '意愿照样清空');
}

console.log('== 06:00-23:00 完全遵循访客：旧 bug 的防线 ==');
{
    store.clear(); at(14, 0);
    localStorage.setItem('isDarkMode', '"true"');
    eq(tick(new Date()), null, '白天无意愿的夜间模式：不动它');
    theme.recordUserChoice('dark');
    let cur = true;
    for (let i = 1; i <= 3; i++) {
        at(14, i);
        const d = tick(new Date());
        if (d !== null) cur = d;
    }
    eq(cur, true, '连跑 3 分钟仍是夜间');

    store.clear(); at(14, 0);
    localStorage.setItem('darkModeUserChoice', 'dark');
    localStorage.setItem('darkModeChoiceDay', theme.currentThemeDay());
    theme.recordUserChoice('light');
    ok(!theme.userChoiceActive(), '白天切浅色 → 标记被清（不否掉当晚的自动切夜）');
    eq(tick(new Date()), null, '白天 + 浅色：不动');

    at(23, 0);
    eq(tick(new Date()), true, '当晚 23:00 照常自动切夜');
}

console.log('== 页面整夜关着 / 窗口内才打开 ==');
{
    store.clear(); at(23, 0, 15);
    localStorage.setItem('isDarkMode', '"false"');
    eq(tick(new Date()), true, '睡前 23:00 切夜');
    at(9, 0, 16);
    eq(tick(new Date()), false, '开机第一次 tick 补上出窗：切回白天');
    eq(dark(), false, '状态已回日间');
    ok(!theme.userChoiceActive(), '意愿也清了');
    at(9, 1, 16);
    eq(tick(new Date()), null, '之后不再动作');
}
{

    store.clear(); at(2, 0);
    localStorage.setItem('isDarkMode', '"false"');
    eq(tick(new Date()), true, '窗口内首次打开 → 切夜一次');
    at(2, 1);
    eq(tick(new Date()), null, '下一分钟不再动作');
}
{

    store.clear(); at(22, 0, 15);
    localStorage.setItem('isDarkMode', '"true"');
    at(8, 0, 16);
    eq(tick(new Date()), null, '整夜未进窗的夜间模式：白天打开也不动它');
    eq(dark(), true, '仍是访客选择的夜间');
}

console.log('== 跨主题日的边界状态独立生效 ==');
{

    store.clear(); at(23, 10, 15);
    localStorage.setItem('isDarkMode', '"true"');
    eq(tick(new Date()), null, '昨夜入窗：已是夜间 → 不动作（但闩已按昨夜的主题日置位）');
    eq(store.get('darkModeInWindow'), theme.currentThemeDay(), '闩记的是主题日，不是裸 \'1\'');
    theme.recordUserChoice('light');
    localStorage.setItem('isDarkMode', '"false"');

    at(23, 10, 16);
    eq(tick(new Date()), true, '今晚 23:10：陈旧闩不生效，照常自动切夜');
    eq(dark(), true, '状态落到夜间');
    eq(tick(new Date()), null, '今晚同一个夜窗内仍只处理一次（闩现在绑的是今晚）');
}
{

    store.clear(); at(23, 10, 16);
    localStorage.setItem('darkModeInWindow', '1');
    localStorage.setItem('isDarkMode', '"false"');
    eq(tick(new Date()), true, '存量裸 \'1\' 闩：今晚照常切夜（自愈）');
}
{

    store.clear(); at(23, 0, 15);
    localStorage.setItem('isDarkMode', '"false"');
    eq(tick(new Date()), true, '23:00 切夜');
    for (const h of [0, 3, 5]) {
        at(h, 30, 16);
        eq(tick(new Date()), null, `${String(h).padStart(2, '0')}:30 仍在同一主题日 → 不重复入场`);
    }
}

console.log('== 存储值归一化与组件命令 ==');
{
    store.clear(); at(23, 30);
    localStorage.setItem('darkModeUserChoice', 'true');
    ok(!theme.userChoiceActive(), '无日期的旧标记不生效');
    eq(tick(new Date()), true, '夜间无有效意愿 → 进窗自动切夜');
}
{
    store.clear(); at(22, 0);
    localStorage.setItem('isDarkMode', '"true"');
    theme.recordUserChoice('true');
    ok(theme.userChoiceActive(), "'true' 与 'dark' 等价（agent 开夜间也守住）");
}
{
    store.clear(); at(22, 0);
    theme.recordUserChoice('false');
    ok(!theme.userChoiceActive(), "窗口外 'false' 与 'light' 等价（不记）");
}

console.log('== 与 chat-stream.js 的 markVisitorChoice 对齐 ==');
{
    let enabled = false;
    const widget = runtime({ clock: FakeDate, respond: () => sse(
        frame('command', { kind: 'darkmode', mode: enabled ? 'on' : 'off' }) + frame('text', '已切换') + frame('done', {})) });
    const markVisitorChoice = async on => {
        enabled = on;
        widget.win.localStorage.removeItem('darkModeUserChoice');
        widget.win.localStorage.removeItem('darkModeChoiceDay');
        await widget.send('切换主题');
        for (const key of ['darkModeUserChoice', 'darkModeChoiceDay']) {
            const value = widget.win.localStorage.getItem(key);
            if (value === null) store.delete(key); else store.set(key, value);
        }
    };
    try {

        for (const c of [
            { name: '白天切夜间', h: 22, m: 10, theme: 'dark', chat: true },
            { name: '白天切浅色', h: 14, m: 0, theme: 'light', chat: false },
            { name: '夜间切浅色', h: 23, m: 30, theme: 'light', chat: false },
            { name: '夜间切夜间', h: 2, m: 0, theme: 'dark', chat: true },
        ]) {
            at(c.h, c.m); store.clear();
            theme.recordUserChoice(c.theme);
            const viaTheme = theme.userChoiceActive();
            at(c.h, c.m); store.clear();
            await markVisitorChoice(c.chat);
            const viaChat = theme.userChoiceActive();
            eq(viaChat, viaTheme, `${c.name}：theme.ts 与 chat-stream.js 同判（都 ${viaTheme ? '记' : '不记'}）`);
            if (viaChat) eq(store.get('darkModeChoiceDay'), theme.currentThemeDay(), `${c.name}：主题日也写成同一天`);
        }

        store.clear(); at(22, 10);
        await markVisitorChoice(true);
        eq(store.get('darkModeUserChoice'), 'true', '实际组件命令写入主题选择');
    } finally { widget.close(); }
}

console.log(`\n${failed === 0 ? '✓' : '✗'} theme-choice: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

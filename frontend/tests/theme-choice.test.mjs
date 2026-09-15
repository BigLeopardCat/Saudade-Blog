// ═ 主题意愿语义回归 ══
//   node tests/theme-choice.test.mjs
// 覆盖 20260915 修的「夜间模式 1 分钟后自动切回白天」：根因不在某一边，而在
// 「手动切换记意愿(recordUserChoice)」与「每分钟状态收敛(autoThemeDecision)」的交互里，
// 所以两半一起测。全站四个入口都走这两个函数：App.tsx 的 prefersAuto（分钟收敛）、
// Head 的桌面开关、PhoneSwitch 的移动开关、看板娘 chat-stream.js 的 DARKMODE 命令。
// theme.ts 是 TS，用 esbuild 单文件打包（本机禁止 vite build，见 CLAUDE.md §2）。
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = mkdtempSync(path.join(tmpdir(), 'thm-'));

// ── 假钟：theme.ts 读 new Date()（isNightHour）与 Date.now()（currentThemeDay）──
const RealDate = Date;
let NOW = 0;
class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
    static now() { return NOW; }
}
globalThis.Date = FakeDate;
/** 把钟面拨到 2026-09-15 起的第 day 天的 h:m（本地时区，与 theme 的判据同源） */
const at = (h, m = 0, day = 15) => { NOW = new RealDate(2026, 8, day, h, m, 0).getTime(); };

// ── 假 localStorage ──
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
};

// ⚠️ 这里**不能**加 --packages=external：临时包落在 /tmp，node 从那里解析不到
// frontend/node_modules，react 必须一起打进来。
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

// ══════════════════════════════════════════════
console.log('== 白天手动切夜间：必须活过分钟收敛（本次修的 bug）==');
{
    store.clear(); at(22, 10);                       // 前半夜：不是 23:00-6:00 窗口
    localStorage.setItem('isDarkMode', '"true"');    // 访客拨了开关，状态已是夜间
    theme.recordUserChoice('dark');                  // 开关同款调用（Head/index.tsx:149）
    ok(theme.userChoiceActive(), '白天切夜间也记成了意愿');
    eq(theme.autoThemeDecision(), null, '下一分钟收敛不动它（修复前这里返回 false → 被改回白天）');

    // 反证：没有意愿时收敛确实会顶回日间——这就是 bug 现场，不是我们的臆测
    store.delete('darkModeUserChoice'); store.delete('darkModeChoiceDay');
    eq(theme.autoThemeDecision(), false, '反证：无意愿的白天会被收敛回日间');

    // 连跑 3 次分钟收敛（App.tsx setInterval 60s），状态必须稳住
    store.clear(); at(22, 10);
    localStorage.setItem('isDarkMode', '"true"');
    theme.recordUserChoice('dark');
    let cur = true;
    for (let i = 1; i <= 3; i++) {
        at(22, 10 + i);
        const d = theme.autoThemeDecision();
        if (d !== null) cur = d;
    }
    eq(cur, true, '3 分钟后仍是夜间（修复前第 1 分钟就变回白天）');
}

console.log('== 白天切浅色仍然不记意愿（20260914 语义不许回退）==');
{
    store.clear(); at(14, 0);
    localStorage.setItem('darkModeUserChoice', 'dark');   // 假设上一晚留下的标记
    localStorage.setItem('darkModeChoiceDay', theme.currentThemeDay());
    theme.recordUserChoice('light');
    eq(theme.userChoiceActive(), false, '白天切浅色 → 标记被清（不否掉当晚的自动夜间）');
    eq(theme.autoThemeDecision(), null, '白天 + 浅色：状态已一致，收敛也不动');
}

console.log('== 夜间窗口（23:00-6:00）：切浅色让位、切夜间记意愿 ==');
{
    store.clear(); at(23, 30);
    localStorage.setItem('isDarkMode', '"true"');
    theme.recordUserChoice('light');
    ok(theme.userChoiceActive(), '夜间切浅色记意愿');
    eq(theme.autoThemeDecision(), null, '当夜让位（否则又被自动逻辑顶回深色）');
}
{
    store.clear(); at(2, 0);
    localStorage.setItem('isDarkMode', '"false"');
    theme.recordUserChoice('dark');
    ok(theme.userChoiceActive(), '深夜切夜间记意愿');
    eq(theme.autoThemeDecision(), null, '深夜已是夜间，收敛不动');
}

console.log('== 06:00 主题日边界：意愿自动过期 ==');
{
    store.clear(); at(23, 30, 15);
    localStorage.setItem('isDarkMode', '"false"');
    theme.recordUserChoice('light');
    at(5, 59, 16);
    ok(theme.userChoiceActive(), '次日 05:59（同一主题日）意愿仍有效');
    at(6, 0, 16);
    ok(!theme.userChoiceActive(), '06:00 主题日翻篇 → 意愿过期');
    eq(theme.autoThemeDecision(), null, '06:00 天亮 + 当前浅色 → 收敛无动作');
}
{
    // 白天写入的意愿也是"当日有效"：白天开的夜间模式能撑过当晚，次日 06:00 归还自动
    store.clear(); at(14, 0, 15);
    localStorage.setItem('isDarkMode', '"true"');
    theme.recordUserChoice('dark');
    at(23, 30, 15);
    ok(theme.userChoiceActive(), '白天写的意愿当晚仍有效');
    at(5, 59, 16);
    ok(theme.userChoiceActive(), '跨到次日凌晨（仍属同一主题日）仍有效');
    at(6, 0, 16);
    ok(!theme.userChoiceActive(), '次日 06:00 过期，自动夜间归还系统');
}

console.log('== 旧版残留 / agent 侧的值 ==');
{
    store.clear(); at(23, 30);
    localStorage.setItem('darkModeUserChoice', 'true');   // 旧版写入，无 darkModeChoiceDay
    ok(!theme.userChoiceActive(), '无日期的旧标记不生效（20260908 语义）');
    eq(theme.autoThemeDecision(), true, '夜间无有效意愿 → 自动切夜间');
}
{
    store.clear(); at(22, 0);
    localStorage.setItem('isDarkMode', '"true"');
    theme.recordUserChoice('true');       // chat-stream.js markVisitorChoice(true) 写的值
    ok(theme.userChoiceActive(), "'true' 与 'dark' 等价（agent 开夜间也守住）");
}
{
    store.clear(); at(22, 0);
    theme.recordUserChoice('false');      // chat-stream.js markVisitorChoice(false)，窗口外
    ok(!theme.userChoiceActive(), "窗口外 'false' 与 'light' 等价（不记）");
}

console.log('== 与 chat-stream.js 的 markVisitorChoice 对齐 ==');
{
    // agent 侧是同一份语义的第二个副本（public/live2d-widgets/chat-stream.js，IIFE，
    // node 里 import 不了）。20260915 这个 bug 的形态就是"两处不同步"，所以按源码把
    // 函数抽出来真跑一遍做对齐断言；抽不到直接抛（改名/重构必须同步这里，不静默跳过）。
    const streamSrc = readFileSync(path.join(root, 'public/live2d-widgets/chat-stream.js'), 'utf8');
    const grab = (name) => {
        const decl = 'const ' + name + ' = ';
        const i = streamSrc.indexOf(decl);
        if (i < 0) throw new Error(`chat-stream.js 里找不到 ${name}（改名了？测试要同步）`);
        const start = streamSrc.indexOf('{', i);          // 箭头函数体起始
        let depth = 0, j = start;
        for (; j < streamSrc.length; j++) {
            if (streamSrc[j] === '{') depth++;
            else if (streamSrc[j] === '}') { depth--; if (depth === 0) break; }
        }
        if (depth !== 0) throw new Error(`${name} 花括号不配平，抽取失败`);
        // 从 `= ` 之后整段取（含 `() =>`），不是从 `{` 起
        return `const ${name} = ${streamSrc.slice(i + decl.length, j + 1)};`;
    };
    // Date 作为形参遮蔽全局，把假钟喂进去（函数体里用的是 new Date() / Date.now()）
    const markVisitorChoice = new Function('localStorage', 'Date',
        grab('choiceDay') + grab('markVisitorChoice') + 'return markVisitorChoice;')(localStorage, FakeDate);

    // 值拼写不同（theme 写 'dark'/'light'，chat 写 'true'/'false'），但 userChoiceActive
    // 只认"在不在 + 哪天"——所以对齐的是这个归一化结果，不是原始字符串。
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
        markVisitorChoice(c.chat);
        const viaChat = theme.userChoiceActive();
        eq(viaChat, viaTheme, `${c.name}：theme.ts 与 chat-stream.js 同判（都 ${viaTheme ? '记' : '不记'}）`);
        if (viaChat) eq(store.get('darkModeChoiceDay'), theme.currentThemeDay(), `${c.name}：主题日也写成同一天`);
    }
    // 反证抽出来的不是空壳：它真的往存储里写了东西
    store.clear(); at(22, 10);
    markVisitorChoice(true);
    eq(store.get('darkModeUserChoice'), 'true', '抽取的函数确实落了存储（不是空壳）');
}

console.log(`\n${failed === 0 ? '✓' : '✗'} theme-choice: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

// ═ 主题边界语义回归 ══
//   node tests/theme-choice.test.mjs
// 测的是 20260916 用户口述的语义（**边界一次性**，取代旧的每分钟状态收敛）：
//   23:00 进窗 → 自动切夜一次；窗内访客手动改 → 本窗口让位；
//   06:00 出窗 → 若夜间则切回日间 + 清意愿；06:00-23:00 → 完全遵循访客。
// 载体是 theme.ts 的 autoThemeDecision（闩式，会写 localStorage）× recordUserChoice。
// 全站四个入口都走这两个函数：App.tsx 的分钟 ticker（边界探测）、Head 的桌面开关、
// PhoneSwitch 的移动开关、看板娘 chat-stream.js 的 DARKMODE 命令。
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
// 把 App.tsx 的分钟 ticker 复刻成一个可单步的驱动器：只有返回非 null 才"真的切了"，
// 并把新状态写回存储（真实链路里这一步是 darkmode-change 事件的监听者做的）。
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

    // 边界是"一次事件"：接着每分钟跑，不能再动作（否则窗口内访客的改动会被反复顶掉）
    for (const m of [[23, 1], [23, 2], [23, 30], [0, 15], [5, 58], [5, 59]]) {
        at(m[0], m[1]);
        eq(tick(new Date()), null, `${String(m[0]).padStart(2, '0')}:${String(m[1]).padStart(2, '0')} 窗内不再动作`);
    }
    eq(dark(), true, '整段夜窗保持夜间');
}

console.log('== 窗口内访客自己改：让位，本窗口不再自动改 ==');
{
    // 进窗时已是夜间（比如访客白天就开着）：入窗不重复动作，但边界照样算"处理过"
    store.clear(); at(23, 30);
    localStorage.setItem('isDarkMode', '"true"');
    eq(tick(new Date()), null, '已夜间 → 入窗不动作');
    theme.recordUserChoice('light');                 // 访客当场切浅色（Head/index.tsx）
    localStorage.setItem('isDarkMode', '"false"');
    let cur = false;
    for (const m of [[23, 31], [0, 15], [3, 40], [5, 59]]) {   // 跨到次日凌晨，仍在同一夜窗内
        at(m[0], m[1]);
        const d = tick(new Date());
        if (d !== null) cur = d;
    }
    eq(cur, false, '窗内切浅色后每分钟都不再被顶回夜间');
}
{
    // 反过来：进窗那一刻访客的意愿就已经在了（先表态、边界后到）→ 边界不动作
    store.clear(); at(22, 50);
    localStorage.setItem('isDarkMode', '"false"');
    theme.recordUserChoice('dark');                  // 窗口外切夜间：任何时段都记（20260915）
    at(23, 0);
    eq(tick(new Date()), null, '进窗前已有的意愿 → 边界让位，不改成夜间');
}
{
    // 窗口内切夜间：意愿存在（recordUserChoice 不变），且本来就已经是夜间
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

    // 闩复位 ⇒ 当晚 23:00 还能自动切夜（不会被"今天已经处理过"卡住）
    at(23, 0, 16);
    eq(tick(new Date()), true, '次日 23:00 又能自动切夜（闩已复位）');
}
{
    // 出窗时本来就是白天：不动作，但仍要清意愿与闩
    store.clear(); at(23, 30, 15);
    localStorage.setItem('isDarkMode', '"true"');
    eq(tick(new Date()), null, '入窗：已夜间 → 不动作');
    theme.recordUserChoice('light');                 // 访客窗内切成浅色
    localStorage.setItem('isDarkMode', '"false"');
    at(6, 0, 16);
    eq(tick(new Date()), null, '出窗时已是白天 → 不重复切');
    ok(!theme.userChoiceActive(), '意愿照样清空');
}

console.log('== 06:00-23:00 完全遵循访客：旧 bug 的防线 ==');
{
    // 修复前（每分钟状态收敛）这里返回 false → 白天手动开的夜间 60 秒后被顶回。
    // 现在非窗口时间恒为 null，怎么跑都不动。
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

    // 白天切浅色仍然不记意愿（20260914 语义不许回退）
    store.clear(); at(14, 0);
    localStorage.setItem('darkModeUserChoice', 'dark');   // 假设上一晚留下的标记
    localStorage.setItem('darkModeChoiceDay', theme.currentThemeDay());
    theme.recordUserChoice('light');
    ok(!theme.userChoiceActive(), '白天切浅色 → 标记被清（不否掉当晚的自动切夜）');
    eq(tick(new Date()), null, '白天 + 浅色：不动');
    // 于是当晚 23:00 照常自动切夜
    at(23, 0);
    eq(tick(new Date()), true, '当晚 23:00 照常自动切夜');
}

console.log('== 页面整夜关着 / 窗口内才打开 ==');
{
    // 关机一晚：23:00 那次切夜发生在关页之前（闩='1' 留在存储里），天亮后才重新打开。
    // 出窗动作在下一个 tick 补上——这正是 ticker 必须每分钟跑、而不是只在挂载时跑的原因。
    store.clear(); at(23, 0, 15);
    localStorage.setItem('isDarkMode', '"false"');
    eq(tick(new Date()), true, '睡前 23:00 切夜');
    at(9, 0, 16);                                    // 整夜没 tick，直接到早上打开
    eq(tick(new Date()), false, '开机第一次 tick 补上出窗：切回白天');
    eq(dark(), false, '状态已回日间');
    ok(!theme.userChoiceActive(), '意愿也清了');
    at(9, 1, 16);
    eq(tick(new Date()), null, '之后不再动作');
}
{
    // 窗口内首次打开（没进过窗，闩为空）：切夜一次
    store.clear(); at(2, 0);
    localStorage.setItem('isDarkMode', '"false"');
    eq(tick(new Date()), true, '窗口内首次打开 → 切夜一次');
    at(2, 1);
    eq(tick(new Date()), null, '下一分钟不再动作');
}
{
    // 前半夜关机、天亮后才开：**从没进过窗**（闩为空）→ 出窗动作不存在，完全不动。
    // 别把这条写成"跟随系统偏好"——语义是"06:00-23:00 只认访客"。
    store.clear(); at(22, 0, 15);
    localStorage.setItem('isDarkMode', '"true"');
    at(8, 0, 16);
    eq(tick(new Date()), null, '整夜未进窗的夜间模式：白天打开也不动它');
    eq(dark(), true, '仍是访客选择的夜间');
}

console.log('== 旧版残留 / agent 侧的值 ==');
{
    store.clear(); at(23, 30);
    localStorage.setItem('darkModeUserChoice', 'true');   // 旧版写入，无 darkModeChoiceDay
    ok(!theme.userChoiceActive(), '无日期的旧标记不生效（20260908 语义）');
    eq(tick(new Date()), true, '夜间无有效意愿 → 进窗自动切夜');
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

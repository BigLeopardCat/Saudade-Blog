// 主题工具（App/Head/PhoneSwitch/Dashboard 共用）
import { useEffect, useState } from 'react'

// isDarkMode 历史格式：20260823 前看板娘脚本写裸 'true'；现行写 JSON.stringify 的
// '"true"'——读取一律宽容兼容两种格式（此前裸值比较 === 'true' 对 '"true"' 判 false，
// 引发刷新丢暗色状态 / 早晨 6:00 跨时段不回亮，20260908 修复）
export function readDarkMode(): boolean {
    const v = localStorage.getItem('isDarkMode');
    return v === 'true' || v === '"true"';
}

// 主题日 = 以 06:00 为界（自动夜间 23:00-6:00 的恢复边界）。
// darkModeUserChoice 的让位只在写入时的主题日内有效：跨 6:00 后自动切换恢复
// （20260908 时效化——此前一次手动/对话调节即永久让位，且无恢复入口；
//  旧版写入的 choice 无 darkModeChoiceDay → 视为已过期，自动切换恢复）
export function currentThemeDay(): string {
    const d = new Date(Date.now() - 6 * 3600 * 1000);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
}

// 夜间窗口 = 23:00-次日 06:00（自动夜间时段）。全站口径唯一来源：App.tsx 的自动
// 切换、recordUserChoice 的记意愿判据都走这里，避免两处各写一份漂移。
export function isNightHour(d: Date = new Date()): boolean {
    const h = d.getHours();
    return h >= 23 || h < 6;
}

// 手动切换（含 agent DARKMODE 命令调节）= 访客意愿：记录偏好值 + 写入时的主题日。
// 作用域：**只在夜窗（23:00-06:00）内有意义**——autoThemeDecision 在 23:00 那次入场
// 会看一眼这条意愿：有就整段夜窗让位，没有就自动切夜。
// 20260914：切【浅色】只在夜间窗口内才记为意愿——白天手动切浅色不再否掉当晚的自动夜间
// （20260908 语义的毛刺：白天一次浅色 → 当晚 23:00 不自动切，非等到次日 6:00 主题日
// 翻篇才恢复）。
// 20260915：切【夜间】改为任何时段都记（当时 App.tsx 是每分钟状态收敛，窗口外不记的话
// 白天手动开的夜间活不过 60 秒）。20260916 起自动切换只在两条边界动作，这条"任何时段
// 都记"已非必需，但**保持原样**：语义无害（切夜间与自动夜间同向，不会否掉当晚的自动
// 切夜），也让 chat-stream.js 的那份副本继续对得上（不需要 bump `?v=`）。
// ⚠️ 改这里必须同步改 public/live2d-widgets/chat-stream.js 的 markVisitorChoice（agent
//    的 DARKMODE 命令走那条路），并 bump boot.js 的 VER（nginx 对 live2d-widgets
//    目录是 1 年 immutable，不 bump 老访客拿不到新脚本）。
export function recordUserChoice(v: string): void {
    try {
        if (v === 'light' || v === 'false') {
            if (!isNightHour()) {
                localStorage.removeItem('darkModeUserChoice');
                localStorage.removeItem('darkModeChoiceDay');
                return;
            }
        }
        localStorage.setItem('darkModeUserChoice', v);
        localStorage.setItem('darkModeChoiceDay', currentThemeDay());
    } catch (e) { /* ignore */ }
}

// choice 是否在本次主题日内有效（无日期 = 旧版写入 → 视为已过期，自动切换恢复）。
// 语义 = "直到下一个 06:00"：主题日 06:00 翻篇，故 23:00-06:00 整段属同一主题日，
// 而 20260915 起白天写入的意愿也只是"当日有效"（次日 06:00 自然过期），
// 不会让一次手动切换永久夺走自动夜间。
export function userChoiceActive(): boolean {
    try {
        return !!localStorage.getItem('darkModeUserChoice')
            && localStorage.getItem('darkModeChoiceDay') === currentThemeDay();
    } catch (e) { return false; }
}

/** 夜窗闩：'1' = 本次夜窗（23:00 起）的入场边界已经处理过。
 *  这是"边界一次性动作"的载体——每分钟的 ticker 也靠它知道"这条边界我处理过了"。
 *  出窗时清除（回到"未处理"），所以它不绑日期、跨日不会误伤。 */
const LATCH_KEY = 'darkModeInWindow';

function readLatch(): string {
    try { return localStorage.getItem(LATCH_KEY) || ''; } catch (e) { return ''; }
}

function writeLatch(on: boolean): void {
    try {
        if (on) localStorage.setItem(LATCH_KEY, '1');
        else { localStorage.removeItem(LATCH_KEY); localStorage.removeItem('darkModeUserChoice'); localStorage.removeItem('darkModeChoiceDay'); }
    } catch (e) { /* ignore */ }
}

/**
 * 自动切换此刻该切到哪：true = 切夜间、false = 切日间、null = 不动。
 *
 * 语义（20260916 用户口述重写，**边界一次性**，不再是每分钟状态收敛）：
 *   · 23:00 进窗 → 自动切夜**一次**（闩未处理才动作，本窗口此后不再自动改）；
 *   · 23:00-06:00 内访客手动改了主题 → 记意愿（recordUserChoice），本窗口内让位；
 *   · 06:00 出窗 → 若处于夜间则切回日间，并清掉意愿与闩（新一天重新开始）；
 *   · 06:00-23:00 → **完全不自动动作**，只认访客自己的选择。
 * 旧实现是 `night === readDarkMode() ? null : night` 的**状态收敛**：任何时刻只要
 * "无有效意愿且与时段不符"就切——白天手动开的夜间 60 秒后被顶回（20260915 修过一次），
 * 窗口内也一样每分钟可能被改。现在只有两条边界会动作。
 *
 * ⚠️ 与"纯函数"的偏差（有意）：它**会写 localStorage**（推进闩、出窗清意愿）。
 *    边界是"一次事件"，函数被每分钟调用，就必须自己记住"这次边界已经消费过了"，
 *    否则每次 tick 都会重新动作。读取侧仍然只依赖 localStorage + 传入的钟面，
 *    所以 tests/theme-choice.test.mjs 里可以用假钟直接断言（注入 now，别依赖真实时间）。
 *    改判据必须同时改那个测试。
 */
export function autoThemeDecision(now: Date = new Date()): boolean | null {
    if (isNightHour(now)) {
        // 进窗：整段夜窗只处理一次，且"处理过"与"是否动作"是两件事——
        // 访客已在窗内表态时这里不动作，但边界照样算处理过（否则下一分钟还会再问一遍）。
        if (readLatch() === '1') return null;
        writeLatch(true);
        if (userChoiceActive()) return null;
        return readDarkMode() ? null : true;
    }
    // 出窗：只有"进过窗"才轮到自动恢复。没进过窗（白天/前半夜开的夜间模式，或整夜关机
    // 且入窗前就关掉）一律不动——这就是"非窗口时间完全遵循访客主题决定"。
    if (readLatch() === '1') {
        const wasNight = readDarkMode();
        writeLatch(false);                    // 闩与意愿一起清（新的一天重新开始）
        return wasNight ? false : null;
    }
    return null;
}

/**
 * 组件内实时跟随主题。全仓唯一在 React 里响应主题变化的写法是 App.tsx 的
 * useState(readDarkMode()) + 监听 'darkmode-change'（头部按钮 / agent 的 DARKMODE 命令 /
 * 23:00-6:00 自动切换都派发这个自定义事件），这里抽成 hook 复用——
 * 需要按主题切换媒体源（如详情页顶部日夜背景视频）的组件用它，不要各写一份。
 */
export function useIsDarkMode(): boolean {
    const [isDark, setDark] = useState(readDarkMode);
    useEffect(() => {
        const onChange = (e: Event) => setDark(!!(e as CustomEvent).detail);
        window.addEventListener('darkmode-change', onChange);
        // 补读一次：组件可能在主题已切换之后才挂载（如从首页点进文章详情）
        setDark(readDarkMode());
        return () => window.removeEventListener('darkmode-change', onChange);
    }, []);
    return isDark;
}

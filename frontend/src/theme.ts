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
// 20260914：切【浅色】只在夜间窗口内才记为意愿——白天手动切浅色不再否掉当晚的自动夜间
// （20260908 语义的毛刺：白天一次浅色 → 当晚 23:00 不自动切，非等到次日 6:00 主题日
// 翻篇才恢复）。
// 20260915：切【夜间】改为任何时段都记。此前窗口外一律清标记，于是白天/前半夜手动开的
// 夜间模式活不过 60 秒——App.tsx 的 prefersAuto 是每分钟一次的状态收敛（非 23:00 一次性
// 事件），非夜间时段 isNightHour()=false 又没有意愿让位，下一分钟就 dispatch
// detail:false 把它改回日间（用户报「夜间模式 1 分钟后自动切回白天」）。切夜间与自动
// 夜间同向，记意愿不可能否掉当晚的自动切换；主题日（06:00 为界）时效仍在，次日 06:00
// 照常恢复自动。
// ⚠️ 改这里必须同步改 public/live2d-widgets/chat-stream.js 的 markVisitorChoice（agent
//    的 DARKMODE 命令走那条路），并 bump autoload.js 的 VER（nginx 对 live2d-widgets
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

/**
 * 自动切换此刻该切到哪：true = 切夜间、false = 切日间、null = 不动
 * （访客意愿有效 = 让位；或者当前状态已经和目标一致 = 不用切）。
 *
 * App.tsx 的 prefersAuto 每分钟调一次做【状态收敛】——"每分钟"是这条链路的关键：
 * 白天手动开的夜间模式如果没被 recordUserChoice 记成意愿，60 秒后就会在这里被判成
 * false 顶回日间（20260915 用户报「夜间模式 1 分钟后自动切回白天」）。
 * 抽成纯函数（只读 localStorage + 钟面）是为了让这条交互能在 node 里直接断言，
 * 见 tests/theme-choice.test.mjs —— 改判据必须同时改那个测试。
 */
export function autoThemeDecision(): boolean | null {
    if (userChoiceActive()) return null;
    const night = isNightHour();
    return night === readDarkMode() ? null : night;
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

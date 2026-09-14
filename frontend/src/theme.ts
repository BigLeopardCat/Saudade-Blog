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
// 20260914：只在【夜间窗口内】才记为意愿——白天手动切浅色不再否掉当晚的自动夜间
// （20260908 语义的毛刺：白天一次浅色 → 当晚 23:00 不自动切，非等到次日 6:00 主题日
// 翻篇才恢复；白天切深色则察觉不到）。窗口外一律清除标记：既保证语义，也避免
// localStorage 残留旧值把"看存储判断状态"带偏。
export function recordUserChoice(v: string): void {
    try {
        if (!isNightHour()) {
            localStorage.removeItem('darkModeUserChoice');
            localStorage.removeItem('darkModeChoiceDay');
            return;
        }
        localStorage.setItem('darkModeUserChoice', v);
        localStorage.setItem('darkModeChoiceDay', currentThemeDay());
    } catch (e) { /* ignore */ }
}

// choice 是否在本次主题日内有效（无日期 = 旧版写入 → 视为已过期，自动切换恢复）。
// 20260914 起 choice 只可能在夜间窗口内写入，而整个 23:00-06:00 属于同一主题日
// （06:00 才翻篇），故"主题日内有效"= "当晚这段夜间窗口内有效"，06:00 自然过期。
export function userChoiceActive(): boolean {
    try {
        return !!localStorage.getItem('darkModeUserChoice')
            && localStorage.getItem('darkModeChoiceDay') === currentThemeDay();
    } catch (e) { return false; }
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

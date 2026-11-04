// 主题工具（App/Head/PhoneSwitch/Dashboard 共用）
import { useEffect, useState } from 'react'

export function readDarkMode(): boolean {
    const v = localStorage.getItem('isDarkMode');
    return v === 'true' || v === '"true"';
}

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
    } catch { /* ignore */ }
}

export function userChoiceActive(): boolean {
    try {
        return !!localStorage.getItem('darkModeUserChoice')
            && localStorage.getItem('darkModeChoiceDay') === currentThemeDay();
    } catch { return false; }
}

const LATCH_KEY = 'darkModeInWindow';

function readLatch(): string {
    try { return localStorage.getItem(LATCH_KEY) || ''; } catch { return ''; }
}

function writeLatch(on: boolean): void {
    try {
        if (on) localStorage.setItem(LATCH_KEY, currentThemeDay());
        else { localStorage.removeItem(LATCH_KEY); localStorage.removeItem('darkModeUserChoice'); localStorage.removeItem('darkModeChoiceDay'); }
    } catch { /* ignore */ }
}

export function autoThemeDecision(now: Date = new Date()): boolean | null {
    if (isNightHour(now)) {
        // 进窗：整段夜窗只处理一次，且"处理过"与"是否动作"是两件事——
        // 访客已在窗内表态时这里不动作，但边界照样算处理过（否则下一分钟还会再问一遍）。
        // 比对的是**主题日**而不是"有没有闩"：昨晚留下的闩不该吃掉今晚的入场（见 LATCH_KEY）。
        if (readLatch() === currentThemeDay()) return null;
        writeLatch(true);
        if (userChoiceActive()) return null;
        return readDarkMode() ? null : true;
    }
    // 出窗：只有"进过窗"才轮到自动恢复。没进过窗（白天/前半夜开的夜间模式，或整夜关机
    // 且入窗前就关掉）一律不动——这就是"非窗口时间完全遵循访客主题决定"。
    if (readLatch()) {
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

export function useAutoThemeSwitch(): void {
    useEffect(() => {
        const persist = (e: Event) => {
            const on = !!(e as CustomEvent).detail;
            try { localStorage.setItem('isDarkMode', JSON.stringify(on)); } catch { /* 隐私模式写不了，忽略 */ }
        };
        const prefersAuto = () => {
            try {
                const next = autoThemeDecision();
                if (next !== null) {
                    window.dispatchEvent(new CustomEvent('darkmode-change', { detail: next }));
                }
            } catch { /* 读 localStorage 失败不致命，下一分钟再来 */ }
        };
        window.addEventListener('darkmode-change', persist);
        prefersAuto();
        const timer = setInterval(prefersAuto, 60 * 1000);
        const onVisible = () => { if (!document.hidden) prefersAuto(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            window.removeEventListener('darkmode-change', persist);
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, []);
}

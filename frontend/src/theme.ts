// 主题工具（App/Head/PhoneSwitch/Dashboard 共用）
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

// 手动切换（含 agent DARKMODE 命令调节）= 访客意愿：记录偏好值 + 写入时的主题日
export function recordUserChoice(v: string): void {
    try {
        localStorage.setItem('darkModeUserChoice', v);
        localStorage.setItem('darkModeChoiceDay', currentThemeDay());
    } catch (e) { /* ignore */ }
}

// choice 是否在本次主题日内有效（无日期 = 旧版写入 → 视为已过期，自动切换恢复）
export function userChoiceActive(): boolean {
    try {
        return !!localStorage.getItem('darkModeUserChoice')
            && localStorage.getItem('darkModeChoiceDay') === currentThemeDay();
    } catch (e) { return false; }
}

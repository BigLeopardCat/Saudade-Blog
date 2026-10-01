/**
 * z-index 阶梯的 TS 侧镜像。**值必须与 `src/index.css` 的 `:root` 逐值相等。**
 *
 * 为什么要两份：antd 的 Modal / Drawer 只认 `zIndex` 这个 **prop**（数字），
 * CSS 变量递不进去；而普通样式在 CSS 里写 `var(--z-*)` 才能在主题切换、类名变化
 * 时整体改档。两个消费面各取所需，值只有一批。
 *
 * 漂移是这里的唯一风险：改了 CSS 忘了这里 ⇒ 个人中心还在 1000、公告已经 1300，
 * 界面上看不出任何异常，直到某天两个浮层重叠。`frontend/tests/z-index.test.py`
 * 就是用无头 Chrome 把两边读出来逐值比对的那道闸。
 *
 * ⚠️ `agent` 与 `toast` 在这里**没有用处**：前者是 agent 仓 `widget.css` 消费的
 * （那份 CSS 带 `var(--z-agent, 1000)` 的兜底，脱离本站也能独立用）；
 * 后者是 antd 自己管 `message`/`notification` 用的。列在这里是为了这份表完整、
 * 也为了让上面那句"逐值相等"有个明确的清单。
 */
export const Z = {
    /** 层内：页内悬浮件（回到顶部、悬浮按钮…） */
    float: 100,
    /** ★被扯下来的那一页（`.vit-fall`，portal 到 body） */
    fall: 900,
    /** 层内：手机抽屉那一带的下限（998~1001）。由 `.frontRoot` 的 `isolation` 关在层内，
     *  与下面的 `agent` 值相同也**不**表示会互相抢 */
    header: 998,
    /** ★看板娘 + 对话面板（`#waifu`）。agent 仓消费，本仓不直接用 */
    agent: 1000,
    /** ★向量空间放大态：`body.exhibit-zoomed` 时整个 `.frontRoot` 抬到这里 */
    exhibit: 1100,
    /** ★站内图片放大查看器（`.md-zoom-overlay`） */
    lightbox: 1150,
    /** ★个人中心 */
    panel: 1200,
    /** ★公告弹窗 */
    modal: 1300,
    /** 记账位：antd message / notification。**本仓不设这个值**（antd 自己给的是 2010 /
     *  2050，本来就更高），列在这里是为了说明阶梯的上界在哪 */
    toast: 1400,
} as const;

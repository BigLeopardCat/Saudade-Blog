/** 与 index.css 中的 --z-* 保持一致；Ant Design 浮层使用数字 prop，普通样式使用 CSS 变量。 */
export const Z = {
    /** 层内：页内悬浮件（回到顶部、悬浮按钮…） */
    float: 100,
    /** ★被扯下来的那一页（`.vit-fall`，portal 到 body） */
    fall: 900,
    /** ★页面特效（樱花/大雨/雪花，`frontend/public/effects.js`）。挂在 body 上所以是跨层的，
     *  **必须低于 `agent`**，否则花瓣雨点雪花会盖在对话面板前面。
     *  本仓不直接用（那份 JS 读 `var(--z-effect, 950)`），列在这里是为了这份表完整 */
    effect: 950,
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

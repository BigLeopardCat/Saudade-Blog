/** 图谱配色。窗口只在夜间出现，所以只按夜间面板底（rgba(13,19,32,.55) 叠在页面
 *  背景上 ≈ rgb(16,22,35)）挑色——不要在亮色底上直接复用，会发灰。 */

/** 按文章着色的点色。6 篇公开文章 → 6 个色相，观众能立刻看出「这团是同一篇文章的」。
 *  色相拉开但明度接近，避免某篇文章的点在深底上比别的暗一档。 */
export const ART_COLORS = [
    '#6ea8ff', // 蓝
    '#7ee0c0', // 青绿
    '#c79cff', // 紫
    '#ffd479', // 琥珀
    '#ff9db0', // 粉
    '#8ce07a', // 绿
] as const;

export function artColor(i: number): string {
    return ART_COLORS[((i % ART_COLORS.length) + ART_COLORS.length) % ART_COLORS.length];
}

export const PALETTE = {
    /** 边基色（rgb 分量串，拼 alpha 用）：低相似度的边偏冷偏暗 */
    edge: '150, 196, 255',
    edgeHot: '255, 232, 168',
    /** 常驻标签 */
    label: 'rgba(228, 238, 255, .94)',
    /** 次级标签（B 层，随相机拉近出现） */
    /** 悬停/查询命中的标签 */
    labelHit: '#ffe9a8',
    /** 命中点的高亮环 */
    hitRing: 'rgba(255, 233, 168, .85)',
    /** 命中点的外发光 */
    glow: 'rgba(255, 233, 168, .30)',
    /** 标签描边：canvas 文字压在点/线上必须有暗描边才读得清 */
    labelHalo: 'rgba(8, 12, 22, .85)',
} as const;

/** 标签字体：系统栈。⛔ 不能用 'LXGW WenKai TC'——首页那个 4.8KB 子集只覆盖签名
 *  那几个字，拿它画画布标签会大面积 fallback 成豆腐块。 */
export const LABEL_FONT = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",sans-serif';

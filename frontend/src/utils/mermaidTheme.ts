/**
 * mermaid 主题：**全站唯一的一份配置**（20261005）。
 *
 * 现场：文章详情页（`ReadArticle/index.tsx` 的 plugins 数组）与看板娘对话框
 *（`utils/chatMarkdown.ts` 的 viewerEffect）都调裸 `mermaid()`，于是图用的是 mermaid
 * 内置的 `default` 主题——淡紫节点 `#ECECFF`、淡黄分组 `#ffffde`、紫描边 `#9370DB`、
 * 字体 `"trebuchet ms"`。用户报「mermaid 渲染的图配色给人一种零几年风格的古早感觉」，
 * 说的就是它（那套取色是 mermaid 2014 年的默认值，二十多年没改过）。
 *
 * ⚠️ **两处调用点必须共传这一份**：`@bytemd/plugin-mermaid` 的工厂把选项原样交给
 * `mermaid.initialize()`，而 mermaid 是**全局单例**——两处各传各的，谁先渲染谁定调，
 * 另一处会静默跟着变（页面上两张图同款、对话框里另一款这种事，就是这么来的）。
 * 同一个值传两次是幂等的。
 *
 * 取值取自站点和纸令牌（`src/index.css:92-113` 的 `--washi-*`）。这里写死色值是因为
 * mermaid 要的是普通颜色字符串、拿不到 CSS 变量的解析结果；**换令牌时要回来对一遍**。
 *
 * 被换掉的 default 主题值 → 现在（改回来之前先读这张表）：
 *   primaryColor        #ECECFF            → #fffdfa  节点底（纸白）
 *   primaryBorderColor  hsl(240,60%,86%)   → #d8cfe0  节点描边
 *   nodeBorder          #9370DB（紫）      → #c9b8d2
 *   primaryTextColor    #131300（近黑黄）  → #4a3550  节点文字（墨紫）
 *   lineColor           #333333            → #9b8fa6  连线
 *   secondaryColor      #ffffde（淡黄）    → #fdf1f7  次级块（淡粉）
 *   tertiaryColor       hsl(80,100%,96%)   → #f4f1fa  三级块（淡紫）
 *   clusterBkg          #ffffde（淡黄）    → #faf4f7  分组底
 *   clusterBorder       #aaaa33（土黄）    → #e2cfe0  分组框
 *   edgeLabelBackground #e8e8e8            → #fffdfa
 *   fontFamily          trebuchet ms,…     → 与站点正文同一串（那串西文字体 + 中文回退）
 */
export const MERMAID_CONFIG = {
  // `base` 是"所有取值都从 themeVariables 来"的那套主题；`default` 只把它当补丁，
  // 缺键会悄悄落回上面那张表里的古早值。
  theme: 'base',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "PingFang SC", "Microsoft YaHei", sans-serif',
  // 桌面 16px 在 660px 的正文列里偏大、手机档更挤；15px 与正文 17px 同一档观感
  fontSize: 15,
  themeVariables: {
    // 图框是一张白底卡（`.bytemd-mermaid{background:#fff}`，日夜两档都保持白，
    // 见 index.sass 同处注释），所以节点/标签的底色跟着走纸白、文字走墨紫。
    background: '#fffdfa',
    primaryColor: '#fffdfa',
    primaryBorderColor: '#d8cfe0',
    primaryTextColor: '#4a3550',
    secondaryColor: '#fdf1f7',
    tertiaryColor: '#f4f1fa',
    mainBkg: '#fffdfa',
    nodeBorder: '#c9b8d2',
    nodeTextColor: '#4a3550',
    textColor: '#4a3550',
    titleColor: '#4a3550',
    lineColor: '#9b8fa6',
    // 分组（subgraph）：原来是淡黄底 + 土黄框，最像"零几年"的一处
    clusterBkg: '#faf4f7',
    clusterBorder: '#e2cfe0',
    // 连线上的标签：原来 #e8e8e8 的灰块，压在线上像补丁
    edgeLabelBackground: '#fffdfa',
    labelBackgroundColor: '#fffdfa',
    labelTextColor: '#4a3550',
    // 时序图（sequenceDiagram）
    actorBkg: '#fffdfa',
    actorBorder: '#c9b8d2',
    actorTextColor: '#4a3550',
    actorLineColor: '#9b8fa6',
    signalColor: '#9b8fa6',
    signalTextColor: '#4a3550',
    noteBkgColor: '#fdf1f7',
    noteBorderColor: '#e2cfe0',
    noteTextColor: '#4a3550',
    // 饼图：只有前四片给了和纸色调（粉 → 藕紫 → 天青 → 淡紫），其余落回 base
    pie1: '#d94f9a',
    pie2: '#9b8fa6',
    pie3: '#8fb6d9',
    pie4: '#e6dcf2',
  },
} as const

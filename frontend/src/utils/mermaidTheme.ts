/** Shared palette and native diagram sizing for article and chat rendering. */
export const MERMAID_CONFIG = {
  // `base` 是"所有取值都从 themeVariables 来"的那套主题；`default` 只把它当补丁，
  // 缺键会悄悄落回上面那张表里的古早值。
  theme: 'base',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "PingFang SC", "Microsoft YaHei", sans-serif',
  // Wide diagrams retain their text size inside a scrollable, zoomable canvas.
  fontSize: 16,
  flowchart: { useMaxWidth: false, wrappingWidth: 220 },
  sequence: { useMaxWidth: false, wrap: true },
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

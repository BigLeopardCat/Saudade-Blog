/**
 * 站内小图标的**单一事实源**。现有两组：
 *   · **读数四件套**：浏览（眼）/ 点赞（心）/ 收藏（星）/ 讨论（气泡）——20260930 新增
 *     前三件，20261003 补第四件（用户第 4、5 条：卡片与详情页都要显示讨论数）；
 *   · **投票两件**：赞 / 踩（拇指）——20261005 新增，替掉讨论区那对彩色表情字形
 *     （理由见 `ThumbUpIcon` 的注释）。
 *
 * ## 为什么是内联 SVG，而不是 emoji 或字体图标
 *
 * · **emoji 不能用**：同一个 👁 在 Windows / Android / iOS 上是三种字形，字重与基线
 *   差得多，放在 12px 的一排小字里必然对不齐（详情页那条 `.readViews` 的头注记的是
 *   同一件事）。
 * · **站内 iconfont 里没有这三个字形**：那两套图标库只有时钟、分类、草稿那类，
 *   拿不到眼睛/心/星（`public/fonts/font_4335817_*` 与 `font_4466999_*` 两份都查过；
 *   20261001 起这两套已从 alicdn 自托管到仓内，字形集未变）。
 * · **font-awesome 虽然有**（页面已外链 4.7），但为三个图标再引一层 class 体系，
 *   还会跟 iconfont 的 `font-size` 打架，不如三个 `<svg>` 直接。
 *
 * ## 尺寸与配色：都不写死
 *
 * · 尺寸走 `size` 参数（默认 14）：**刻意不做成 `1em` 继承**——详情页那个眼睛现在是
 *   14px 且被 `read-stats-cluster.test.py` 量着几何，改成 em 会随父级字号变，等于偷偷
 *   动了一个有回归锁的尺寸。
 * · 颜色一律 `currentColor`：由调用方的 CSS 决定（卡片给了主题变量，见 `ArticleStats`）。
 *   图标组件自己不认主题，也就不需要在夜间模式里再补一份。
 * · **不写 `vertical-align`**：两处调用方都是 `inline-flex + align-items:center`（详情页
 *   `.readViews`、卡片 `.ArticleStat`），图标作为 flex item 由交叉轴对齐，写行内
 *   `vertical-align` 在 flex 容器里根本不生效——留着只会让后来人以为它在起作用。
 *
 * ## 描边件与实心件（八件）
 *
 * · **描边**：眼睛（`EyeIcon`）、空心（`HeartOutlineIcon`）、空星（`StarOutlineIcon`）、
 *   气泡（`CommentIcon`）、赞/踩（`ThumbUpIcon`/`ThumbDownIcon`）—— 同一套 `strokeWidth`
 *   （1.8）与圆角端点，摆在一起是一条线语言。
 *   讨论数只有"有多少"这一种语义（没有"我评论过没有"这个状态），所以它**只有描边一件**，
 *   不像心/星那样成对。赞/踩也只有描边一件，理由不同（见 `ThumbUpIcon`）：它们两态的差别
 *   是**颜色与底色**，不是"空 ↔ 实"。
 * · **实心**：心（`HeartIcon`）、星（`StarIcon`）—— 同一条路径的 `fill` 版。
 * · 卡片上那三个数是"有多少"，一律实心更清楚（眼睛例外：实心会糊成一团，瞳孔与眼白
 *   在 12px 下分不开）。
 * · 详情页的收藏/点赞是**开关**（未选中描边、选中实心），20261001 之前用的是文本字形
 *   `★/☆` 与 `♥/♡` —— 同一排里两个字体字形 + 一个 svg，字重与基线各不相同，正是
 *   用户第 4 条说的「风格不一致」。现在三件同源同尺寸（14px）。
 */
interface IconProps {
    /** 边长（px）。默认 14 = 详情页沿用的尺寸 */
    size?: number
}

/** 讨论数：描边气泡（带一个小尾巴，与眼睛/心/星共用同一套描边语言）。
 *  画成"说话"的形状而不是"三横线"（列表/菜单那种），是因为这一格旁边还有分类、标签那
 *  几件也用横线；在 12px 下"三横线"会与它们糊成一类。 */
export const CommentIcon: React.FC<IconProps> = ({ size = 14 }) => (
    <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
    >
        <path d="M4.1 3.9h15.8a2.2 2.2 0 0 1 2.2 2.2v8.6a2.2 2.2 0 0 1-2.2 2.2h-8.6l-4.4 3.4v-3.4H4.1a2.2 2.2 0 0 1-2.2-2.2V6.1a2.2 2.2 0 0 1 2.2-2.2z" />
    </svg>
)

/** 浏览数：描边眼睛 */
export const EyeIcon: React.FC<IconProps> = ({ size = 14 }) => (
    <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
    >
        <path d="M1.8 12S5.6 5.5 12 5.5 22.2 12 22.2 12 18.4 18.5 12 18.5 1.8 12 1.8 12z" />
        <circle cx="12" cy="12" r="3.1" />
    </svg>
)

/** 点赞数：实心心 */
export const HeartIcon: React.FC<IconProps> = ({ size = 14 }) => (
    <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="currentColor"
    >
        <path d="M12 20.8 4.1 12.9a5.2 5.2 0 0 1 0-7.3 5.2 5.2 0 0 1 7.3 0l.6.6.6-.6a5.2 5.2 0 0 1 7.3 0 5.2 5.2 0 0 1 0 7.3z" />
    </svg>
)

/** 收藏数：实心星 */
export const StarIcon: React.FC<IconProps> = ({ size = 14 }) => (
    <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="currentColor"
    >
        <path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z" />
    </svg>
)

/** 收藏·未选中：空星（与 `StarIcon` 同一条路径，只换成描边） */
export const StarOutlineIcon: React.FC<IconProps> = ({ size = 14 }) => (
    <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
    >
        <path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z" />
    </svg>
)

/** 讨论区·赞：描边拇指（朝上）。
 *
 * ## 这是把原来的彩色表情字形换掉的（20261005，用户原话"用像灰色文本字符一样的图标"）
 *
 * 换的真正理由不是"emoji 不好看"，是**它在两态里有一半是失效的**：emoji 是**彩色字形**，
 * 平台渲染的是它自带的调色板，`color` 基本不参与——而 `.commentVote` 的"我投过"那一态
 * 恰恰只有两样东西：文字**颜色**与一层淡底色。于是高亮实际只剩背景块看得见，
 * 颜色那半从来没生效过（`.isOn` 里那份颜色声明对字形是空头支票）。换成吃
 * `currentColor` 的 SVG，两态才真的都变色，与旁边「回复 / 删除」那几个纯文字按钮
 * 也才是同一种材质。
 *
 * ## 为什么只有描边一件，没有实心版
 *
 * 心与星是成对的（未选中描边、选中实心），因为它们是**开关**。讨论区的赞/踩**不是开关、
 * 是二选一的投票**：两态的差别已经定为"颜色与底色"（`.commentVote` 那条规则 20261003
 * 就写死了，还刻意不加粗，免得改变按钮宽度把"位置不动"作废）。补一枚实心件等于在这里
 * 另立一套"选中 = 填充"的语言，与那条已定的语义打架。
 *
 * ## 尺寸
 *
 * `size` 默认 14，约等于原来 emoji 在 `0.86rem` 下的字框宽度 ⇒ 两颗钮的宽度基本不变，
 * `.commentVote` 那套"点亮 / 计数清零都不许横跳"的 padding 抵消仍然成立。 */
export const ThumbUpIcon: React.FC<IconProps> = ({ size = 14 }) => (
    <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
    >
        <path d="M13.8 9V5.3a2.8 2.8 0 0 0-2.8-2.8l-3.9 8.9v10.9h11.2a2 2 0 0 0 1.97-1.65l1.4-9.1a2 2 0 0 0-1.97-2.35z" />
        <path d="M7.1 22.3H4.5a2.4 2.4 0 0 1-2.4-2.4v-7a2.4 2.4 0 0 1 2.4-2.4h2.6" />
    </svg>
)

/** 讨论区·踩：描边拇指（朝下）。与 `ThumbUpIcon` 是同一条路径关于水平轴镜像的产物
 *  （两个子路径逐点 `y → 24 - y`、圆弧的 sweep 逐条取反），所以拇指长度、拳头厚度、
 *  腕带位置逐像素对称——改其中一个的几何，另一个要照着镜像重算，别只改一边。 */
export const ThumbDownIcon: React.FC<IconProps> = ({ size = 14 }) => (
    <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
    >
        <path d="M13.8 15v3.7a2.8 2.8 0 0 1-2.8 2.8l-3.9-8.9V1.7h11.2a2 2 0 0 1 1.97 1.65l1.4 9.1a2 2 0 0 1-1.97 2.35z" />
        <path d="M7.1 1.7H4.5a2.4 2.4 0 0 0-2.4 2.4v7a2.4 2.4 0 0 0 2.4 2.4h2.6" />
    </svg>
)

/** 点赞·未选中：空心（与 `HeartIcon` 同一条路径，只换成描边） */
export const HeartOutlineIcon: React.FC<IconProps> = ({ size = 14 }) => (
    <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
    >
        <path d="M12 20.8 4.1 12.9a5.2 5.2 0 0 1 0-7.3 5.2 5.2 0 0 1 7.3 0l.6.6.6-.6a5.2 5.2 0 0 1 7.3 0 5.2 5.2 0 0 1 0 7.3z" />
    </svg>
)

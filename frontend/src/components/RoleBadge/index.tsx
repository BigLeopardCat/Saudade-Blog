import React, { useId } from 'react'
import { ROLE_LABEL } from '../../utils/auth'

/**
 * 权限身份徽章（五档，20261002 主人点名）：**整枚用内联 SVG 画**，一档一个样子。
 *
 * ## 为什么要换掉 antd 的 <Tag color=...>
 *
 * 原来两处身份标签都是 `<Tag color={roleTagColor(role)}>`（purple/gold/blue/orange）
 * —— 五个身份里有四个是"同一支胶囊换一种底色"，**只靠颜色区分**：色觉障碍下不可读，
 * 灰度打印下全一样，而且颜色本身不携带任何身份语义（purple 为什么是超管？答案是
 * "当初随手写的"）。主人要的是「每种权限要有符合对应身份特征的图形」。
 *
 * 现在每一档给三样东西，**辨识不只靠颜色**：
 *   · 图形：👑（管理员）/ 🖋（秘书）/ 🍃（普通用户）/ 🐟（杂鱼）；**站长那一档不带表情**
 *     （20261003 主人点名：站长徽章的文本内容只写「站长」两个字）；
 *   · 形状：白边分「双层（管理员）/ 实线（站长）/ 虚线（秘书、杂鱼）/ 最细（普通用户）」；
 *   · 配色：仍是站内那套马卡龙色系（`--washi-pink` `#ff9ec9` / `--washi-pink-deep`
 *     `#d94f9a` / `--washi-lav` `#b9a7f5` / `--washi-sky` `#8fd3ea` 都直接是变量值，
 *     只有站长那档的奶油黄→蜜桃是站里没用过的一族暖色、没进变量表），渐变方向一致。
 *
 * ## 倾角（20261003 改）
 *
 * 原来五档的倾角各不相同（-2 / +2 / -1.5 / 0 / -2），"歪多少"本身就是一档特征。主人
 * 20261003 要求**扶正**，只有杂鱼保留 -2°（那一档他自己给了 `rotate(-2 …)` 的样例，
 * 是点名要留的）。于是 `tilt` 不再是区分手段——**五档里四档恒 0**，区分全部落在
 * "图形 / 白边 / 配色"这三样上。改配色时那个"反正还有倾角能分"的退路已经没有了。
 *
 * ## 为什么整枚是 SVG（而不是 HTML 胶囊 + 内嵌小图标）
 *
 * 主人给的就是一段自包含的 `<svg>`（`transform="rotate(-2 70 20)"` 那版）。做成
 * 单个 SVG 的另一个好处是**倾角不需要动布局**：倾斜发生在 SVG 内部坐标系里，
 * 外层元素的盒子仍是正的（否则 `.ucRoleTag` 那条"与昵称同行、在昵称右缘之后"的
 * 几何断言会因为斜框变宽而误判）。
 *
 * ## 三条硬约束（踩过的坑，改这个组件前先读）
 *
 * ① **外层必须是 `display: inline-block`**：`getBoundingClientRect()` 对 inline 元素
 *    返回的是**行盒**（整行宽度），几何断言会把它读成"和昵称一样宽"。inline-block
 *    才是这枚徽章自己的盒子。
 * ② **`role`/`aria-label`/`data-role` 挂在外层 `<span>` 上，不是 `<svg>` 上**：
 *    Chromium 的 `innerText` **会**把 SVG `<text>` 读进来（实测 `innerText` 返回
 *    「🐟 杂 鱼 🐟」），所以断言一律走 `[data-role]` 的 `aria-label`。三个属性挂在
 *    同一个元素上，选择器一取就能读，不用再下探一层。
 * ③ **渐变 id 必须每实例唯一**：同页会有十几枚徽章，同 id 的 `<linearGradient>` 会
 *    被浏览器解析到**第一个**同 id 定义上——只要那一枚恰好是别的角色，颜色就串了。
 *    用 `useId()` 生成并去掉冒号（`url(#:r1:)` 这种片段在部分实现里不认）。
 *
 * ## 未知角色
 *
 * 不编样式：中性灰胶囊 + 原样文字，`data-role=""`。沿用站内那条纪律
 * ——**不为认不出的角色编一个"看起来很严重"的样子**。
 */
interface RoleBadgeProps {
    /** 角色名（取值域见 Rust 侧 `src/authz.rs::KNOWN_ROLES` / `utils/auth.ts::ROLE_LABEL`） */
    role?: string | null
    /** 徽章高度（px）。默认 26 —— 后台行与个人中心昵称行都放得下 */
    size?: number
    className?: string
    style?: React.CSSProperties
}

/** 一档的图形语言。`label` 一律从 `ROLE_LABEL` 取，**这里不再抄一份中文名**。 */
interface BadgeSpec {
    /** 起始表情（画在文字左边）。**空串 = 这一档不带表情**（站长就是） */
    lead: string
    /** 收尾表情（只有杂鱼有——主人样例就是「🐟 杂 鱼 🐟」） */
    tail?: string
    /** 渐变两端 */
    from: string
    to: string
    /** 文字色（在浅色渐变上取深色，保证读得清） */
    ink: string
    /** 倾角（度）。**20261003 起除杂鱼外一律 0**（主人要求扶正），别再靠它区分 */
    tilt: number
    /** 白边样式 */
    ring: 'double' | 'solid' | 'dashed' | 'plain'
    /** 左右留白 */
    padX: number
    /** 字号（默认 12） */
    fontSize?: number
    /** 两端小星（20261003 起只有管理员有——它接手了原超管那一套） */
    stars?: boolean
}

/** 五档的图形语言。20261003 主人点名做了两件事：
 *  ① **扶正**（除杂鱼外倾角清零）——留白从此只有"图形 / 白边 / 配色"三根支柱；
 *  ② **换装**——`admin` 接手原 `superadmin` 那一套（薰衣草→粉、双层白描边、两端小星），
 *     而 `superadmin` 换成下面这套新的（文案「站长」、**不带表情**）。
 *
 *  站长这套刻意**不用表情也不用小星**：主人的原话是"文本内容只写站长，不要加表情图标
 *  在文本"，所以它的辨识全落在配色与白边上——配色是**站里从没用过的一族暖色**
 *  （奶油黄 `#ffe3ac` → 蜜桃 `#ffb98a`），是五档里唯一暖色，与管理员那支冷调的
 *  薰衣草→粉隔着整个色轮；白边则用**只剩它一档在用**的 `solid`。
 *
 *  **别顺手把它换成原管理员那对（玫粉 `#d94f9a` → 蜜桃 `#ffb38a`）**：20261003 一度是
 *  这么写的，主人看过对照图后否掉了——`admin` 接手超管那一套的同时，超管再穿上管理员
 *  刚脱下的那一套，两档就成了"衣服对调"，一眼看过去像谁也没换新。主人要的是
 *  "超管另换一套新样式"，所以站长这档必须是**此前没人穿过**的配色。 */
const SPECS: Record<string, BadgeSpec> = {
    // 站长（后端角色键仍是 superadmin）：奶油黄→蜜桃、实线白边、**无表情无小星**、不倾斜
    superadmin: {
        lead: '', from: '#ffe3ac', to: '#ffb98a', ink: '#7a4a22',
        tilt: 0, ring: 'solid', padX: 14,
    },
    // 管理员：接手原超管那套——薰衣草→粉、双层白描边、两端小星；只在皇冠与文案上仍是自己
    // （20261003 主人点名：盾牌 🛡 换皇冠 👑。两个字形都在 U+1F000 以上，`textWidth`
    //  的 emoji 分支不变——不必重新量宽度。）
    admin: {
        lead: '👑', from: '#b9a7f5', to: '#ff9ec9', ink: '#5b3a7e',
        tilt: 0, ring: 'double', padX: 16, stars: true,
    },
    // 秘书：薄荷→天蓝、白色虚线内边
    secretary: {
        lead: '🖋', from: '#9fe3c8', to: '#8fd3ea', ink: '#2f6b6b',
        tilt: 0, ring: 'dashed', padX: 10,
    },
    // 普通用户：最素的一档——无虚线、字小一档，只有一条细白边（本来就不倾斜）
    user: {
        lead: '🍃', from: '#ffd9e8', to: '#fffaf5', ink: '#a8547e',
        tilt: 0, ring: 'plain', padX: 9, fontSize: 11,
    },
    // 杂鱼：照主人给的样例——粉→蓝渐变、白色虚线内边、**-2° 是唯一保留的倾角**
    zako: {
        lead: '🐟', tail: '🐟', from: '#ff9ec9', to: '#8fd3ea', ink: '#5d3a63',
        tilt: -2, ring: 'dashed', padX: 10,
    },
}

/** 未知角色的兜底样式：中性灰，不加表情、不倾斜。 */
const FALLBACK: BadgeSpec = {
    lead: '', from: '#e3e3e8', to: '#f4f4f6', ink: '#6b6b73',
    tilt: 0, ring: 'plain', padX: 9,
}

/** 逐字加空格（主人样例的字距风：`🐟 杂 鱼 🐟`）。
 *
 *  **只对全汉字标签生效**：未知角色那支显示的是原样的 role 串（`root`、`SuperAdmin`），
 *  把拉丁字母拆成 `r o o t` 只会读不出来——那正是「原样显示」要避免的事。 */
function spaced(s: string): string {
    return /^[一-鿿]+$/.test(s) ? [...s].join(' ') : s
}

/**
 * 文本宽度估算（px）。SVG 里没有自动撑开盒子的能力，`viewBox` 的宽度得自己算。
 *
 * 为什么要**分类估算**而不是 `字数 × 一个字宽`：标签里混着三种字宽——全角汉字
 * （1em）、半角空格（0.34em）、emoji（约 1.15em，且两端还各带一点边距）。
 * 按同宽算会让「🍃 普 通 用 户」这类窄标签留出大片空白，或让带两个 emoji 的
 * 杂鱼徽章把字挤到边线上。数值是按 Chromium 的实际渲染量出来的——**改这里的系数
 * 就要重新出一张五档对照图核对**（esbuild 就地打包本组件 + playwright 截图，
 * 五档各一枚并排；本机无中文字体时汉字会是豆腐块，只看几何与配色即可）。
 */
function textWidth(s: string, fontSize: number): number {
    let w = 0
    for (const ch of s) {
        const cp = ch.codePointAt(0) ?? 0
        if (ch === ' ') w += fontSize * 0.34
        else if (cp > 0x1f000) w += fontSize * 1.15 // emoji
        else if (cp >= 0x2e80) w += fontSize // 汉字/全角
        else w += fontSize * 0.6
    }
    return w
}

/** 四角小星（20261003 起只有管理员一档在用）。四角星 = 两条细长的菱形叠在一起。 */
const Sparkle: React.FC<{ cx: number; cy: number; r: number }> = ({ cx, cy, r }) => (
    <path
        d={`M${cx} ${cy - r}C${cx + r * 0.18} ${cy - r * 0.18} ${cx + r * 0.18} ${cy - r * 0.18} ${cx + r} ${cy}
            C${cx + r * 0.18} ${cy + r * 0.18} ${cx + r * 0.18} ${cy + r * 0.18} ${cx} ${cy + r}
            C${cx - r * 0.18} ${cy + r * 0.18} ${cx - r * 0.18} ${cy + r * 0.18} ${cx - r} ${cy}
            C${cx - r * 0.18} ${cy - r * 0.18} ${cx - r * 0.18} ${cy - r * 0.18} ${cx} ${cy - r}Z`}
        fill="#fff"
        opacity="0.95"
    />
)

export const RoleBadge: React.FC<RoleBadgeProps> = ({ role, size = 26, className, style }) => {
    const rawId = useId()
    const gid = `rb-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}-${role || 'x'}`
    const spec = (role && SPECS[role]) || FALLBACK
    const label = (role && ROLE_LABEL[role]) || role || '—'

    const text = [spec.lead, spaced(label), spec.tail].filter(Boolean).join('  ')
    // 高度是唯一的尺寸输入，其余按 26px 基准等比缩放（换 size 不必改任何常驻样式）
    const k = size / 26
    const h = size
    const fs = (spec.fontSize ?? 12) * k
    const padX = spec.padX * k
    const w = Math.round(textWidth(text, fs) + padX * 2)
    const cy = h / 2
    // 胶囊内缩 2px：倾角会让角越过 1px 的边（-2° 时约 1.4px），内缩 2px 才不裁角。
    // 20261003 扶正之后这条只剩杂鱼那一档还需要，但**内缩对五档一视同仁**：留着它，
    // 哪天再给某一档加倾角就不必回头改布局。
    const inset = 2 * k
    const rx = (h - inset * 2) / 2

    return (
        <span
            className={className}
            // ① 几何断言读的是这个盒子，inline 会被读成行盒（见头注）
            style={{ display: 'inline-block', lineHeight: 0, ...style }}
            data-role={role && SPECS[role] ? role : ''}
            role="img"
            aria-label={label}
        >
            <svg
                width={w}
                height={h}
                viewBox={`0 0 ${w} ${h}`}
                aria-hidden="true"
                focusable="false"
                style={{ display: 'block' }}
            >
                <title>{label}</title>
                <defs>
                    <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor={spec.from} />
                        <stop offset="100%" stopColor={spec.to} />
                    </linearGradient>
                </defs>
                {/* 倾斜只发生在这个组里：外层盒子仍是正的（见头注 ①） */}
                <g transform={`rotate(${spec.tilt} ${w / 2} ${cy})`}>
                    <rect
                        x={inset}
                        y={inset}
                        width={w - inset * 2}
                        height={h - inset * 2}
                        rx={rx}
                        fill={`url(#${gid})`}
                        stroke="rgba(255,255,255,0.9)"
                        strokeWidth={(spec.ring === 'plain' ? 1 : 1.6) * k}
                    />
                    {spec.ring === 'double' && (
                        <rect
                            x={inset + 2.6 * k}
                            y={inset + 2.6 * k}
                            width={w - (inset + 2.6 * k) * 2}
                            height={h - (inset + 2.6 * k) * 2}
                            rx={rx - 2.6 * k}
                            fill="none"
                            stroke="#fff"
                            strokeWidth={1 * k}
                            opacity="0.85"
                        />
                    )}
                    {spec.ring === 'dashed' && (
                        <rect
                            x={inset + 2.6 * k}
                            y={inset + 2.6 * k}
                            width={w - (inset + 2.6 * k) * 2}
                            height={h - (inset + 2.6 * k) * 2}
                            rx={rx - 2.6 * k}
                            fill="none"
                            stroke="#fff"
                            strokeWidth={1 * k}
                            strokeDasharray={`${2.4 * k} ${2.4 * k}`}
                            opacity="0.9"
                        />
                    )}
                    {spec.stars && (
                        <>
                            <Sparkle cx={padX * 0.6} cy={cy} r={4.6 * k} />
                            <Sparkle cx={w - padX * 0.6} cy={cy} r={4.6 * k} />
                        </>
                    )}
                    <text
                        x={w / 2}
                        y={cy}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill={spec.ink}
                        fontSize={fs}
                        fontWeight={600}
                        style={{ fontFamily: 'inherit' }}
                    >
                        {text}
                    </text>
                </g>
            </svg>
        </span>
    )
}

export default RoleBadge

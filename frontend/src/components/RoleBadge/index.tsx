import React, { useId } from 'react'
import { ROLE_LABEL } from '../../utils/auth'

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
    tilt: number
    /** 白边样式 */
    ring: 'double' | 'solid' | 'dashed' | 'plain'
    /** 左右留白 */
    padX: number
    /** 字号（默认 12） */
    fontSize?: number
    stars?: boolean
}

const SPECS: Record<string, BadgeSpec> = {
    // 站长（后端角色键仍是 superadmin）：奶油黄→蜜桃、实线白边、**无表情无小星**、不倾斜
    superadmin: {
        lead: '', from: '#ffe3ac', to: '#ffb98a', ink: '#7a4a22',
        tilt: 0, ring: 'solid', padX: 14,
    },
    admin: {
        lead: '👑', from: '#b9a7f5', to: '#ff9ec9', ink: '#5b3a7e',
        tilt: 0, ring: 'double', padX: 16, stars: true,
    },
    // 普通用户：最素的一档——无虚线、字小一档，只有一条细白边（本来就不倾斜）
    user: {
        lead: '', from: '#ffd9e8', to: '#fffaf5', ink: '#a8547e',
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

/** 按全角、半角空格与 emoji 的字宽估算 SVG viewBox；调整系数时核对各角色徽章。 */
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

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
        <g transform="translate(0,-0.8)">
            <path d="M13.8 8.6V4.9a2.8 2.8 0 0 0-2.8-2.8l-3.9 8.9v10.9h11.2a2 2 0 0 0 1.97-1.65l1.4-9.1a2 2 0 0 0-1.97-2.35z" />
            <path d="M7.1 21.9H4.5a2.4 2.4 0 0 1-2.4-2.4v-7a2.4 2.4 0 0 1 2.4-2.4h2.6" />
        </g>
    </svg>
)

/** 踩图标与赞图标镜像；两者分别使用光学居中偏移。 */
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
        <g transform="translate(0,1.1)">
            <path d="M13.8 15.4v3.7a2.8 2.8 0 0 1-2.8 2.8l-3.9-8.9V2.1h11.2a2 2 0 0 1 1.97 1.65l1.4 9.1a2 2 0 0 1-1.97 2.35z" />
            <path d="M7.1 2.1H4.5a2.4 2.4 0 0 0-2.4 2.4v7a2.4 2.4 0 0 0 2.4 2.4h2.6" />
        </g>
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

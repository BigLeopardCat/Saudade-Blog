import './shared.sass'


/** 驳回理由上限（**字符**）。与后端 `talks::clip_reject_reason` 的 200 是同一个数——
 *  改一处要三处一起改（本常量 + 后端那个 + `quota.rs` 那条同形链路的 255 是另一件事，别抄）。 */
export const REJECT_REASON_MAX = 200

/** 六条**跨场地通用**的违规类型：点一下填进**可编辑**的文本框，管理员按需改。
 *  只放"一眼能判、与站规对得上"的类型；不放需要展开说明的（那种请他用文本框自己写）；
 *  也不放"其他"这种等于没填的项——理由必填的意义就在于说清是哪一类。 */
const COMMON_REJECT_PRESETS = [
    '广告引流', '色情低俗', '辱骂攻击', '违法敏感', '恶意外链', '内容难以辨认',
]

/** 场地专属那条**固定插在第 6 位**（"恶意外链"之后）：两页的按钮顺序因此逐字相同，
 *  管理者在两页之间来回切时按钮位置不变、形成肌肉记忆。顺序是界面契约的一部分，
 *  不是随便排的——所以这里用 `slice` 拼，而不是把场地那条追加到末尾。 */
const withVenue = (venueItem: string) => [
    ...COMMON_REJECT_PRESETS.slice(0, 5),
    venueItem,
    ...COMMON_REJECT_PRESETS.slice(5),
]

/** 留言板那一组（河灯）：离题那条说「与留言板无关」 */
export const BOARD_REJECT_PRESETS = withVenue('与留言板无关')

/** 文章评论那一组：离题那条说「与文章无关」 */
export const COMMENT_REJECT_PRESETS = withVenue('与文章无关')

/** `aiTip` 要读的那**一个**字段。两页的行类型不同（`BoardItem` / `CommentAdminItem`），
 *  但都有它——按结构取参，不把两种行类型拉到一个联合类型里（那会逼着两页的字段名统一，
 *  而它们本来就该各自演化）。 */
export interface AiReasoned {
    /** AI 审核说明；null/缺省 = 没走 AI、AI 没给说明、或存量行 */
    aiReason?: string | null
}

export const aiTip = (base: string, r: AiReasoned) => (
    r.aiReason
        ? (
            <div className="content-ai-tip">
                {base}
                <div className="content-ai-reason">AI 说明：{r.aiReason}</div>
            </div>
        )
        : base
)

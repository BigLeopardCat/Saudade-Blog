import './shared.sass'

/**
 * 内容管理两页共用的**常量与那一处实现**（20261002）。
 *
 * ── 为什么有这一层、又只有这么点东西 ─────────────────────────────────────
 * 留言板（`Dashboard/BoardManage`）与文章评论（`Dashboard/CommentManage`）是**两种内容、
 * 两张表、两条接口**：列不同（河灯按印章/灯型，评论按文章/被回复者）、筛选项不同
 * （河灯按印章，评论按审核状态）。所以整页**不合并**——参数化出一个两处都不好读的
 * 组件，比两份页面更贵，这正是 `QuotaManage` 当初各自成页的理由。
 *
 * 共用的是下面这几样，判据是"**它们是同一件事**"，而不是"它们长得像"：
 *   · 违规类型预设那一组词——两种内容的审核是同一件事，改词必须一起改；
 *   · 驳回理由上限——两页的 `textarea maxLength` 与后端 `talks::clip_reject_reason`
 *     是同一个数；
 *   · `aiTip`——AI 审核列 tooltip **成型的那几行 markup**（裁决语义 + AI 说明全文）。
 *     这是一处实现、不是一句文案：两页各写一份，两边的换行/tooltip 宽度迟早会漂。
 *
 * `QuotaManage` 那份驳回预设（"理由不充分"/"额度还有剩余"…）**故意不进来**：它是额度
 * 语义，与内容审核不是同一组词，硬拉进来只会让两边都别扭。
 * `Dashboard/ContentManage/` 目前只有这一个模块，没有同名页面——两页仍是同级的
 * `BoardManage/` 与 `CommentManage/` 两个目录。
 */

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

/** AI 审核列的 tooltip：裁决语义 + **AI 的说明全文**（20260926 补）。
 *  说明 ≤200 字，刻意不截断——管理员正是要照它写出具体理由；它此前只存在于 AI 服务
 *  那一次的 HTTP 响应里（`ai_result` 那一列存的是裁决词，从来没有展示过说明）。
 *
 *  样式（`.content-ai-tip`）由本模块自己的 `./shared.sass` 带进来，**不挂到哪一页的
 *  样式表上**：挂在别人家就是"哪天那一页不再加载，这里静默变形"。 */
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

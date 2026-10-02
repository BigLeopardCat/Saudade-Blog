/**
 * 个人中心一期（20260922）后端 DTO 的前端类型。
 * 字段名与 Rust 侧 serde 的线上口径一致（驼峰），**不要按 Rust 字段名写**——
 * 例如 ChangePasswordRequest 的线上键名是 oldPassword/newPassword。
 */

/** GET/PUT /api/protected/profile */
export interface ProfileInfo {
    username: string;
    nickname: string;
    /** 头像 URL；null/空 = 没设过，展示端回退到站点主人头像 */
    avatar?: string | null;
    /** 角色（20260926）：个人中心昵称后面的权限身份标签用它。
     *  **后端从库里现读**（不是令牌快照，见 src/routes/auth.rs::ProfileDto）。 */
    role?: string;
    /** 昵称是否被**迁移自动加过后缀**（20261002 昵称唯一）：true = 原来的昵称和别人
     *  重复，系统改成了 `原名_<id>`，个人中心显示一条横幅提示本人改掉。
     *  本人改一次昵称就变 false。字段**缺失**（前端已上线、后端还没到）按 false 处理
     *  ——即"不显示横幅"：这是唯一一种安静的失败，而反过来的默认值会在所有老账号上
     *  弹一条假的"你的昵称重复了"。 */
    nicknameAutoRenamed?: boolean;
    /** **当前是否处于禁言期**（20261002 内容风控）：true 时个人中心显示一条横幅。
     *  判据在后端（`authz::is_muted` = 现在 < 到期时刻），前端**不做时间比较**——
     *  自己算一遍就会有两个真相源，而"永久"是一个哨兵值、比错一次就露馅。
     *  字段缺失按 false（老后端 + 新前端）：不显示横幅是这里唯一安静的失败。 */
    muted?: boolean;
    /** 禁言到期时刻的**人话**（`永久` / `至 2026-10-04 12:00`），未禁言时 null。
     *  由后端 `authz::mute_until_text` 产出，前端**只印不算**（见上一条）。 */
    mutedUntil?: string | null;
}

/** GET /api/protected/favorites 的单行 */
export interface FavoriteItem {
    noteId: number;
    title: string;
    status: string;
    createdAt: string;
}

/** GET /api/protected/notifications 的单行 */
export interface NotificationItem {
    id: number;
    /** announcement = 公告，notice = 站内通知（留言回复等，本期留接口） */
    type: 'announcement' | 'notice' | string;
    title: string;
    content: string;
    /** 详情链接，公告类为空 */
    link?: string | null;
    isRead: boolean;
    createdAt: string;
}

export interface NotificationList {
    unread: number;
    items: NotificationItem[];
}

/** GET /api/protected/notifications/summary（红点数据源，20260924 四轮起兼给后台待审数） */
export interface UnreadSummary {
    notifications: number;
    messages: number;
    /** 红点用的合计 = 通知 + 私信（**不含** pendingReview / pendingQuota，见后端 UnreadDto） */
    total: number;
    /** 等人工裁决的留言条数（后台首页那行提示用；非管理员恒 0） */
    pendingReview: number;
    /** 等处理的额度重置申请条数（20260929；同 pendingReview：只有能进后台的人算，恒不计进 total） */
    pendingQuota: number;
}

/** GET /api/protected/quota（个人中心「对话额度」页签）。
 *  四个数与 `/chat` body 里的 `chat_quota` **同源同形**（后端同一个 `quota::forward_json`），
 *  所以别在别处另写一份取数字段。 */
export interface QuotaInfo {
    /** 已用轮数。**不限额账号恒 0**（它的计数器从来不增长） */
    used: number;
    /** 上限。**0 = 不限额**（管理员档），不是"上限为零" */
    limit: number;
    /** 剩余 = max(0, limit - used)，**后端算好**，前端不重算 */
    remaining: number;
    /** true = 不限额（limit/remaining 无意义，界面显示「不限额」而不是 0/0） */
    unlimited: boolean;
    /** 我最新一份**待处理**的申请；null = 没有申请过、或上一份已处理完 */
    pendingRequest?: PendingQuotaRequest | null;
}

/** QuotaInfo.pendingRequest（只回申请人自己需要知道的三个字段） */
export interface PendingQuotaRequest {
    id: number;
    /** 我当时写的理由（可空——空理由后端存 NULL） */
    reason?: string | null;
    createdAt: string;
}

/** GET /api/protected/quota/requests 的单行（后台额度管理页签与 agent 共用同一个接口） */
export interface QuotaRequestRow {
    id: number;
    userId: number;
    username: string;
    nickname: string;
    /** 申请人**当前**已用轮数（不是提交那一刻的快照） */
    used: number;
    /** 上限；0 = 不限额（见后端 quota::limit_of） */
    limit: number;
    reason?: string | null;
    /** **三值不是布尔**：0 = 待处理 / 1 = 已批准 / 2 = 已驳回（只有 0 能处理） */
    status: number;
    /** 管理员的驳回理由（批准时为 null） */
    note?: string | null;
    createdAt: string;
    handledAt?: string | null;
}

/** 信箱里的一封（收发共用一个形状，peer* = 对方） */
export interface MessageItem {
    id: number;
    fromUserId: number;
    toUserId: number;
    peerName: string;
    peerAvatar?: string | null;
    /** 信件标题（20260922 起）。**可空**：这一列是后加的，此前发出的信没有标题，
     *  界面上按「（无标题）」显示，不拿正文首行冒充。 */
    title?: string | null;
    content: string;
    isRead: boolean;
    createdAt: string;
}

export interface Mailbox {
    inbox: MessageItem[];
    outbox: MessageItem[];
    unread: number;
}

/** 站内信草稿箱的一行（20260923）。`toUsername` 是**用户当时敲的原文**（账号或 UID），
 *  后端不校验、也不解析——只在真正发送时才认这个收件人是否存在。 */
export interface MessageDraft {
    id: number;
    toUsername?: string | null;
    title?: string | null;
    content: string;
    createdAt: string;
    updatedAt: string;
}

/** GET /api/protected/my/talks（我的留言记录） */
export interface MyTalk {
    id: number;
    src: string;
    title: string;
    content: string;
    cat: string;
    v: number;
    author: string;
    approved: number;
    /** 驳回理由（20260923）：仅 approved=2 时可能有值（AI 判定说明或管理员手填），
     *  其余状态恒 null；改判通过时后端会清空 */
    rejectReason?: string | null;
    createdAt: string;
}

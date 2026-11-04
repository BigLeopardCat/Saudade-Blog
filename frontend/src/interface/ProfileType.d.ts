/** GET/PUT /api/protected/profile */
export interface ProfileInfo {
    username: string;
    nickname: string;
    /** 头像 URL；null/空 = 没设过，展示端回退到站点主人头像 */
    avatar?: string | null;
    role?: string;
    nicknameAutoRenamed?: boolean;
    muted?: boolean;
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

export interface UnreadSummary {
    notifications: number;
    messages: number;
    /** 红点用的合计 = 通知 + 私信（**不含**下面那三格，见后端 UnreadDto） */
    total: number;
    /** 等人工裁决的**河灯留言**条数（后台首页第一行提示用；非管理员恒 0）。
     *  ⚠️ 数的是 `talk`（`/guestbook` 那套、后台 `?tab=review`），**不是文章评论**。 */
    pendingReview: number;
    pendingQuota: number;
    pendingComments: number;
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
    rejectReason?: string | null;
    createdAt: string;
}

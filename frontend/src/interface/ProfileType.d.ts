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

/** GET /api/protected/notifications/summary（红点数据源） */
export interface UnreadSummary {
    notifications: number;
    messages: number;
    total: number;
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
    createdAt: string;
}

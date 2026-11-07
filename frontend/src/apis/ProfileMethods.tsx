import http from "./axios.tsx";
import type {
    FavoriteItem,
    Mailbox,
    MessageDraft,
    MessageItem,
    MyTalk,
    NotificationItem,
    NotificationList,
    ProfileInfo,
    QuotaInfo,
    QuotaRequestRow,
    UnreadSummary,
} from "../interface/ProfileType";

/** 后端信封（ApiResponse<T>）：code=200 才是成功 */
export interface Envelope<T> {
    code: number;
    message: string;
    data: T;
}

/** 是否成功（code 口径，不是 HTTP 状态码——见文件头） */
export const ok = (res: { status: number; data: Envelope<any> }): boolean =>
    res.status === 200 && res.data?.code === 200;

/** 失败原因（后端的中文 message；拿不到就给一句兜底，绝不编具体原因） */
export const errMsg = (res: { data?: Envelope<any> }, fallback = "操作失败，请稍后再试"): string =>
    (res?.data?.message || "").trim() || fallback;

// 用户设置

function getProfile() {
    return http<Envelope<ProfileInfo>>({
        url: "/api/protected/profile",
        method: "GET",
    });
}

function updateNickname(nickname: string) {
    return http<Envelope<ProfileInfo>>({
        url: "/api/protected/profile",
        method: "PUT",
        data: { nickname },
    });
}

function changePassword(oldPassword: string, newPassword: string) {
    return http<Envelope<{ token: string }>>({
        url: "/api/protected/profile/password",
        method: "PUT",
        data: { oldPassword, newPassword },
    });
}

/** 上传**裁切后**的头像。字段名 avatar 与后端 multipart 解析的字段名一致。 */
function uploadAvatar(file: File) {
    const form = new FormData();
    form.append("avatar", file, file.name || "avatar.jpg");
    return http<Envelope<{ avatar: string }>>({
        url: "/api/protected/profile/avatar",
        method: "POST",
        data: form,
        // 2MiB 上限由后端判；15s 默认超时对慢速上传偏紧，这里放宽
        timeout: 30000,
    });
}

// 收藏的文章

function getFavorites() {
    return http<Envelope<FavoriteItem[]>>({
        url: "/api/protected/favorites",
        method: "GET",
    });
}

type FavoriteMutation = { ownerUserId: number; noteId: number; isFavorite: boolean; changed: boolean }

function addFavorite(noteId: number) {
    return http<Envelope<FavoriteMutation>>({
        url: "/api/protected/favorites",
        method: "POST",
        data: { noteId },
    });
}

function removeFavorite(noteId: number) {
    return http<Envelope<FavoriteMutation>>({
        url: `/api/protected/favorites/${noteId}`,
        method: "DELETE",
    });
}

// 公告与通知（红点）

function getUnreadSummary() {
    return http<Envelope<UnreadSummary>>({
        url: "/api/protected/notifications/summary",
        method: "GET",
    });
}

function getNotifications() {
    return http<Envelope<NotificationList>>({
        url: "/api/protected/notifications",
        method: "GET",
    });
}

/** 标记已读：传 ids 或 all=true（两者都传时后端按 ids 处理） */
function getPendingAnnouncement() {
    return http<Envelope<NotificationItem | null>>({
        url: "/api/protected/notifications/announcement", method: "GET",
    });
}

function deleteNotification(id: number) {
    return http<Envelope<UnreadSummary>>({
        url: `/api/protected/notifications/${id}`, method: "DELETE",
    });
}

function deleteMessage(id: number, folder: 'inbox' | 'outbox') {
    return http<Envelope<UnreadSummary>>({
        url: `/api/protected/messages/${id}`, method: "DELETE", params: { folder },
    });
}

function readNotifications(payload: { ids?: number[]; all?: boolean }) {
    return http<Envelope<UnreadSummary>>({
        url: "/api/protected/notifications/read",
        method: "POST",
        data: { ids: payload.ids ?? [], all: payload.all ?? false },
    });
}

// 站内信箱

function getMailbox() {
    return http<Envelope<Mailbox>>({
        url: "/api/protected/messages",
        method: "GET",
    });
}

function sendMessage(toUsername: string, title: string, content: string) {
    return http<Envelope<MessageItem>>({
        url: "/api/protected/messages",
        method: "POST",
        data: { toUsername, title, content },
    });
}

function readMessages(payload: { ids?: number[]; all?: boolean }) {
    return http<Envelope<Mailbox>>({
        url: "/api/protected/messages/read",
        method: "POST",
        data: { ids: payload.ids ?? [], all: payload.all ?? false },
    });
}


function getDrafts() {
    return http<Envelope<MessageDraft[]>>({
        url: "/api/protected/messages/drafts",
        method: "GET",
    });
}

/** 存草稿。**带 id 是改、不带是新建**——调用方必须把返回值的 id 接住，
 *  否则一次写信里点两次「存草稿」会攒出两条内容相同的草稿（后端只认 id）。 */
function saveDraft(payload: { id?: number; toUsername?: string; title?: string; content: string }) {
    return http<Envelope<MessageDraft>>({
        url: "/api/protected/messages/drafts",
        method: "POST",
        data: {
            id: payload.id,
            toUsername: payload.toUsername ?? "",
            title: payload.title ?? "",
            content: payload.content,
        },
    });
}

/** 删草稿（幂等：没这条也回成功） */
function deleteDraft(id: number) {
    return http<Envelope<string>>({
        url: `/api/protected/messages/drafts/${id}`,
        method: "DELETE",
    });
}

// 我的留言记录

function getMyTalks() {
    return http<Envelope<MyTalk[]>>({
        url: "/api/protected/my/talks",
        method: "GET",
    });
}


/** 我的额度现状（个人中心「对话额度」页签）。`used/limit/remaining` 与 `/chat` body 里的
 *  `chat_quota` 同源；`pendingRequest` 是我最新一份待处理申请（null = 没有）。 */
function getMyQuota() {
    return http<Envelope<QuotaInfo>>({
        url: "/api/protected/quota",
        method: "GET",
    });
}

/** 提交一份额度重置申请。`reason` 可空（空串按"没填"处理，后端存 NULL）；
 *  已有待处理申请时后端回 `你已经有一份待处理的申请了`（code=500，走 errMsg）。 */
function applyQuotaReset(reason: string) {
    return http<Envelope<string>>({
        url: "/api/protected/quota/apply",
        method: "POST",
        data: { reason },
    });
}

/** 申请队列（后台「额度管理」页签 + agent 的 list_quota_requests 工具共用这一条接口）。
 *  `status` 传 `'pending'` 只看待处理，其余（含不传）看全部。 */
function getQuotaRequests(status?: 'pending' | 'all') {
    return http<Envelope<QuotaRequestRow[]>>({
        url: "/api/protected/quota/requests",
        method: "GET",
        params: status ? { status } : undefined,
    });
}

/** 批准 / 驳回一份申请。`reason` 只在驳回时有意义（批准时后端恒把 note 落 NULL）。
 *  **批准会清零对方的计数器**，且界面上撤不回来。 */
function reviewQuotaRequest(id: number, approved: boolean, reason?: string) {
    return http<Envelope<string>>({
        url: `/api/protected/quota/requests/${id}/review`,
        method: "POST",
        data: { approved, reason: reason ?? "" },
    });
}

export {
    getProfile,
    updateNickname,
    changePassword,
    uploadAvatar,
    getFavorites,
    addFavorite,
    removeFavorite,
    getUnreadSummary,
    getNotifications,
    getPendingAnnouncement,
    deleteNotification,
    deleteMessage,
    readNotifications,
    getMailbox,
    sendMessage,
    readMessages,
    getDrafts,
    saveDraft,
    deleteDraft,
    getMyTalks,
    getMyQuota,
    applyQuotaReset,
    getQuotaRequests,
    reviewQuotaRequest,
};

/**
 * 个人中心一期（20260922）接口层。
 *
 * 全部走 `public_routes` 里那族**自身鉴权**的接口（任意登录用户可用，见
 * src/routes/profile.rs 头注）。两个口径上的坑写在下面，改动时别踩回去：
 *
 * 1. **失败不是 HTTP 4xx**：这族接口无 token 也返回 HTTP 200 + `code=500` +
 *    `message=中文原因`（与 /api/protected/profile 一致）。所以判成功必须看
 *    `code === 200`，只判 `res.status === 200` 会把"未登录/收藏失败"当成功。
 *    这里统一用 `ok(res)` 收口，调用点不必各写一遍。
 * 2. **错误提示由调用方决定**：本层只把 message 原样带着，不弹 toast——
 *    同一个失败在不同窗口里的措辞不一样（表单要留在原地，列表要刷新）。
 */
import http from "./axios.tsx";
import type {
    FavoriteItem,
    Mailbox,
    MessageDraft,
    MessageItem,
    MyTalk,
    NotificationList,
    ProfileInfo,
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

// ── 用户设置 ────────────────────────────────────────────────────────────────

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
    return http<Envelope<string>>({
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

// ── 收藏的文章 ──────────────────────────────────────────────────────────────

function getFavorites() {
    return http<Envelope<FavoriteItem[]>>({
        url: "/api/protected/favorites",
        method: "GET",
    });
}

function addFavorite(noteId: number) {
    return http<Envelope<string>>({
        url: "/api/protected/favorites",
        method: "POST",
        data: { noteId },
    });
}

function removeFavorite(noteId: number) {
    return http<Envelope<string>>({
        url: `/api/protected/favorites/${noteId}`,
        method: "DELETE",
    });
}

// ── 公告与通知（红点） ──────────────────────────────────────────────────────

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
function readNotifications(payload: { ids?: number[]; all?: boolean }) {
    return http<Envelope<UnreadSummary>>({
        url: "/api/protected/notifications/read",
        method: "POST",
        data: { ids: payload.ids ?? [], all: payload.all ?? false },
    });
}

// ── 站内信箱 ────────────────────────────────────────────────────────────────

function getMailbox() {
    return http<Envelope<Mailbox>>({
        url: "/api/protected/messages",
        method: "GET",
    });
}

/** 发站内信。title 选填（20260922 起）——空串按"没填"处理，后端存 NULL。
 *  `toUsername` 里填**对方账号或 UID**（20260923 起；昵称通道已撤，昵称不保证唯一）。 */
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

// ── 草稿箱（20260923）───────────────────────────────────────────────────────

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

// ── 我的留言记录 ────────────────────────────────────────────────────────────

function getMyTalks() {
    return http<Envelope<MyTalk[]>>({
        url: "/api/protected/my/talks",
        method: "GET",
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
    readNotifications,
    getMailbox,
    sendMessage,
    readMessages,
    getDrafts,
    saveDraft,
    deleteDraft,
    getMyTalks,
};

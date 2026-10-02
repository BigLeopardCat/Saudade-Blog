/**
 * 文章评论接口层（20261002）。后端见 `src/routes/comments.rs`。
 *
 * 三条口径（与 `NoteStatsMethods.tsx` 同一族接口，别踩反）：
 *
 * 1. **成功判据是 `code === 200`，不是 HTTP 状态码**。这三条挂在 `public_routes`
 *    + handler 自身鉴权，未登录返回的是 HTTP 200 + `code=500`「请先登录后再评论」
 *    ——只判 `res.status` 会把"没登录"当成"发成功了"。统一用 `ok()` / `errMsg()`。
 * 2. **读接口对未登录是成功的**（看文章不需要登录，讨论区跟着它）。未登录时
 *    `mine` 恒 false，仅此而已——别在调用方提前拦一道。
 * 3. **写接口不带访客标识**。评论强制登录（`note_comment.user_id` 恒 >0），
 *    没有"匿名评论"这回事；带过去只会让服务端多一个不用的头。
 */
import http from "./axios.tsx";
import type { Envelope } from "./ProfileMethods";
import type { CommentItem, CreateCommentResult } from "../interface/CommentType";

/** 某篇文章的全部公开评论（顶层 + 回复，扁平数组，前端按 rootId 分组）。
 *  只含已通过审核的：待审/未通过/已删除的评论在公开侧**不存在**。 */
function listComments(noteId: number | string) {
    return http<Envelope<CommentItem[]>>({
        url: `/api/public/notes/${noteId}/comments`,
        method: "GET",
    });
}

/** 发一条评论（`parentId` 为空）或回复（`parentId` = 被回复的那条 id）。
 *
 *  **只传 `parentId`**：`rootId` / `replyToUid` 由服务端从父行派生——客户端
 *  无从决定"我的回复挂在哪条顶层下"，这是结构上的保证，不是约定。 */
function createComment(noteId: number | string, content: string, parentId?: number | null) {
    return http<Envelope<CreateCommentResult>>({
        url: `/api/public/notes/${noteId}/comments`,
        method: "POST",
        data: { content, parentId: parentId ?? null },
    });
}

/** 删自己的评论（软删）。删别人的、删不存在的，服务端一律回「评论不存在」 */
function deleteMyComment(id: number) {
    return http<Envelope<string>>({
        url: `/api/public/comments/${id}`,
        method: "DELETE",
    });
}

export { listComments, createComment, deleteMyComment };

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
 * 3. **写评论不带访客标识**。评论强制登录（`note_comment.user_id` 恒 >0），
 *    没有"匿名评论"这回事；带过去只会让服务端多一个不用的头。
 *    ⚠️ **投票是唯一的例外**（20261003 用户第 4 条）：`voteComment` 必须带
 *    `X-Visitor-Key`——票对访客开放（用户已拍板「访客也能点」），少带一个头，
 *    未登录的人就会退化成"没有身份"而被回一句「未登录」。两条接口在同一个文件里
 *    有相反的要求，是因为**评论是内容、投票是互动**，不是前后不一致。
 */
import http from "./axios.tsx";
import { getVisitorKey, VISITOR_HEADER } from "../utils/visitorKey";
import type { Envelope } from "./ProfileMethods";
import type { CommentItem, CommentVote, CreateCommentResult } from "../interface/CommentType";

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

/** 给一条评论投赞/踩，或撤回（20261003 用户第 4 条「讨论区评论增加点赞和踩」）。
 *
 *  · `value = 1` 赞 / `-1` 踩 / **`0` 撤回**（再点一次已经点亮的那一侧）。一个端点
 *    装三种动作，调用方不必记三条 URL，也不必把"取消"写成 DELETE（那会与"删评论"
 *    在同一个资源路径上撞语义）。
 *  · **必须带访客标识**，理由见本文件头注第 3 条的那个例外。
 *  · 回执是**服务端算好的** `{up, down, myVote}`（不是"你这次投了什么"）——
 *    并发下别人也可能在同一秒投，本地自增的账必然对不上。前端拿它覆盖乐观值。 */
function voteComment(id: number, value: -1 | 0 | 1) {
    return http<Envelope<CommentVote>>({
        url: `/api/public/comments/${id}/vote`,
        method: "POST",
        data: { value },
        headers: { [VISITOR_HEADER]: getVisitorKey() },
    });
}

export { listComments, createComment, deleteMyComment, voteComment };

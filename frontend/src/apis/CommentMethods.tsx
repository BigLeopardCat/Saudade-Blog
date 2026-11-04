import http from "./axios.tsx";
import { getVisitorKey, VISITOR_HEADER } from "../utils/visitorKey";
import type { Envelope } from "./ProfileMethods";
import type {
    CommentItem,
    CommentSort,
    CommentVote,
    CreateCommentResult,
} from "../interface/CommentType";

/** 某篇文章的全部公开评论（顶层 + 回复，扁平数组，前端按 rootId 分组）。
 *  只含已通过审核的：待审/未通过/已删除的评论在公开侧**不存在**。
 *
 *  `sort`：`'hot'`（缺省）/ `'new'`。**只影响顶层评论的顺序**，回复恒按时间升序
 *  （讨论串内部打乱就没法读了）。服务端对**未知值一律当 `hot`**（见 `comments.rs` 的
 *  `CommentListQuery`），所以这里传错值不会 400，只会静默回落——别把"没报错"当"生效了"。 */
function listComments(noteId: number | string, sort: CommentSort) {
    return http<Envelope<CommentItem[]>>({
        url: `/api/public/notes/${noteId}/comments`,
        method: "GET",
        params: { sort },
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

function voteComment(id: number, value: -1 | 0 | 1) {
    return http<Envelope<CommentVote>>({
        url: `/api/public/comments/${id}/vote`,
        method: "POST",
        data: { value },
        headers: { [VISITOR_HEADER]: getVisitorKey() },
    });
}

export { listComments, createComment, deleteMyComment, voteComment };

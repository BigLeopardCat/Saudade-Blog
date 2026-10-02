/** 文章评论（20261002）。后端 DTO 见 `src/routes/comments.rs::CommentDto`，
 *  字段名一一对应（后端 serde camelCase）——**不要在这里另起一套名字**，
 *  名字对不上时 tsc 不会报错，只会在运行时读到 undefined。 */
export interface CommentItem {
    id: number;
    noteId: number;
    /** 原文。**不转义存储**（XSS 防线在渲染侧的 markdown 管线，见 CommentSection 头注） */
    content: string;
    /** 直接父评论 id；null = 顶层 */
    parentId: number | null;
    /** 顶层评论 id；**null = 本行就是顶层**（前端据此分组） */
    rootId: number | null;
    replyToUid: number | null;
    /** 被回复者的展示名；null = 顶层，或对方账号已销（此时显示「已注销用户」） */
    replyToNickname: string | null;
    userId: number;
    /** 作者的展示名（昵称优先、没设昵称退回账号） */
    nickname: string;
    avatar: string | null;
    /** 角色名（权限徽章用）。取值域见 `utils/auth.ts::ROLE_LABEL` */
    role: string;
    /** 是否当前登录用户所发（删按钮的门控）。未登录恒 false */
    mine: boolean;
    /** 本地钟面字符串（+08:00），后端已格式化好，前端别再 new Date() 解释一遍 */
    createdAt: string;
}

/** 发评论的结果（`POST /api/public/notes/:id/comments`）。
 *
 *  `approved` 决定提示语，**三种取值说三种话**：1=已公开 / 0=等人工复核 /
 *  2=未通过。绝不把 0 和 2 混成一句"提交成功"——那是替审核下结论。 */
export interface CreateCommentResult {
    id: number;
    approved: number;
}

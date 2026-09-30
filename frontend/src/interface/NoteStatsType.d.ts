/** 文章阅读量 / 点赞量（20260930）。字段名与 `src/routes/note_stats.rs` 的 DTO 一一对应
 *  —— 那边是 `snake_case` 加 `#[serde(rename)]`，这里用后端吐出来的键名。 */

/** 单篇统计（`GET /api/public/notes/:id/stats` 与 `POST .../view` 的返回） */
export interface NoteStats {
    /** 累计阅读数。**读不到时是 undefined 而不是 0** —— 见 apis/NoteStatsMethods.tsx 头注 */
    views: number;
    likes: number;
    /** 当前访客点过赞没有。未登录恒 false（不是错误） */
    liked: boolean;
}

/** 点赞/取消点赞的返回（只有这两个数，不重发 views） */
export interface LikeState {
    likes: number;
    liked: boolean;
}

/** 排行榜一行 */
export interface NoteRankRow {
    noteId: number;
    title: string;
    views: number;
    likes: number;
}

/** 趋势一天 */
export interface DailyRow {
    date: string;
    views: number;
    likes: number;
}

/** 后台文章报表（`GET /api/protected/stats/notes`） */
export interface NoteStatsReport {
    generatedAt: string;
    totalViews: number;
    totalLikes: number;
    topViewed: NoteRankRow[];
    topLiked: NoteRankRow[];
    /** 最近 30 天，**已补零**、日期连续（后端展开） */
    daily: DailyRow[];
}

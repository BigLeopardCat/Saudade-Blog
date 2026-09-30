/** 文章阅读量 / 点赞量 / 收藏量（20260930）。字段名与 `src/routes/note_stats.rs` 的 DTO 一一对应
 *  —— 那边是 `snake_case` 加 `#[serde(rename)]`，这里用后端吐出来的键名。 */

/** 单篇统计（`GET /api/public/notes/:id/stats` 与 `POST .../view` 的返回） */
export interface NoteStats {
    /** 累计阅读数。**读不到时是 undefined 而不是 0** —— 见 apis/NoteStatsMethods.tsx 头注 */
    views: number;
    likes: number;
    /** 累计收藏数（20260930 补）。是**计数**，不是"我收藏了没有"——后者按 uid 存在
     *  个人中心的收藏列表里（单篇读接口没有身份可依赖，那不是它该答的问题）。
     *  **可空只表示"这一版前端还没消费它"**：后端一定会回这个键（`views`/`likes`
     *  那两个非可空的字段同理，别把可空读成"可能没有"）。 */
    favorites?: number;
    /** 当前访客点过赞没有。未登录恒 false（不是错误） */
    liked: boolean;
}

/** 点赞/取消点赞的返回（只有这两个数，不重发 views） */
export interface LikeState {
    likes: number;
    liked: boolean;
}

/** 排行榜一行。三个数都在（榜按其中一个排，`rankPanel` 的 `metric` 决定条宽取哪个），
 *  **注意两个榜的序号可以指向不同的文章**——说"第 N 名"时要带上榜名。 */
export interface NoteRankRow {
    noteId: number;
    title: string;
    views: number;
    likes: number;
    /** 后端每一行都会带（三个榜共用一套行），本页只用 `views`/`likes` 两个 */
    favorites?: number;
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
    /** 收藏量合计与收藏榜（20260930 补）：**后端已回、本页暂不渲染**——文章数据页
     *  按当时的拍板只做阅读量/点赞量两榜。消费方目前是看板娘的文章流量报表。 */
    totalFavorites?: number;
    topFavorited?: NoteRankRow[];
    /** 三个榜**数组顺序即名次**（下标 0 = 第 1 名），没有单独的 rank 字段 */
    topViewed: NoteRankRow[];
    topLiked: NoteRankRow[];
    /** 最近 30 天，**已补零**、日期连续（后端展开） */
    daily: DailyRow[];
}

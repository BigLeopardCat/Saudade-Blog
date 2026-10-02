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
    /** 累计讨论数（20261003 补）。口径 = **公开讨论区看得见的那些**
     *  （`approved = 1 AND is_deleted = 0`）——所以详情页胶囊上的数一定等于
     *  点进去数出来的条数。可空只表示"老前端还没消费它"，后端一定会回这个键。 */
    comments?: number;
    /** 当前访客点过赞没有。未登录恒 false（不是错误） */
    liked: boolean;
}

/** 点赞/取消点赞的返回（只有这两个数，不重发 views） */
export interface LikeState {
    likes: number;
    liked: boolean;
}

/** 排行榜一行。四个数都在（榜按其中一个排，`rankPanel` 的 `metric` 决定条宽取哪个），
 *  **注意两个榜的序号可以指向不同的文章**——说"第 N 名"时要带上榜名。 */
export interface NoteRankRow {
    noteId: number;
    title: string;
    views: number;
    likes: number;
    /** 后端每一行都会带（四个榜共用一套行），本页只用其中一个画条宽 */
    favorites?: number;
    /** 讨论数（20261003 补）。口径 = 公开看得见的那些，与文章卡片上的数同源 */
    comments?: number;
}

/** 趋势一天 */
export interface DailyRow {
    date: string;
    views: number;
    likes: number;
    /** 20261001 补：三个汇总数、三个榜都全了，趋势只画两条线读的人会问"收藏呢"。
     *  与 `likes` 同源（`user_favorite.created_at` 的日期分桶）。 */
    favorites?: number;
    /** 讨论量的日趋势（20261003 补，`note_comment.created_at` 的日期分桶，
     *  且只算公开看得见的那些）。 */
    comments?: number;
}

/** 后台文章报表（`GET /api/protected/stats/notes`） */
export interface NoteStatsReport {
    generatedAt: string;
    totalViews: number;
    totalLikes: number;
    /** 收藏量合计与收藏榜（20260930 后端已回；20261001 起本页三榜齐上）。
     *  可空只表示"老前端还没消费它"，后端一定会回这两个键。 */
    totalFavorites?: number;
    topFavorited?: NoteRankRow[];
    /** 讨论量合计与讨论榜（20261003 补）。与卡片/详情页同一个口径：
     *  只算**公开看得见**的评论（`approved = 1 AND is_deleted = 0`）。 */
    totalComments?: number;
    topCommented?: NoteRankRow[];
    /** 四个榜**数组顺序即名次**（下标 0 = 第 1 名），没有单独的 rank 字段 */
    topViewed: NoteRankRow[];
    topLiked: NoteRankRow[];
    /** 最近 30 天，**已补零**、日期连续（后端展开） */
    daily: DailyRow[];
}

/** 期报粒度（`?kind=`）。**白名单**，别处不要再写一份字符串字面量 */
export type PeriodKind = 'week' | 'month' | 'year';

/** 期报里的一期（`GET /api/protected/stats/notes/periods`）。 */
export interface PeriodRow {
    /** `2026-W40` / `2026-10` / `2026` */
    key: string;
    /** 人眼读的标题（`2026 年第 40 周` / `2026 年 10 月` / `2026 年`） */
    label: string;
    /** 期界，闭区间，`YYYY-MM-DD` */
    start: string;
    end: string;
    /** **本期不是整期统计**：起始日早于 `since`（统计功能上线那天）。
     *  界面必须把这类期的数字标出来——否则"上线那一周只有两天数据"会被读成
     *  "那周流量掉了"。这是后端 `partial` 键的原样透传。 */
    partial: boolean;
    views: number;
    likes: number;
    favorites: number;
    /** 本期讨论量（20261003 补），口径同全局：只算公开看得见的评论 */
    comments: number;
    /** 本期阅读量前 5。四个数都带，按 `views` 排——名次是**期内**的，与全局榜无关 */
    topNotes: NoteRankRow[];
}

/** 分期报表（`GET /api/protected/stats/notes/periods?kind=&limit=`） */
export interface PeriodReport {
    generatedAt: string;
    /** 回显粒度（切档后要对得上，别拿本地 state 当真相） */
    kind: PeriodKind;
    /** 最早有统计记录的一天；`null` = 一行记录都还没有（**不是** "统计了但都是 0"） */
    since: string | null;
    /** 期列表，**倒序**（最新在前）。期界早于 `since` 的整期已被后端剔除，
     *  所以这个数组可能比请求的 `limit` 短——**短不等于出错**。 */
    periods: PeriodRow[];
}

/** 用户侧活跃度（`GET /api/protected/stats/users`） */
export interface UserActivityRow {
    id: number;
    /** 展示名（后端 `display_name` 产出，**不是** username） */
    name: string;
    role: string;
    conversations: number;
    messages: number;
    /** 该账号发过的讨论数（20261003 补）。**注意它和文章报表里那个「讨论数」口径不同**：
     *  这里只排除软删（待审/驳回的也算——这一页问的是"这个账号做过什么"），
     *  文章报表那边是 `approved = 1`（只算公开看得见的）。两处各自与自己那一页的邻居对齐：
     *  本页的会话数/消息数同样是全量的。 */
    comments: number;
    /** `YYYY-MM-DD HH:MM` 本地钟面；**null = 该用户既无会话/消息，也没发过讨论** */
    lastActiveAt: string | null;
}

export interface RoleCount {
    role: string;
    count: number;
}

export interface UserStatsReport {
    generatedAt: string;
    roleCounts: RoleCount[];
    totalUsers: number;
    totalConversations: number;
    totalMessages: number;
    totalExecutions: number;
    /** 全站讨论总量（20261003 补）。口径见 `UserActivityRow.comments` */
    totalComments?: number;
    /** 活跃 = 最近一条会话/消息/讨论落在窗口内 */
    activeUsers7d: number;
    activeUsers30d: number;
    /** 有活动、进入 `users[]` 的人数（≤ 后端上限）——**不是**用户总数 */
    listedUsers: number;
    users: UserActivityRow[];
}

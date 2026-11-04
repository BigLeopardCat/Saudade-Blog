/** 单篇统计（`GET /api/public/notes/:id/stats` 与 `POST .../view` 的返回） */
export interface NoteStats {
    /** 累计阅读数。**读不到时是 undefined 而不是 0** —— 见 apis/NoteStatsMethods.tsx 头注 */
    views: number;
    likes: number;
    favorites?: number;
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
    comments?: number;
}

/** 趋势一天 */
export interface DailyRow {
    date: string;
    views: number;
    likes: number;
    favorites?: number;
    comments?: number;
}

/** 后台文章报表（`GET /api/protected/stats/notes`） */
export interface NoteStatsReport {
    generatedAt: string;
    totalViews: number;
    totalLikes: number;
    /** 当前可见文章的收藏量及对应榜单。 */
    totalFavorites: number;
    topFavorited: NoteRankRow[];
    /** 讨论量与讨论榜，使用文章详情页的公开评论口径：
     *  只算**公开看得见**的评论（`approved = 1 AND is_deleted = 0`）。 */
    totalComments: number;
    topCommented: NoteRankRow[];
    /** 四个榜**数组顺序即名次**（下标 0 = 第 1 名），没有单独的 rank 字段 */
    topViewed: NoteRankRow[];
    topLiked: NoteRankRow[];
    /** 最近 30 天，**已补零**、日期连续（后端展开） */
    daily: DailyRow[];
    /** 服务端统计窗口；月份小计仅覆盖该窗口，不代表自然月全量。 */
    dailyWindow: {
        scope: "rolling_window";
        start: string;
        end: string;
        monthlySubtotals: Array<{
            month: string; start: string; end: string;
            views: number; likes: number; favorites: number; comments: number;
        }>;
    };
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
    totalComments: number;
    /** 活跃 = 最近一条会话/消息/讨论落在窗口内 */
    activeUsers7d: number;
    activeUsers30d: number;
    /** 有活动、进入 `users[]` 的人数（≤ 后端上限）——**不是**用户总数 */
    listedUsers: number;
    users: UserActivityRow[];
}

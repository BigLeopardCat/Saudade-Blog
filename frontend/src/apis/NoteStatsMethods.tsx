import http from "./axios.tsx";
import { getVisitorKey, VISITOR_HEADER } from "../utils/visitorKey";
import type { Envelope } from "./ProfileMethods";
import type {
    LikeState,
    NoteStats,
    NoteStatsReport,
    PeriodKind,
    PeriodReport,
    UserStatsReport,
} from "../interface/NoteStatsType";

/** 本系列四个接口统一的身份头。**每次现取**（不是模块加载时取一次）：
 *  隐私模式下 `localStorage` 会抛，取的那一下自己会兜底；而"取一次存起来"
 *  会让排障时改 localStorage 看不到变化。 */
const visitorHeader = () => ({ [VISITOR_HEADER]: getVisitorKey() });

/** 单篇统计（公开，不需要登录）。带上标识 ⇒ 匿名访客也能拿到自己的 `liked`。 */
function getNoteStats(id: number | string, signal?: AbortSignal) {
    return http<Envelope<NoteStats>>({
        url: `/api/public/notes/${id}/stats`,
        signal,
        method: "GET",
        headers: visitorHeader(),
    });
}

/** 上报一次阅读（公开）。后端按天 upsert +1，**重复调用会重复计数**——
 *  同一访客同一天只上报一次的去重在前端（见 ReadArticle 的 `saudadeReadLog`），
 *  服务端收到访客标识也不据此去重（那会把"打开次数"改成"访客数"，是另一个口径）。 */
function reportNoteView(id: number | string) {
    return http<Envelope<NoteStats>>({
        url: `/api/public/notes/${id}/view`,
        method: "POST",
        headers: visitorHeader(),
    });
}

function likeNote(id: number | string) {
    return http<Envelope<LikeState>>({
        url: `/api/public/notes/${id}/like`,
        method: "POST",
        headers: visitorHeader(),
    });
}

/** 取消点赞（同上）。幂等：没点过也是成功 */
function unlikeNote(id: number | string) {
    return http<Envelope<LikeState>>({
        url: `/api/public/notes/${id}/like`,
        method: "DELETE",
        headers: visitorHeader(),
    });
}

/** 后台报表（管理员）。挂守卫域，无 token 是 401 —— 由路由守卫挡在前面 */
function getNoteStatsReport() {
    return http<Envelope<NoteStatsReport>>({
        url: "/api/protected/stats/notes",
        method: "GET",
    });
}

/** 周报/月报/年报（管理员）。同一守卫域，同上。
 *
 *  `kind` 与 `limit` 都**由调用方显式给**：后端有默认值，但把默认值复制到前端
 *  就成了第二份真相源（两处不一致时页面会"少一期"且看不出来）。 */
function getNotePeriodReport(kind: PeriodKind, limit: number) {
    return http<Envelope<PeriodReport>>({
        url: "/api/protected/stats/notes/periods",
        method: "GET",
        params: { kind, limit },
    });
}

/** 用户侧活跃度（管理员）。`stats.rs::user_stats`，**看板娘的用户报表读的是同一条**
 *  ——本页只是它的第一个后台消费方，别在这里加"页面专用"的加工。 */
function getUserStatsReport() {
    return http<Envelope<UserStatsReport>>({
        url: "/api/protected/stats/users",
        method: "GET",
    });
}

export {
    getNoteStats,
    reportNoteView,
    likeNote,
    unlikeNote,
    getNoteStatsReport,
    getNotePeriodReport,
    getUserStatsReport,
};

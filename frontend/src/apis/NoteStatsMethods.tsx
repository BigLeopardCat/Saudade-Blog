/**
 * 文章阅读量 / 点赞量接口层（20260930）。后端见 `src/routes/note_stats.rs`。
 *
 * 三个口径上的坑写在这里，改动时别踩回去：
 *
 * 1. **成功判据是 `code === 200`，不是 HTTP 状态码**。这族写接口（点赞）挂
 *    `public_routes` + handler 自身鉴权，失败返回的是 HTTP 200 + `code=500`
 *    「未登录 / 账号已被冻结」——只判 `res.status` 会把失败当成"点赞成功"。
 *    沿用 `ProfileMethods.tsx` 的 `ok()` / `errMsg()`，不在这里另写一套。
 * 2. **读接口对未登录是成功的**。访客照样拿得到 `{views,likes,liked:false}`——
 *    "无 token"在 stats/view 上不是错误分支，别在这里提前拦一道。
 * 3. **阅读上报失败静默**。它是个副作用，不该把读者的页面变成错误提示；
 *    调用方（ReadArticle）自己决定要不要提示，本层只把结果原样带着。
 * 4. **四个调用都要带访客标识**（20261001 起）。后端按它给匿名访客去重、
 *    也算得出"这位访客点过没有"；少带一个，那一支就会退化成"没有身份"
 *    （点赞被拒、或 `liked` 恒 false）。标识本身见 `utils/visitorKey.ts`。
 *    刻意**不做成全局请求头**：只有这族接口用得上它，没必要让它出现在
 *    每一次无关请求里（那等于给自己加了一个站内通行证）。
 */
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
function getNoteStats(id: number | string) {
    return http<Envelope<NoteStats>>({
        url: `/api/public/notes/${id}/stats`,
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

/** 点赞（登录或匿名都可，20261001 起）。幂等：已点过再点也是成功 */
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

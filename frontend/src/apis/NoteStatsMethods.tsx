/**
 * 文章阅读量 / 点赞量接口层（20260930）。后端见 `src/routes/note_stats.rs`。
 *
 * 三个口径上的坑写在这里，改动时别踩回去：
 *
 * 1. **成功判据是 `code === 200`，不是 HTTP 状态码**。这族写接口（点赞）挂
 *    `public_routes` + handler 自身鉴权，未登录返回的是 HTTP 200 + `code=500`
 *    「未登录」——只判 `res.status` 会把"没登录"当成"点赞成功"。
 *    沿用 `ProfileMethods.tsx` 的 `ok()` / `errMsg()`，不在这里另写一套。
 * 2. **读接口对未登录是成功的**。访客照样拿得到 `{views,likes,liked:false}`——
 *    "无 token"在 stats/view 上不是错误分支，别在这里提前拦一道。
 * 3. **阅读上报失败静默**。它是个副作用，不该把读者的页面变成错误提示；
 *    调用方（ReadArticle）自己决定要不要提示，本层只把结果原样带着。
 */
import http from "./axios.tsx";
import type { Envelope } from "./ProfileMethods";
import type { LikeState, NoteStats, NoteStatsReport } from "../interface/NoteStatsType";

/** 单篇统计（公开，不需要登录） */
function getNoteStats(id: number | string) {
    return http<Envelope<NoteStats>>({
        url: `/api/public/notes/${id}/stats`,
        method: "GET",
    });
}

/** 上报一次阅读（公开）。后端按天 upsert +1，**重复调用会重复计数**——
 *  同一访客同一天只上报一次的去重在前端（见 ReadArticle 的 `saudadeReadLog`），
 *  服务端没有身份可依赖（访客没有 uid）也就不做去重。 */
function reportNoteView(id: number | string) {
    return http<Envelope<NoteStats>>({
        url: `/api/public/notes/${id}/view`,
        method: "POST",
    });
}

/** 点赞（需登录）。幂等：已点过再点也是成功 */
function likeNote(id: number | string) {
    return http<Envelope<LikeState>>({
        url: `/api/public/notes/${id}/like`,
        method: "POST",
    });
}

/** 取消点赞（需登录）。幂等：没点过也是成功 */
function unlikeNote(id: number | string) {
    return http<Envelope<LikeState>>({
        url: `/api/public/notes/${id}/like`,
        method: "DELETE",
    });
}

/** 后台报表（管理员）。挂守卫域，无 token 是 401 —— 由路由守卫挡在前面 */
function getNoteStatsReport() {
    return http<Envelope<NoteStatsReport>>({
        url: "/api/protected/stats/notes",
        method: "GET",
    });
}

export { getNoteStats, reportNoteView, likeNote, unlikeNote, getNoteStatsReport };

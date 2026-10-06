import http from "./axios.tsx";
import type {AggregateResult} from "../frontHome/Head/aggregate";

/** 站内**聚合搜索**（20261006）：一次搜文章 / 说说 / 留言 / 评论。
 *
 *  ⚠️ 与 `NoteMethods.searchNotes`（只搜文章）**并存**，不是替代关系：分类页
 *  （`frontHome/Content/Categories`）与后台仍在用那一个，后端 `/api/public/notes/search`
 *  还同时是 agent 的 `search_notes` 工具。首页那个搜索框改用本函数。
 *
 *  `keyword` 缺席 / 空白时后端回**空结果**（不是整个列表），所以调用方不必自己挡。 */
function searchAll(data: {keyword?: string}){
    return http({
        url: '/api/public/search',
        method: 'POST',
        data: data
    })
}

/** 只给类型用：`res.data.data` 的形状（axios 那条链是 any，这里手动标一下）。
 *  **不影响运行时**，纯粹是让 `agg` 那个 state 有类型可依。 */
export type {AggregateResult}
export {searchAll}

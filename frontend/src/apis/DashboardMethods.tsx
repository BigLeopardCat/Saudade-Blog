/**
 * 后台首页待办接口层（20260924）。
 *
 * 两个接口一张表：GET 读整份、PUT 覆盖整份（取舍见 src/routes/todos.rs 头注）。
 * 失败口径沿用个人中心那一族：HTTP 200 + `code=500` + 中文 message（无 token 也一样）
 * ——判成功必须看 `code === 200`，所以这里复用 apis/ProfileMethods.tsx 的 ok/errMsg。
 *
 * 三条纪律（调用点在 pages/Dashboard/Home/index.tsx，写错会**静默清空**主人的待办）：
 *   1. **列表没读出来之前绝不出网**：PUT 的是整份列表，空数组的含义就是"清空"；
 *   2. **每次改动都发整份**（不做行级 diff，服务端也不认行 id）⇒ 请求要防抖，
 *      免得打一个字发一次；
 *   3. **失败要让人看见**：PUT 失败不重试、也不回滚本地编辑（主人刚敲的字不该被
 *      悄悄撤掉），提示一句，下一次改动会把整份重新发上去（自愈）。
 */
import http from "./axios.tsx";
import {errMsg, ok, type Envelope} from "./ProfileMethods.tsx";
import type {DashboardTodo} from "../interface/DashboardType";

export {errMsg, ok};

/** GET /api/protected/todos：我的整份待办（按位次，服务端已排好） */
export function getTodos() {
    return http<Envelope<DashboardTodo[]>>({
        url: "/api/protected/todos",
        method: "GET",
    });
}

/** PUT /api/protected/todos：整份覆盖。成功时服务端回读一次，返回库里此刻的样子 */
export function saveTodos(todos: DashboardTodo[]) {
    return http<Envelope<DashboardTodo[]>>({
        url: "/api/protected/todos",
        method: "PUT",
        data: {todos},
    });
}

/** 留言管理列表里的一条（GET /api/protect/board，与 backend BoardAdminDto 同源） */
export interface BoardRow {
    talkKey: number;
    content: string;
    author: string;
    /** 人工审核：1=通过 / 0=待审 / 2=未通过 */
    approved: number;
    aiResult?: string | null;
    [k: string]: unknown;
}

/** GET /api/protect/board：全部河灯留言（倒序）。
 *  后台首页只用它数 `approved === 0` 的那几条（等人工裁决的），**没有**单独的计数接口；
 *  数据量是"留言总数"级别，一次拉全再数比加一个只为提醒用的后端接口划算。 */
export function listBoardRows() {
    return http<Envelope<BoardRow[]>>({
        url: "/api/protect/board",
        method: "GET",
    });
}

/**
 * 后台首页待办接口层（20260924）。
 *
 * 前台这两个接口是一张表：GET 读整份、PUT 覆盖整份（取舍见 src/routes/todos.rs 头注）。
 * 失败口径沿用个人中心那一族：HTTP 200 + `code=500` + 中文 message（无 token 也一样）
 * ——判成功必须看 `code === 200`，所以这里复用 apis/ProfileMethods.tsx 的 ok/errMsg。
 *
 * ⚠️ 服务端还有**第三条**通道 `POST /api/protected/todos/item`（追加一条，20260926）：
 * 那是给 **agent** 用的，这一层**刻意不封装**它——前端这份列表是整份读写的，页面上
 * 没有任何一处需要"只加一条而不动其余"；包出来只会诱使以后有人拿它绕开整份覆盖的语义
 * （那套语义与这份界面是配套的：位次由本地数组决定）。但反过来，**这一层必须知道它在**：
 * agent 加的条目会出现在 GET 的返回里，而本地那份不知道 ⇒ 下一次 PUT 会把那条抹掉。
 * 收尾那一下的重读与合并写在调用点（pages/Dashboard/Home/index.tsx），见那里的注释。
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

/**
 * PUT /api/protected/todos：整份覆盖。成功时服务端回读一次，返回库里此刻的样子。
 *
 * ★ 调用方注意：**这份 payload 就是库里的全部**——本地列表里没有的行会真的被删掉。
 * agent 可能刚用追加通道写过一条（见文件头注），所以"本地还有没落库的改动、且知道
 * agent 刚写过"时，发之前要先 GET 一次把 agent 那几条并进来。
 */
export function saveTodos(todos: DashboardTodo[]) {
    return http<Envelope<DashboardTodo[]>>({
        url: "/api/protected/todos",
        method: "PUT",
        data: {todos},
    });
}


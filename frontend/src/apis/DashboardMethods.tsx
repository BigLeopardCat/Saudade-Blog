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


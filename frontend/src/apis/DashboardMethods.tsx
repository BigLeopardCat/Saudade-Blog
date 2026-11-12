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

/** 整份覆盖待办，缺失项会被删除；提交前须合并其他写入渠道的最新结果。 */
export function saveTodos(todos: DashboardTodo[]) {
    return http<Envelope<DashboardTodo[]>>({
        url: "/api/protected/todos",
        method: "PUT",
        data: {todos},
    });
}


/**
 * 后台首页待办（20260924）后端 DTO 的前端类型。
 * 字段名与 Rust 侧 serde 的线上口径一致（`text` / `done` / `date`），
 * **不带服务端 id**——这份列表的顺序与身份都由前端拥有，服务端只存"此刻的这份列表"
 * （取舍见 scripts/migration/dashboard_todo_20260924.sql 头注）。
 *
 * `POST /api/protected/todos/item`（追加一条，20260926，给 agent 用）的请求体
 * **刻意没有对应的前端类型**：那份请求体只比这一行少一个 `done`，而前端不调它
 * （理由见 apis/DashboardMethods.tsx 头注）——为一条没人调的接口先摆一个类型出来，
 * 下一个人就会以为这一层该有它的封装。
 */

/** GET / PUT /api/protected/todos 的单行 */
export interface DashboardTodo {
    text: string;
    done: boolean;
    /** 排期那天 `YYYY-MM-DD`；null / 缺省 = 未排期 */
    date?: string | null;
}

/** PUT /api/protected/todos 的请求体：整份列表 */
export interface SaveTodoPayload {
    todos: DashboardTodo[];
}

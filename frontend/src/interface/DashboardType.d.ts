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

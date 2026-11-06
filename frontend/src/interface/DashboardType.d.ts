/** GET / PUT /api/protected/todos 的单行 */
export interface DashboardTodo {
    text: string;
    done: boolean;
    date?: string | null;
}

/** PUT /api/protected/todos 的请求体：整份列表 */
export interface SaveTodoPayload {
    todos: DashboardTodo[];
}

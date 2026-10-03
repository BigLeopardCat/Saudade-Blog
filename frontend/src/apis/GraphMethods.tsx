/**
 * 向量图谱重建接口层（20261003 用户第 2 条）。
 *
 * 链路：本模块 → Rust `/api/protected/graph/*`（auth_guard 已保证只有管理员）
 *      → 以发起人身份现签断言 → agent `8010/graph/rebuild*`。
 *
 * 三个口径，改动时别踩：
 *
 * 1. **失败分两类**。「这台机器此刻不行」走 HTTP 200 + `code=500` + 中文 message
 *    （busy / low_memory / uv_missing / bad_params，各自要不同的处置建议）；
 *    「这个人不行」走 HTTP 403（agent 侧 `_require_console`）。所以判断成功一律
 *    用 `ok(res)`——只判 `res.status === 200` 会把"内存不够"当成功。
 * 2. **本层不弹提示**。同一个失败在表单里要留在原地、在轮询里只该记一行，
 *    措辞由调用方决定（同 ProfileMethods 的纪律）。
 * 3. **超时**。axios 那条 15s（axios.tsx）对这三个端点都够：起任务是非阻塞的
 *    （起完立刻返回，进度靠轮询），取消最多等 CANCEL_GRACE=5s 就返回。
 */
import http from "./axios.tsx";
import type { Envelope } from "./ProfileMethods";
import type {
    GraphBuildCancel,
    GraphBuildParams,
    GraphBuildStart,
    GraphBuildState,
} from "../interface/GraphType";

// 复用 ProfileMethods 那份信封与判据（**别在这里另写一份**：那族接口的
// "失败也是 HTTP 200"口径是同一个后端约定，抄一遍就会各漂各的）
export { ok, errMsg } from "./ProfileMethods";

/** 起一次任务（`rebuild` 真建图 / `precheck` 只验依赖）。非阻塞。 */
function startGraphRebuild(params: GraphBuildParams) {
    return http<Envelope<GraphBuildStart>>({
        url: "/api/protected/graph/rebuild",
        method: "POST",
        data: params,
    });
}

/** 查当前任务状态（含日志尾部）。页面在运行中按 ~1.5s 轮它。 */
function getGraphRebuildStatus() {
    return http<Envelope<GraphBuildState>>({
        url: "/api/protected/graph/rebuild/status",
        method: "GET",
    });
}

/** 取消当前任务（SIGTERM 整个进程组 → 宽限期内没退再 SIGKILL）。 */
function cancelGraphRebuild() {
    return http<Envelope<GraphBuildCancel>>({
        url: "/api/protected/graph/rebuild/cancel",
        method: "POST",
        data: {},
    });
}

export { startGraphRebuild, getGraphRebuildStatus, cancelGraphRebuild };
// `Envelope` 由 ProfileMethods 定义、这里原样转出：调用方（页面）不必为了写类型
// 再从两个模块各 import 一次。
export type { Envelope };
export type { GraphBuildParams, GraphBuildState, GraphBuildStart, GraphBuildCancel };

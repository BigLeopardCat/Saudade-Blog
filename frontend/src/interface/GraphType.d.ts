/** 向量图谱重建（20261003 用户第 2 条）。字段的真源在 **agent 仓**
 *  `rag/graph_build.py`（`start` / `status` / `cancel` / `_collect_result`），Rust
 *  （`src/routes/graph.rs` 的 `rebuild_*`）只把 agent 的应答原样塞进 `ApiResponse.data`。
 *  **改一处要改三处**。 */

/** 一次任务的参数。键名与 agent 侧 `resolve_params` 的**白名单**一一对应——
 *  多传的字段会被丢掉（表单是外部输入，不会直接拼进 argv）。 */
export interface GraphBuildParams {
    /** `rebuild` = 真建图；`precheck` = 只验依赖装不装得起来（首次要下 ~470MB） */
    mode: 'rebuild' | 'precheck';
    /** 语料来源。留空 = 用 agent 的默认（本机回环直连 Rust 的公开接口） */
    api_base?: string;
    /** 产物归属站点。前台 `loader.ts::siteMatches` 拿它跟浏览器 origin 比，
     *  不一致就显示「尚未为本站点生成」。**留空 = 谁都能显示**（老产物的兼容语义）。 */
    site?: string;
    max_nodes?: number;
    min_chars?: number;
    /** 三态：**不传键**＝用脚本自带的默认排除；`''`＝一个都不排除；`'9,10'`＝只排除这两篇。
     *  三态是有意的（20261003 修的静默 bug 就在这：旧的 `or` 让空串也永远排除默认那几篇）。 */
    exclude_ids?: string;
    layout?: 'umap' | 'semantic' | 'pca';
    /** 强制重嵌全部词——**真花钱**，页面上要写明 */
    refresh?: boolean;
    /** 质量门不过也出产物（否则参数不合适时会死在死胡同里） */
    force?: boolean;
    /** 只试跑：不算 embedding、不写产物 */
    dry_run?: boolean;
}

/** 状态机的字面量。`idle` = 没跑过；`ok`/`failed`/`cancelled` = 正常收尾的终态；
 *  `interrupted` = 属主进程没了（部署/OOM 重启），**不是任何人的终态**，页面据此
 *  允许直接重新开始（不需要用户去删锁文件）。 */
export type GraphBuildStatus =
    | 'idle' | 'running' | 'ok' | 'failed' | 'cancelled' | 'interrupted';

/** 成功后的摘要。读的是**产物自己写的账**（脚本落的 index.json / manifest.json）。 */
export interface GraphBuildResult {
    elapsed?: number;
    build_id?: string;
    nodes?: number;
    dim?: number;
    file?: string;
    bytes?: number;
    site?: string;
    built?: string;
    /** 这次真新增的 embedding 条数。**null/缺席都不是 0**：`--dry-run` 根本没调，
     *  与"调了但全命中缓存（0/0）"是两件事——页面必须分开说。 */
    embed_new?: number | null;
    embed_hit?: number | null;
    /** 本 worker 是否已换上刚出的产物（其余 worker 下次查询时按 build_id 热重载） */
    reload_local?: boolean;
    reload_error?: string;
    /** 退出码 0 但产物摘要缺字段时由 agent 写的告警——**不能因为退出码 0 就说成功** */
    warn?: string;
    /** precheck 的返回：依赖装得起来 */
    deps_ready?: boolean;
}

/** `GET /graph/rebuild/status` 的 data（= agent `status()` 的原样） */
export interface GraphBuildState {
    status: GraphBuildStatus;
    /** 仅 `status === 'interrupted'` 时有：`owner_gone`（属主进程没了）/
     *  `lock_gone`（锁没了却写着 running）。 */
    stale_reason?: string;
    mode?: 'rebuild' | 'precheck';
    run_id?: string;
    owner_pid?: number;
    owner_alive?: boolean;
    child_pid?: number;
    child_alive?: boolean;
    started_at?: string;
    ended_at?: string | null;
    elapsed?: number;
    exit_code?: number | null;
    params?: GraphBuildParams;
    /** 完整 argv（页面折叠展示，用来核对"我填的参到底传下去没有"） */
    argv?: string[];
    /** 完整日志文件路径（页面只给尾部 400 行，剩余在这） */
    log?: string;
    /** 日志尾部（最多 400 行） */
    tail?: string[];
    result?: GraphBuildResult | null;
    error?: string | null;
    cancel_requested?: boolean;
    mem_available_mb?: number | null;
    /** 起任务的内存闸（低于它 agent 直接拒）——与当前值一起显示才叫"能自己判断" */
    mem_min_mb?: number;
    running?: boolean;
}

/** `POST /graph/rebuild` 的 data（成功时）。被拒时 Rust 走 `ApiResponse.error`
 *  ⇒ data 缺省、原因在 message 里（busy / low_memory / uv_missing 各自要不同的建议，
 *  所以不允许在这里压成一句"操作失败"）。 */
export interface GraphBuildStart {
    ok: boolean;
    started?: boolean;
    run_id?: string;
    state?: GraphBuildState;
}

/** `POST /graph/rebuild/cancel` 的 data。`cancelled: false` 时 `reason` 是给页面分支用的
 *  （目前只有 `not_running`）。 */
export interface GraphBuildCancel {
    cancelled: boolean;
    signal?: 'TERM' | 'KILL';
    reason?: 'not_running';
}

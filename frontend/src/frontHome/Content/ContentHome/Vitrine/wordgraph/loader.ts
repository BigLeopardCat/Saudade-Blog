import type { GraphData } from './types';

/** 带内容 hash 的产物文件名。校验这个形状是有实际意义的：nginx 只对
 *  `-[a-zA-Z0-9_-]{8,}\.(js|…)$` 给 1 年 immutable 缓存，文件名不合规就会掉进
 *  no-store 每次重下（见 docs/word-graph.md）。 */
const FILE_RE = /^graph-[A-Za-z0-9_-]{8,}\.js$/;

let pending: Promise<GraphData> | null = null;
let manifestPending: Promise<GraphManifest | null> | null = null;

/** manifest 的内容。built = 产物生成时间（建图脚本写入，展示柜角标显示它）。 */
export interface GraphManifest {
    v: string;
    file: string;
    bytes: number;
    /** 形如 `2026-09-16T01:31:59+08:00`。老产物可能没有这个字段（可能为 undefined）。 */
    built?: string;
}

/** 读 manifest（模块级缓存，两次调用只发一次请求）。失败返回 null——
 *  角标是装饰性的，读不到就不显示，绝不能让窗口因此报错或空白。
 *  ⚠️ **失败不进缓存**：只在成功时留下缓存，否则一次网络抖动会让展示柜
 *  "这一辈子都画不出来"（`loadGraph` 那条重试路径就白写了）。 */
export function loadManifest(): Promise<GraphManifest | null> {
    if (!manifestPending) {
        manifestPending = fetch('/graph/manifest.json', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((m) => (m && typeof m.file === 'string' ? (m as GraphManifest) : null))
            .catch(() => null)
            .then((m) => { if (!m) manifestPending = null; return m; });
    }
    return manifestPending;
}

/** 懒加载图谱数据。模块级 promise 缓存：多个组件/多次挂载只加载一次。
 *  失败时清空缓存，下次挂载可重试（不把一次网络抖动钉成永久失败）。 */
export function loadGraph(): Promise<GraphData> {
    if (!pending) {
        pending = doLoad().catch((e) => {
            pending = null;
            throw e;
        });
    }
    return pending;
}

async function doLoad(): Promise<GraphData> {
    // manifest 是 no-store（nginx 规则里 .json 不给长缓存），所以每次刷新都会重新
    // 问一次当前该加载哪个 hash —— 重出图不必改前端代码，也不必 bump 版本号。
    const m = await loadManifest();
    if (!m || !FILE_RE.test(m.file)) {
        throw new Error(`manifest 里没有可用的产物文件名: ${m && m.file}`);
    }
    // @vite-ignore：路径含运行时才知道的 hash，Vite 不能静态分析。
    // 该文件是 public/ 下的静态资源，浏览器原生动态导入直接吃它的 URL。
    const mod = await import(/* @vite-ignore */ `/graph/${m.file}`);
    const data = mod.default as GraphData;
    if (!data || !Array.isArray(data.nodes) || !data.nodes.length) {
        throw new Error('产物内容为空');
    }
    return data;
}

/** 仅供测试注入用 */
export function __resetGraphCache() { pending = null; }

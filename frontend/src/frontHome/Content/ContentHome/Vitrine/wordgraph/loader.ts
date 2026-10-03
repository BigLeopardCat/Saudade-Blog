import type { GraphData } from './types';

/** 带内容 hash 的产物文件名。校验这个形状是有实际意义的：产物文件由 Rust 的
 *  `graph_artifact` 按同一条白名单供出（`src/routes/graph.rs::valid_artifact_name`，
 *  `graph-<id>.js`），不合规的名字在那里 404。
 *  20261003 起产物**改由 API 供出**（后台重建 → agent 写自己的目录 → Rust 读它），
 *  静态那份 `public/graph/` 退化为"从没重建过的站点"的种子；两条路文件名同一形状，
 *  所以下面必须记住 manifest 是从哪一条读到的。见 docs/word-graph.md。 */
const FILE_RE = /^graph-[A-Za-z0-9_-]{8,}\.js$/;

/** 产物从哪来。`api` = 后台重建出来的（`/api/public/graph/*`）；`static` = 仓库里
 *  committed 的那份种子（`/graph/*`）。 */
export type GraphSource = 'api' | 'static';

/** 产物不属于本站点时抛这个。**与"读不到"分开**：读不到多半是暂时的（网络抖动、
 *  部署还没完），重试有意义；站点不符是确定的——那份产物是**别人站点**的文章算出来的，
 *  重试一万次也还是同一份别人的产物。两条路的 UI 也不同（见 WordGraphExhibit）。 */
export class SiteMismatchError extends Error {
    constructor(readonly site: string) {
        super(`图谱产物属于 ${site || '（未署名）'}，不是本站`);
        this.name = 'SiteMismatchError';
    }
}

/** manifest 的内容。built = 产物生成时间（建图脚本写入，展示柜角标显示它）。 */
export interface GraphManifest {
    v: string;
    file: string;
    bytes: number;
    /** 形如 `2026-09-16T01:31:59+08:00`。老产物可能没有这个字段（可能为 undefined）。 */
    built?: string;
    /** 产物归属站点（建图时 `--site` 写入）。老产物没有这个字段。 */
    site?: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** 这份产物是不是本站的（`--site` 不传时建图脚本写的是哪个站点）。
 *
 *  规则（与 20261003 之前构建期那套判据**逐条相同**，只是搬到了运行期）：
 *    - 没写 `site`（老产物）→ 是。向后兼容，那时本来就没有这个字段。
 *    - `site` 是回环地址 → 是。那是作者在自己机器上建图时的署名。
 *    - 其余 → 与浏览器当前 origin 同源才算。
 *
 *  **为什么必须搬到运行期**：构建期比对时页面还不知道自己会被从哪里打开——判据被
 *  烧进 bundle（旧的 `__GRAPH_LOCAL__`），于是"迁移到新机器、重新建图、构建一次"这条
 *  再正常不过的路**永远过不了闸**（构建那一刻构建机上看不到新域名下的新产物）。
 *  这正是用户说的"别人用不了"的一半；另一半是产物只能靠 vite build 才到得了浏览器。 */
export function siteMatches(site?: string): boolean {
    const s = (site || '').trim();
    if (!s) return true;
    let u: URL;
    try { u = new URL(s); } catch { return false; }
    if (LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) return true;
    return typeof window !== 'undefined' && u.origin === window.location.origin;
}

let pending: Promise<GraphData> | null = null;
let manifestPending: Promise<GraphManifest | null> | null = null;
/** 当前这份 manifest 是从哪条路读到的（`doLoad` 据此拼产物 URL）。
 *  默认 `static`：读不到 manifest 时本就走静态那条路（也是唯一可能拼得出 URL 的情形）。 */
let manifestSource: GraphSource = 'static';

async function fetchManifest(url: string): Promise<GraphManifest | null> {
    try {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) return null;
        const m = await r.json();
        return m && typeof m.file === 'string' ? (m as GraphManifest) : null;
    } catch { return null; }
}

/** 读 manifest（模块级缓存，两次调用只发一次请求）。失败返回 null——
 *  角标是装饰性的，读不到就不显示，绝不能让窗口因此报错或空白。
 *  ⚠️ **失败不进缓存**：只在成功时留下缓存，否则一次网络抖动会让展示柜
 *  "这一辈子都画不出来"（`loadGraph` 那条重试路径就白写了）。 */
export function loadManifest(): Promise<GraphManifest | null> {
    if (!manifestPending) {
        // API 优先（后台重建过的站点）；API 说"本站还没有产物"（200 + `{}`，见
        // `src/routes/graph.rs::graph_manifest`）或不可达，再回落仓库里那份种子。
        // **顺序是刻意反过来的**：没重建过的站点要多花一次请求，换来的是
        // "重建完刷新即新图"——重出图不必等一次 CI 部署。两次请求都很小，
        // 且两条路都是 no-store（否则重出图后浏览器还会拿旧 manifest）。
        manifestPending = (async () => {
            const api = await fetchManifest('/api/public/graph/manifest');
            if (api) { manifestSource = 'api'; return api; }
            const seed = await fetchManifest('/graph/manifest.json');
            if (seed) manifestSource = 'static';
            return seed;
        })().then((m) => { if (!m) manifestPending = null; return m; });
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
    // manifest 是 no-store，所以每次刷新都会重新问一次当前该加载哪个 hash
    // ——重出图不必改前端代码，也不必 bump 版本号。
    const m = await loadManifest();
    if (!m || !FILE_RE.test(m.file)) {
        throw new Error(`manifest 里没有可用的产物文件名: ${m && m.file}`);
    }
    // 归属自校验放在**取产物之前**：不是本站的产物，连拉都不该拉。
    if (!siteMatches(m.site)) throw new SiteMismatchError(m.site || '');
    // @vite-ignore：路径含运行时才知道的 hash，Vite 不能静态分析。
    // 两条路都是浏览器原生动态导入吃 URL，没有构建期处理。
    const url = manifestSource === 'api'
        ? `/api/public/graph/artifact/${m.file}`
        : `/graph/${m.file}`;
    const mod = await import(/* @vite-ignore */ url);
    const data = mod.default as GraphData;
    if (!data || !Array.isArray(data.nodes) || !data.nodes.length) {
        throw new Error('产物内容为空');
    }
    return data;
}

/** 仅供测试注入用 */
export function __resetGraphCache() {
    pending = null;
    manifestPending = null;
    manifestSource = 'static';
}

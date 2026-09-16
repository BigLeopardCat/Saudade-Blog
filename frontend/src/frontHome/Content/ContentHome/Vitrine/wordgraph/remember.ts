import type { LocateHit } from './types';

/** 检索态的持久化。两份存储，分工不同：
 *
 *  - **URL 参数 `?wg=`**：跨页面跳转的真源。展示柜在首页，点图谱里的词是
 *    react-router 的 SPA 跳转（首页整棵组件树卸载，`useState` 里的检索态随之
 *    销毁）；写进 URL 之后，浏览器的**后退**回到首页时参数还在，刷新也在，
 *    顺便还能把"我搜到的这片"直接发给别人。用 `replace` 写，一次检索不占一条历史。
 *  - **sessionStorage**：把命中列表（后端算的、要花一次 embedding 的那部分）连
 *    同选中词缓存下来，回来时**不必再等一次网络往返**就能还原画面；也是点站内
 *    「首页」链接（URL 上没有 `wg`）回来时唯一能救回状态的地方。按标签页隔离，
 *    新开标签是干净的。
 *
 *  两处都只存"检索"这一件事，不存相机/悬停这类一过性状态——相机由命中列表重算
 *  （`cameraFor`），这样两侧不会各记一份而漂移。 */
export const WG_PARAM = 'wg';

const SKEY = 'wgSearchState';
/** 缓存里最多留多少个命中词（正常 8 个；留余量防手改过的脏数据） */
const MAX_HITS = 32;
const MAX_Q = 64;          // 与输入框 maxLength / locate 的 QUERY_MAX 一致

export interface SavedSearch {
    /** 查询串（非空，已 trim + 截断） */
    q: string;
    /** 命中词列表；**null = 还没有过命中列表**（只有查询串，需要重新检索一次）。
     *  空数组按 null 处理——"没找到相关的词"与"还没查"在恢复时的动作是同一个。 */
    hits: LocateHit[] | null;
    /** 选中的词（小写或显示形都行，恢复时走 wordKey 匹配，与 pick() 同规则） */
    sel: string | null;
}

/** URL 里的查询串。**外来输入**：可能被手改成超长串，所以照样截断。 */
export function queryFromUrl(get: (k: string) => string | null): string {
    return (get(WG_PARAM) || '').trim().slice(0, MAX_Q);
}

export function serialize(q: string, hits: LocateHit[] | null, sel: string | null): string {
    return JSON.stringify({ q, hits: hits && hits.length ? hits : null, sel });
}

/** 解析缓存。任何一处不对劲就整份丢弃（退化成"没有缓存"），绝不半信半疑地用。 */
export function parseSaved(raw: string | null): SavedSearch | null {
    if (!raw) return null;
    try {
        const j = JSON.parse(raw);
        const q = typeof j?.q === 'string' ? j.q.trim().slice(0, MAX_Q) : '';
        if (!q) return null;
        const hits: LocateHit[] | null = Array.isArray(j.hits)
            ? j.hits
                .filter((h: unknown): h is LocateHit => {
                    const o = h as LocateHit;
                    return !!o && typeof o.w === 'string' && typeof o.s === 'number';
                })
                .slice(0, MAX_HITS)
                .map((h: LocateHit) => ({ w: h.w, s: h.s }))
            : null;
        return { q, hits: hits && hits.length ? hits : null, sel: typeof j.sel === 'string' ? j.sel : null };
    } catch {
        return null;
    }
}

/** 挂载时决定恢复什么。**URL 参数优先**——它跟着前进/后退走，是"我刚才在哪儿"的
 *  权威；URL 上没有（点站内首页链接回来）才退到本标签页的缓存。
 *  URL 有查询串但缓存是**另一次**检索 ⇒ 只恢复查询串，命中列表老老实实重新检索。 */
export function decideBoot(urlQ: string, cached: SavedSearch | null): SavedSearch | null {
    if (urlQ) return cached && cached.q === urlQ ? cached : { q: urlQ, hits: null, sel: null };
    return cached;
}

export function readSaved(): SavedSearch | null {
    try {
        return parseSaved(sessionStorage.getItem(SKEY));
    } catch {
        return null;   // 隐私模式 / 存储被禁用：当成没有缓存，不影响检索本身
    }
}

export function writeSaved(s: SavedSearch): void {
    try {
        sessionStorage.setItem(SKEY, serialize(s.q, s.hits, s.sel));
    } catch { /* 同上：存不下就算了，功能退化但不报错 */ }
}

export function clearSaved(): void {
    try {
        sessionStorage.removeItem(SKEY);
    } catch { /* 同上 */ }
}

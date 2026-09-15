import type { GraphData, LocateHit } from './types';
import { wordKey } from './engine';
import { runtimeBaseURL } from '../../../../../utils/runtimeApi';

export interface LocateResult {
    hits: LocateHit[];
    /** vector = 走了后端真 embedding 检索；local = 客户端关键词兜底 */
    source: 'vector' | 'local';
}

const QUERY_MAX = 64;
/** 超时必须比后端每一层都长，否则先 abort 就永远拿不到后端已经判定好的失败原因：
 *  7s > Rust 代理 6s > agent embedding 5s。**改任何一层都要一起看这三个数。**
 *  稳态 ~200ms，所以这只是兜底；真触发时用户等 7s 换回本地匹配，好过一直转圈。 */
const TIMEOUT_MS = 7000;
/** 兜底 Jaccard 取前几名。太多会让"没命中"变成"命中一片"，反而没有定位感 */
const FALLBACK_TOP = 8;

/**
 * 查询词 → 图谱节点。**A 路（默认）走后端真 embedding**；只要有任何一步不成立
 * （未登录 / 网络失败 / 超时 / 后端 503）就静默退到 B 路本地关键词匹配。
 * 两条路产出同一种 LocateHit[]，所以下游的相机运动与高亮逻辑完全一致，
 * 降级对用户不可见（只是"找到的邻居没那么准"）。
 *
 * **例外：后端明确说"没匹配上"（reason=no_match，服务端 BM25 弃权闸）时不降级。**
 * 那是结论不是故障，降级反而会把它盖掉——本地兜底对零命中的输入还有一层字符
 * bigram 兜底（`保证任何输入都有落点`），那个落点正是弃权闸要消灭的东西。
 * 返回空 hits + source='vector'，界面如实显示"没找到相关的词"。
 */
export async function locate(raw: string, g: GraphData): Promise<LocateResult> {
    const q = raw.trim().slice(0, QUERY_MAX);
    if (!q) return { hits: [], source: 'local' };

    // 未登录直接走本地：查询端点要求登录（防匿名刷 embedding 费用），
    // 没有 token 时那个请求必然 401，没必要先花一个往返。
    if (hasToken()) {
        const hits = await queryVector(q);
        // 注意判的是 `!== null` 而不是 `.length`：空数组 = "闸判定图里没有"，
        // 是一个要如实呈现的结论，不能掉进本地兜底把结论换成猜测。
        if (hits !== null) return { hits, source: 'vector' };
    }
    return { hits: locateLocal(q, g), source: 'local' };
}

function hasToken(): boolean {
    try { return !!localStorage.getItem('tokenKey'); } catch { return false; }
}

/**
 * A 路：真 embedding。返回值三态，**别把它合并成两态**：
 *   LocateHit[]   路通了（可能是空数组：弃权闸判定"图里没有这句话"）
 *   null          路不通（未登录/网络/超时/后端故障）→ 调用方退本地兜底
 */
async function queryVector(q: string): Promise<LocateHit[] | null> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
        // 裸 fetch，不走 apis/axios.tsx：那边有 15s 超时 + 401 清 token 跳 /login 的
        // 拦截器——图谱查询失败不该把用户踢出首页。
        const res = await fetch(`${runtimeBaseURL}/api/public/graph/query`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${localStorage.getItem('tokenKey') || ''}`,
            },
            body: JSON.stringify({ q }),
            signal: ac.signal,
        });
        if (!res.ok) return null;
        const j = await res.json();
        // 弃权闸（服务端 BM25）：图里没有任何一个词出现在查询里。这不是故障。
        if (j && j.ok === false && j.reason === 'no_match') return [];
        if (!j || j.ok !== true || !Array.isArray(j.words)) return null;
        const out: LocateHit[] = [];
        for (const it of j.words) {
            if (it && typeof it.w === 'string' && typeof it.s === 'number') {
                out.push({ w: it.w, s: it.s });
            }
        }
        return out;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------- B 路：本地兜底

/** 词的查询键。**统一用 engine 的 wordKey**——本地兜底路原来自己实现了一份大小写
 *  不敏感的键，而向量路用精确匹配，于是"检索服务可用时反而不如降级准"（20260916 定位）。
 *  两份实现合并成一个函数，两侧不可能再分叉。 */
const keyOf = wordKey;

/**
 * 纯前端关键词匹配。图谱自带的 300+ 个领域词就是现成词典——
 * 对 query 从左到右做最长匹配（4→3→2 字），命中即跳过，避免"异步"与"步编"重叠命中。
 * 零命中时退回字符 bigram Jaccard 取 top N，**保证任何输入都有落点**（哪怕落点是错的，
 * 也好过按了回车什么都没发生）。
 */
export function locateLocal(q: string, g: GraphData): LocateHit[] {
    const vocab = new Map<string, { w: string; n: number }>();
    let maxCjk = 2;   // 中文最长匹配的上界，**从词表算**（见下）
    for (const node of g.nodes) {
        const k = keyOf(node.w);
        vocab.set(k, { w: node.w, n: node.n });
        // 上界写死 4 会漏掉更长的词：产物里已有的「兼容性问题」是 5 字，
        // 写死 4 时连它自己当查询都匹配不到（服务端闸那边实测踩过同一个洞）。
        if (!/^[\x00-\x7f]*$/.test(k)) maxCjk = Math.max(maxCjk, k.length);
    }

    const hits: LocateHit[] = [];
    const seen = new Set<string>();
    const push = (w: string, s: number) => {
        if (seen.has(w)) return;
        seen.add(w);
        hits.push({ w, s });
    };

    const s = q.toLowerCase();
    let i = 0;
    while (i < s.length) {
        // ASCII 段整词处理（"vector space" 不该被切成 "ve"/"ct"）
        if (/[a-z0-9]/.test(s[i])) {
            let j = i;
            while (j < s.length && /[a-z0-9]/.test(s[j])) j++;
            const tok = s.slice(i, j);
            i = j;
            if (tok.length < 2) continue;
            const exact = vocab.get(tok);
            if (exact) { push(exact.w, scoreOf(exact.n, tok.length, 1)); continue; }
            // 词形差：只认"一个是另一个的前缀"且短的那个 ≥3 字（防 "in" 命中一片）
            for (const [k, v] of vocab) {
                if (k.length < 3 || tok.length < 3) continue;
                if (k.startsWith(tok) || tok.startsWith(k)) {
                    push(v.w, scoreOf(v.n, Math.min(k.length, tok.length), 0.75));
                }
            }
            continue;
        }
        // 中文段：最长匹配（上界 = 词表里最长的中文词，与服务端 match_terms 同一规则）
        let matched = 0;
        for (let len = maxCjk; len >= 2; len--) {
            if (i + len > s.length) continue;
            const sub = s.slice(i, i + len);
            if (!/^[一-鿿]+$/.test(sub)) continue;
            const hit = vocab.get(sub);
            if (hit) { push(hit.w, scoreOf(hit.n, len, 1)); matched = len; break; }
        }
        i += matched || 1;
    }

    if (hits.length) {
        hits.sort((a, b) => b.s - a.s);
        return hits.slice(0, 12);
    }

    // 零命中兜底：字符 bigram Jaccard
    const probes = bigrams(s);
    if (!probes.size) return [];
    const scored: LocateHit[] = [];
    for (const node of g.nodes) {
        const k = keyOf(node.w);
        const bg = bigrams(k);
        if (!bg.size) continue;
        let inter = 0;
        for (const x of probes) if (bg.has(x)) inter++;
        const jac = inter / (probes.size + bg.size - inter);
        if (jac > 0) scored.push({ w: node.w, s: 0.3 * jac });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, FALLBACK_TOP);
}

/** 词长参与打分：同一个 query 里，"异步编程→异步" 这种长命中比撞上一个二字词更可信 */
function scoreOf(importance: number, len: number, factor: number): number {
    return importance * Math.min(1.5, 0.5 + len / 6) * factor;
}

function bigrams(s: string): Set<string> {
    const out = new Set<string>();
    // ASCII 先整词化，避免 "ai" 这种跨词 bigram
    const norm = s.replace(/[^a-z0-9一-鿿]+/g, ' ');
    for (const tok of norm.split(' ')) {
        if (!tok) continue;
        if (tok.length === 1) { out.add(tok); continue; }
        for (let i = 0; i + 2 <= tok.length; i++) out.add(tok.slice(i, i + 2));
    }
    return out;
}

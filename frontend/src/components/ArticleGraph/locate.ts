import type { GraphData, LocateHit } from './types';
import { wordKey } from './engine';
import { runtimeBaseURL } from '../../utils/runtimeApi';

export interface LocateResult {
    hits: LocateHit[];
    source: 'vector' | 'local';
    reason?: 'login_required' | 'service_unavailable';
}

const QUERY_MAX = 64;

// Allow the service proxy to finish its six-second timeout before local fallback.
const TIMEOUT_MS = 7000;

const FALLBACK_TOP = 8;

export async function locate(raw: string, g: GraphData, signal?: AbortSignal): Promise<LocateResult> {
    const q = raw.trim().slice(0, QUERY_MAX);
    if (!q) return { hits: [], source: 'local' };
    if (hasToken()) {
        const hits = await queryVector(q, signal);
        if (hits) {
            const words = new Set(g.nodes.map(node => wordKey(node.w)));
            const valid = hits.filter(hit => words.has(wordKey(hit.w)));
            if (!hits.length || valid.length) return { hits: valid, source: 'vector' };
        }
    }
    signal?.throwIfAborted();
    return { hits: locateLocal(q, g), source: 'local', reason: hasToken() ? 'service_unavailable' : 'login_required' };
}

function hasToken(): boolean {
    try { return !!localStorage.getItem('tokenKey'); } catch { return false; }
}

async function queryVector(q: string, signal?: AbortSignal): Promise<LocateHit[] | null> {
    signal?.throwIfAborted();
    const ac = new AbortController();
    const cancel = () => ac.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
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
        if (!j || j.ok !== true || !Array.isArray(j.words)) return null;
        const out: LocateHit[] = [];
        for (const it of j.words) {
            if (it && typeof it.w === 'string' && typeof it.s === 'number' && Number.isFinite(it.s)) {
                out.push({ w: it.w, s: it.s });
            }
        }
        return out;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
    }
}

const keyOf = wordKey;

export function locateLocal(q: string, g: GraphData): LocateHit[] {
    const vocab = new Map<string, { w: string; n: number }>();
    let maxCjk = 2;   // 中文最长匹配的上界，**从词表算**（见下）
    for (const node of g.nodes) {
        const k = keyOf(node.w);
        vocab.set(k, { w: node.w, n: node.n });
        if ([...k].some(char => char.charCodeAt(0) > 127)) maxCjk = Math.max(maxCjk, k.length);
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
        if (/[a-z0-9]/.test(s[i])) {
            let j = i;
            while (j < s.length && /[a-z0-9]/.test(s[j])) j++;
            const tok = s.slice(i, j);
            i = j;
            if (tok.length < 2) continue;
            const exact = vocab.get(tok);
            if (exact) { push(exact.w, scoreOf(exact.n, tok.length, 1)); continue; }
            for (const [k, v] of vocab) {
                if (k.length < 3 || tok.length < 3) continue;
                if (k.startsWith(tok) || tok.startsWith(k)) {
                    push(v.w, scoreOf(v.n, Math.min(k.length, tok.length), 0.75));
                }
            }
            continue;
        }
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

function scoreOf(importance: number, len: number, factor: number): number {
    return importance * Math.min(1.5, 0.5 + len / 6) * factor;
}

function bigrams(s: string): Set<string> {
    const out = new Set<string>();
    const norm = s.replace(/[^a-z0-9一-鿿]+/g, ' ');
    for (const tok of norm.split(' ')) {
        if (!tok) continue;
        if (tok.length === 1) { out.add(tok); continue; }
        for (let i = 0; i + 2 <= tok.length; i++) out.add(tok.slice(i, i + 2));
    }
    return out;
}

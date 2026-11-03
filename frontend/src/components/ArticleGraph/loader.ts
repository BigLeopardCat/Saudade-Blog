import type { GraphData } from './types';

const FILE_RE = /^graph-[A-Za-z0-9_-]{8,}\.js$/;
const CACHE_MS = 60_000;
export interface GraphManifest { v: string; file: string; bytes: number; built?: string; site?: string }
export class SiteMismatchError extends Error {
    constructor(readonly site: string) { super('图谱产物不属于本站'); this.name = 'SiteMismatchError'; }
}
export function siteMatches(site?: string): boolean {
    if (!site?.trim()) return true;
    try {
        const url = new URL(site);
        return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase())
            || url.origin === window.location.origin;
    } catch { return false; }
}
let pending: Promise<GraphData> | null = null;
let loadedAt = 0;

export function loadGraph(): Promise<GraphData> {
    if (pending && Date.now() - loadedAt > CACHE_MS) resetGraphCache();
    if (!pending) {
        loadedAt = Date.now();
        pending = doLoad().catch(error => { pending = null; throw error; });
    }
    return pending;
}
async function manifest(url: string): Promise<GraphManifest | null> {
    try {
        const response = await fetch(url, {cache: 'no-store'});
        if (!response.ok) return null;
        const value = await response.json();
        return value && typeof value.file === 'string' ? value as GraphManifest : null;
    } catch { return null; }
}
async function doLoad(): Promise<GraphData> {
    const server = await manifest('/api/public/graph/manifest');
    const value = server ?? await manifest('/graph/manifest.json');
    if (!value || !FILE_RE.test(value.file)) throw new Error('图谱尚未生成');
    if (!siteMatches(value.site)) throw new SiteMismatchError(value.site ?? '');
    // Immutable, content-addressed artifacts are published by the graph builder.
    const url = server ? `/api/public/graph/artifact/${value.file}` : `/graph/${value.file}`;
    const module = await import(/* @vite-ignore */ url);
    if (!isGraphData(module.default) || module.default.v !== value.v) throw new Error('图谱产物无效');
    return module.default;
}
export function resetGraphCache() { pending = null; loadedAt = 0; }

/** Validate indexes and numeric coordinates before handing artifacts to the canvas engine. */
export function isGraphData(value: unknown): value is GraphData {
    if (!value || typeof value !== 'object') return false;
    const graph = value as GraphData;
    if (typeof graph.v !== 'string' || !Array.isArray(graph.nodes) || !graph.nodes.length
        || !Array.isArray(graph.articles) || !graph.articles.length || !Array.isArray(graph.edges)) return false;
    const index = (n: number, length: number) => Number.isInteger(n) && n >= 0 && n < length;
    return graph.articles.every(row => row && Number.isSafeInteger(row.id) && row.id > 0 && typeof row.t === 'string')
        && graph.nodes.every((node, i) => node && node.i === i && typeof node.w === 'string'
            && [node.x, node.y, node.z, node.n].every(Number.isFinite)
            && index(node.a, graph.articles.length) && index(node.a2, graph.articles.length))
        && graph.edges.every(edge => Array.isArray(edge) && edge.length === 3
            && index(edge[0], graph.nodes.length) && index(edge[1], graph.nodes.length) && Number.isFinite(edge[2]));
}

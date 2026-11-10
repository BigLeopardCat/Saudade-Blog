/** Content-addressed visualization derived by the optional blog-owned graph builder. */

export interface GraphNode {
    /** 下标（= 在 nodes 数组中的位置，边和向量都按它索引） */
    i: number;
    /** 词（ASCII 取语料中出现最多的大小写形式） */
    w: string;
    x: number; y: number; z: number;
    n: number;
    h?: number;
    /** 主归属文章下标（指向 articles[]） */
    a: number;
    /** 次归属文章下标 */
    a2: number;
}

/** [节点a, 节点b, 余弦相似度] */
export type GraphEdge = [number, number, number];

export interface GraphArticle {
    /** 文章 id，双击点跳转 /article/<id> */
    id: number;
    /** 标题 */
    t: string;
    /** 标签名 */
    g: string[];
    /** 分类名 */
    c: string;
    hv?: number;
}

export interface GraphStats {
    layout: string;
    n_nodes: number;
    var3_sum: number;
    source?: string;
    [k: string]: unknown;
}

export interface GraphData {
    /** 产物内容 id（前端只用它做缓存键与日志） */
    v: string;
    model: string; dim: number; built: string;
    articles: GraphArticle[];
    nodes: GraphNode[];
    edges: GraphEdge[];
    stats: GraphStats;
}

/** Word hits share one presentation shape; the response mode identifies their source. */
export interface LocateHit { w: string; s: number }

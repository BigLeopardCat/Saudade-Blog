/** 图谱产物的数据结构——由 saudade-blog-agent/scripts/build_word_graph.py 生成，
 *  契约见 docs/word-graph.md。字段名故意用单字母：节点 333 个、边 569 条，
 *  短键名让产物从 49KB 降到 36KB。 */

export interface GraphNode {
    /** 下标（= 在 nodes 数组中的位置，边和向量都按它索引） */
    i: number;
    /** 词（ASCII 取语料中出现最多的大小写形式） */
    w: string;
    x: number; y: number; z: number;
    /** 归一化重要度 0~1（tf-idf），决定点的大小与标签优先级 */
    n: number;
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
}

export interface GraphStats {
    var3_sum: number; sv_ratio_1_3: number;
    fidelity: number; fidelity_raw: number; len_sim_rho: number;
    layout: string; layout_iters?: number;
    n_nodes: number; n_rescued: number; tau: number; k: number;
    built?: string;
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

/** 查询定位的结果：命中词 + 权重（真 embedding 与本地兜底产出同一种形状，
 *  下游 locate() 完全一致，所以降级对 UI 不可见） */
export interface LocateHit { w: string; s: number }

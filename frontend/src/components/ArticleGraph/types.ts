/** 图谱产物的数据结构——由 saudade-blog-agent/scripts/build_word_graph.py 生成，
 *  契约见 docs/word-graph.md。字段名故意用单字母：节点 400 个、边 778 条，
 *  短键名让产物从 49KB 降到 36KB。 */

export interface GraphNode {
    /** 下标（= 在 nodes 数组中的位置，边和向量都按它索引） */
    i: number;
    /** 词（ASCII 取语料中出现最多的大小写形式） */
    w: string;
    x: number; y: number; z: number;
    /** 归一化重要度 0~1（tf-idf）。**不再决定点的大小**（20261003 起改由 `h` 决定），
     *  只留给局部关键词回退 `locate.ts` 做检索相关性——热门文章的词不该垄断一切查询。 */
    n: number;
    /** 归一化文章热度 0~1（20261003 加）= 0.75×主归属文章热度 + 0.25×次归属文章热度；
     *  文章热度由阅读/点赞/收藏/评论的 log1p 加权算出（权重见建图脚本）。
     *  决定点的大小、标签字号与常显标签的优先级。**老产物没有这个字段**。 */
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
    /** 归一化热度 0~1（20261003 加，口径同 `GraphNode.h`）。老产物没有这个字段。 */
    hv?: number;
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

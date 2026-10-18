/* 新渲染模块与 `index.tsx` 之间的**显式几何契约**。
 *
 * 为什么不把这些函数搬进模块：`riverX` / `riverY` / `traceRiver` 是组件闭包，
 * 读的是 `viewRef.current`，且是全页最热的三条路径（每帧被调用上百次）。
 * 搬走要么把 viewRef 也搬走（那就等于把整页搬走），要么每帧多一层间接。
 * 所以：**本体留在 index.tsx 不动**，新模块只收这一个接口对象。
 *
 * 坐标全部是 **CSS 像素**、原点在视口左上角（静态层的 `MARGIN` 平移由调用方处理）。
 * 设备像素换算（dpr）由各模块自己决定 —— 静态层用 dpr，后期层用降采样倍率。 */

export interface Geo {
    /** 视口宽（CSS px） */
    w: number;
    /** 视口高（CSS px） */
    h: number;
    /** 地平线 y（CSS px）—— 天空与远山的分界 */
    yH: number;
    /** 静态层出血边（CSS px），供视差位移留余量 */
    margin: number;
    /** 当前 canvas 的设备像素比（已按 DPR_CAP 与软渲染夹过） */
    dpr: number;
    /** 河道横向投影：u∈[0,1] 为河道内归一化横坐标，d 为景深 */
    riverX(u: number, d: number): number;
    /** 河道纵向投影：d=0 在远山，d=1 在眼前 */
    riverY(d: number): number;
    /** `riverX` 的反解：屏幕上横坐标 x 在深度 d 处对应哪条 u。
     *  该深度上河道根本不含这一列时返回 null（月光倒影列在近地平线处会跑出河道）。
     *  反解与 `riverX` 共用同一条公式（都在 index.tsx 里），不在这里重写一遍。 */
    riverUAt(x: number, d: number): number | null;
    /** 把河道路径（dFrom→dTo 的一段）追加进当前路径；调用方负责 beginPath/clip/fill。
     *  `easeUDepth` 是 index.tsx 里那份实现的既有第三参（当前所有调用点都传 false）。 */
    traceRiver(ctx: CanvasRenderingContext2D, dFrom: number, dTo: number, easeUDepth?: boolean): void;
}

/** 月亮在屏幕上的几何 —— 月盘 sprite、月晕、水面倒影、体积光轴共用这一份，
 *  免得四处各算一遍算出四个位置。 */
export interface MoonGeom {
    /** 月心屏幕坐标（CSS px，不含视差） */
    x: number;
    y: number;
    /** 月盘半径（CSS px） */
    r: number;
    /** 月相光晕系数：新月 ≈0.35，满月 =1 */
    haloK: number;
    /** 受光面中心相对月心的横向偏移（-1..1，以月盘半径为单位的 e/2） */
    lx: number;
    /** 光方向的**朝观察者分量**：满月 +1（正面照），上下弦 0（侧照），新月 -1。
     *  月晕要按"盘面上每一点被照到多少"加权，只给 `lx` 是算不出来的 —— 那会把
     *  上弦月也画成一个朝右偏移的整圆（用户原话：「不是满月，光晕却还是圆环」）。 */
    lz: number;
}

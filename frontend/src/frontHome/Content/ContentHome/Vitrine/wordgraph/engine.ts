import type { GraphData, GraphNode, LocateHit } from './types';
import { artColor, PALETTE, LABEL_FONT } from './palette';

/** 轨道相机。target 是画面中心的世界坐标，dist 是相机到 target 的距离。 */
export interface Camera { yaw: number; pitch: number; dist: number; target: [number, number, number] }

export const HOME_CAM: Camera = { yaw: 0.55, pitch: 0.16, dist: 4.3, target: [0, 0, 0] };

const FOV = (50 * Math.PI) / 180;
const PITCH_LIMIT = 1.35;
const DIST_MIN = 1.7;
const DIST_MAX = 9;
/** 定位飞行时的最近距离。比 DIST_MIN 稍远一点，保证滚轮也能退回到同一档位 */
const LOCATE_DIST_MIN = 1.9;

/** 边按相似度分 4 档透明度，每档一次 stroke：569 条边 → 4 次绘制调用。
 *  逐条 stroke 在低端机上就是掉帧主因。 */
const EDGE_BUCKETS = 4;
/** 标签预算：A 层常驻 + B 层按深度补，总上限。C 层（悬停/查询命中）不受限。 */
const LABEL_A = 22;
const LABEL_MAX = 34;
/** 拖动后多久内忽略 dblclick（ms）。没有这个守卫，"拖两下"会误触跳转。 */
const DRAG_DBL_GUARD = 300;
/** 命中辉光的持续时长。必须有限——无限脉冲等于常驻渲染循环，
 *  会直接违反"空闲零 rAF"这条硬要求。 */
const PULSE_MS = 1800;

export interface EngineOpts {
    onHover?: (node: number | null) => void;
    onActivate?: (node: number) => void;
}

export class WordGraphEngine {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private data: GraphData;
    private opts: EngineOpts;

    private cam: Camera = { ...HOME_CAM, target: [0, 0, 0] };
    private w = 0; private h = 0; private dpr = 1;
    /** 降级档位：1 = 正常；0 = 无 WebGL 或帧耗时超标（DPR 1 + 标签减半） */
    private quality = 1;
    private slowFrames = 0;

    // 逐帧复用的投影缓冲（每帧 new 会带来可见的 GC 抖动）
    private proj: Projection;
    private order: number[];

    private edgeBucket: Uint8Array;

    /** 唯一 rAF 持有者。0 表示当前没有待出帧——这就是"静止即零 rAF"。
     *  ⚠️ 任何结束动画的路径都必须把它清回 0，否则 invalidate() 会永久早退。 */
    private raf = 0;
    private frozen = false;
    private disposed = false;

    private anim: { from: Camera; to: Camera; dyaw: number; t0: number; ms: number } | null = null;
    private pulseT0 = -1e9;

    private hover: number | null = null;
    private hits = new Map<number, number>();   // nodeIdx -> weight

    private byImportance: number[];
    private labelW = new Map<string, number>();
    private placed: number[] = [];

    // 交互状态
    private dragging = false;
    private lastX = 0; private lastY = 0;
    private moved = 0;
    private dragEndAt = 0;

    private io: IntersectionObserver | null = null;
    private onVisibility: () => void;

    constructor(canvas: HTMLCanvasElement, data: GraphData, opts: EngineOpts = {}) {
        this.canvas = canvas;
        this.data = data;
        this.opts = opts;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('2D context 不可用');
        this.ctx = ctx;

        const n = data.nodes.length;
        this.proj = new Projection(n);
        this.order = new Array(n);
        for (let i = 0; i < n; i++) this.order[i] = i;
        this.byImportance = this.order.slice().sort((a, b) => data.nodes[b].n - data.nodes[a].n);

        let sMin = Infinity; let sMax = -Infinity;
        for (const e of data.edges) { if (e[2] < sMin) sMin = e[2]; if (e[2] > sMax) sMax = e[2]; }
        if (!data.edges.length) { sMin = 0; sMax = 1; }
        this.edgeBucket = new Uint8Array(data.edges.length);
        const span = Math.max(sMax - sMin, 1e-6);
        for (let k = 0; k < data.edges.length; k++) {
            const t = (data.edges[k][2] - sMin) / span;
            this.edgeBucket[k] = Math.min(EDGE_BUCKETS - 1, Math.floor(t * EDGE_BUCKETS));
        }

        // 无 WebGL 的机器（软渲染）一开始就降档，别等帧率掉下来再降
        try {
            const probe = document.createElement('canvas');
            if (!probe.getContext('webgl') && !probe.getContext('experimental-webgl')) this.quality = 0;
        } catch { this.quality = 0; }

        this.attach();
        this.onVisibility = () => this.freeze(document.hidden);
        document.addEventListener('visibilitychange', this.onVisibility);
        this.resize();
    }

    // ------------------------------------------------------------ 生命周期

    private attach() {
        const c = this.canvas;
        c.addEventListener('pointerdown', this.onDown);
        c.addEventListener('pointermove', this.onMove);
        c.addEventListener('pointerup', this.onUp);
        c.addEventListener('pointercancel', this.onUp);
        c.addEventListener('pointerleave', this.onLeave);
        c.addEventListener('dblclick', this.onDbl);
        c.addEventListener('wheel', this.onWheel, { passive: false });
        if (typeof IntersectionObserver !== 'undefined') {
            this.io = new IntersectionObserver((es) => {
                for (const e of es) this.freeze(!e.isIntersecting);
            }, { threshold: 0.01 });
            this.io.observe(c);
        }
    }

    dispose() {
        this.disposed = true;
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = 0;
        const c = this.canvas;
        c.removeEventListener('pointerdown', this.onDown);
        c.removeEventListener('pointermove', this.onMove);
        c.removeEventListener('pointerup', this.onUp);
        c.removeEventListener('pointercancel', this.onUp);
        c.removeEventListener('pointerleave', this.onLeave);
        c.removeEventListener('dblclick', this.onDbl);
        c.removeEventListener('wheel', this.onWheel);
        document.removeEventListener('visibilitychange', this.onVisibility);
        this.io?.disconnect();
        this.io = null;
        this.labelW.clear();
    }

    /** 出视野 / 切后台时彻底停帧 */
    private freeze(v: boolean) {
        if (this.frozen === v) return;
        this.frozen = v;
        if (v) {
            if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
            this.anim = null;
        } else {
            this.invalidate();
        }
    }

    /** 容器尺寸变化时调用（rAF 由 invalidate 自己安排） */
    resize() {
        const r = this.canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        if (w === this.w && h === this.h) return;
        this.w = w; this.h = h;
        // DPR 上限 1.5：填色成本对像素数近似线性，3x 屏按原样渲染等于白烧 4 倍
        // 填充率，肉眼却分不出差别
        const cap = this.quality === 1 ? 1.5 : 1;
        this.dpr = Math.min(window.devicePixelRatio || 1, cap);
        this.canvas.width = Math.round(w * this.dpr);
        this.canvas.height = Math.round(h * this.dpr);
        this.invalidate();
    }

    /** 降档后要重算 backing store（resize 有"尺寸没变就跳过"的短路） */
    private forceResize() { this.w = 0; this.h = 0; this.resize(); }

    /** 字体就绪后调用：丢掉用 fallback 字体量出来的标签宽度，重新测量并重绘。
     *  （中文字体没加载完时 measureText 给的是西文字体的宽度，标签会明显错位） */
    redraw() {
        this.labelW.clear();
        this.invalidate();
    }

    // ------------------------------------------------------------ 对外状态

    setHighlight(list: LocateHit[] | null) {
        this.hits.clear();
        if (list && list.length) {
            const byWord = new Map<string, number>();
            for (let i = 0; i < this.data.nodes.length; i++) byWord.set(this.data.nodes[i].w, i);
            for (const hit of list) {
                const i = byWord.get(hit.w);
                if (i !== undefined && !this.hits.has(i)) this.hits.set(i, hit.s);
            }
            this.pulseT0 = performance.now();
        }
        this.invalidate();
    }

    getCamera(): Camera { return { ...this.cam, target: [...this.cam.target] as [number, number, number] }; }

    setCamera(cam: Camera) {
        this.anim = null;
        this.cam = { ...cam, target: [...cam.target] as [number, number, number] };
        this.invalidate();
    }

    /** 平滑飞到目标机位。reduced-motion 下瞬移。 */
    flyTo(cam: Camera, ms = 720) {
        const reduce = typeof matchMedia !== 'undefined'
            && matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduce || ms <= 0) { this.setCamera(cam); return; }
        // yaw 走最短弧，否则 350°→10° 会反向绕一大圈
        let dyaw = cam.yaw - this.cam.yaw;
        while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
        while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
        this.anim = { from: this.getCamera(), to: cam, dyaw, t0: performance.now(), ms };
        this.invalidate();
    }

    home(ms = 720) { this.setHighlight(null); this.flyTo(HOME_CAM, ms); }

    // ------------------------------------------------------------ 渲染调度

    /** 标脏并按需排一帧。空闲时 rAF 计数为 0 是这个组件的硬要求
     *  （首页是全站最重的页面），所以这里没有常驻渲染循环。 */
    invalidate() {
        // raf !== 0 就代表已经有一帧在排了，不需要额外的 dirty 标志
        if (this.disposed || this.frozen || this.raf) return;
        this.raf = requestAnimationFrame(this.frame);
    }

    private frame = (now: number) => {
        this.raf = 0;
        if (this.disposed || this.frozen) return;

        let again = false;
        const a = this.anim;
        if (a) {
            const u = Math.min(1, (now - a.t0) / a.ms);
            const k = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;  // easeInOutCubic
            this.cam = {
                yaw: a.from.yaw + a.dyaw * k,
                pitch: a.from.pitch + (a.to.pitch - a.from.pitch) * k,
                dist: a.from.dist + (a.to.dist - a.from.dist) * k,
                target: [
                    a.from.target[0] + (a.to.target[0] - a.from.target[0]) * k,
                    a.from.target[1] + (a.to.target[1] - a.from.target[1]) * k,
                    a.from.target[2] + (a.to.target[2] - a.from.target[2]) * k,
                ],
            };
            if (u >= 1) this.anim = null; else again = true;
        }
        if (now - this.pulseT0 < PULSE_MS) again = true;

        const t0 = performance.now();
        this.draw();
        // 帧耗时滞回降级：连续偏慢就降档（只降不升，避免在阈值附近来回抖）
        const dt = performance.now() - t0;
        if (dt > 22) {
            if (this.quality === 1 && ++this.slowFrames >= 6) {
                this.quality = 0; this.slowFrames = 0; this.forceResize();
            }
        } else if (this.slowFrames > 0) this.slowFrames--;

        if (again) this.invalidate();
    };

    // ------------------------------------------------------------ 投影

    private project() {
        projectNodes(this.data.nodes, this.cam, this.w, this.h, this.proj);
    }

    // ------------------------------------------------------------ 绘制

    private draw() {
        const ctx = this.ctx;
        const { w, h, data } = this;
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        if (!w || !h) return;
        this.project();

        const hi = this.hits.size > 0 || this.hover !== null;
        // 辉光：命中后 PULSE_MS 内起伏衰减，之后转为静态高亮（不再需要出帧）
        const pk = Math.max(0, 1 - (performance.now() - this.pulseT0) / PULSE_MS);
        const glow = 0.45 + 0.55 * Math.sin(pk * Math.PI * 3) * pk;

        // ---- 边：按透明度分档，每档一次 stroke
        const edges = data.edges;
        for (let b = 0; b < EDGE_BUCKETS; b++) {
            const t = (b + 0.5) / EDGE_BUCKETS;
            const base = 0.06 + 0.42 * t;
            ctx.lineWidth = 0.5 + 1.1 * t;
            if (!hi) ctx.strokeStyle = `rgba(${PALETTE.edge}, ${base.toFixed(3)})`;
            ctx.beginPath();
            for (let k = 0; k < edges.length; k++) {
                if (this.edgeBucket[k] !== b) continue;
                const e = edges[k];
                if (this.proj.d[e[0]] <= 0.05 || this.proj.d[e[1]] <= 0.05) continue;
                if (hi) {
                    const hot = this.hits.has(e[0]) || this.hits.has(e[1])
                        || this.hover === e[0] || this.hover === e[1];
                    // 查询定位时把无关的边压暗，让命中簇跳出来
                    const alpha = base * (hot ? 1.6 : 0.22);
                    if (alpha < 0.02) continue;
                    ctx.strokeStyle = hot
                        ? `rgba(${PALETTE.edgeHot}, ${Math.min(1, alpha * glow).toFixed(3)})`
                        : `rgba(${PALETTE.edge}, ${alpha.toFixed(3)})`;
                }
                ctx.moveTo(this.proj.x[e[0]], this.proj.y[e[0]]);
                ctx.lineTo(this.proj.x[e[1]], this.proj.y[e[1]]);
            }
            ctx.stroke();
        }

        // ---- 点：远 → 近（画家算法）
        this.order.sort((a, b) => this.proj.d[b] - this.proj.d[a]);
        for (let oi = 0; oi < this.order.length; oi++) {
            const i = this.order[oi];
            const depth = this.proj.d[i];
            if (depth <= 0.05) break;                    // 已排序，后面的只会更远
            const x = this.proj.x[i], y = this.proj.y[i], r = this.proj.r[i];
            if (x < -40 || y < -40 || x > w + 40 || y > h + 40) continue;
            ctx.globalAlpha = Math.max(0.3, Math.min(1, 1.35 - depth / (this.cam.dist * 1.6)));
            ctx.fillStyle = artColor(data.nodes[i].a);
            ctx.beginPath();
            ctx.arc(x, y, Math.max(0.9, r), 0, Math.PI * 2);
            ctx.fill();
            if (this.hits.has(i) || this.hover === i) {
                ctx.globalAlpha = 1;
                const rr = Math.max(1.6, r + 3.5);
                ctx.fillStyle = PALETTE.glow;
                ctx.beginPath();
                ctx.arc(x, y, rr * (1 + 1.6 * (1 - glow)), 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = PALETTE.hitRing;
                ctx.lineWidth = 1.6;
                ctx.beginPath();
                ctx.arc(x, y, rr, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;

        // ---- 标签：分层 + 贪心 AABB 防重叠
        const placed = this.placed;
        placed.length = 0;
        const cap = (this.quality === 1 ? LABEL_MAX : LABEL_MAX >> 1) << 2;   // 存的是 4 元组
        const take = (i: number, force: boolean, dim: boolean): boolean => {
            const depth = this.proj.d[i];
            if (depth <= 0.05) return false;
            const n = data.nodes[i];
            const size = force || n.n > 0.55 ? 12.5 : 11;
            const font = `${force ? '600 ' : ''}${size}px ${LABEL_FONT}`;
            const key = `${font}|${n.w}`;
            let tw = this.labelW.get(key);
            if (tw === undefined) { ctx.font = font; tw = ctx.measureText(n.w).width; this.labelW.set(key, tw); }
            const x = this.proj.x[i] + this.proj.r[i] + 3.5;
            const y = this.proj.y[i] - size * 0.55;
            if (x > w - tw - 2 || y < 2) return false;
            if (!force && placed.length >= cap) return false;
            const box = [x - 1, y - 1, x + tw + 1, y + size + 1];
            for (let k = 0; k < placed.length; k += 4) {
                if (box[0] < placed[k + 2] && box[2] > placed[k]
                    && box[1] < placed[k + 3] && box[3] > placed[k + 1]) return false;
            }
            placed.push(box[0], box[1], box[2], box[3]);
            ctx.font = font;
            ctx.globalAlpha = force ? 1 : (dim ? 0.55 : 0.9);
            ctx.lineWidth = 3;
            ctx.strokeStyle = PALETTE.labelHalo;
            ctx.strokeText(n.w, x, y + size * 0.8);
            ctx.fillStyle = force ? PALETTE.labelHit : (dim ? PALETTE.labelDim : PALETTE.label);
            ctx.fillText(n.w, x, y + size * 0.8);
            return true;
        };
        // C 层（命中/悬停）先占位——它们是当前看点，不该被常驻标签挤掉
        for (const i of this.hits.keys()) take(i, true, false);
        if (this.hover !== null && !this.hits.has(this.hover)) take(this.hover, true, false);
        // A 层：全局重要度前 N 名常驻
        const byImp = this.byImportance;
        for (let k = 0; k < byImp.length && k < LABEL_A; k++) take(byImp[k], false, false);
        // B 层：其余按"离相机近"补位（拉近自然揭示更多）
        if (!hi) {
            for (let oi = 0; oi < this.order.length; oi++) {
                if (placed.length >= cap) break;
                const i = this.order[oi];
                if (this.proj.d[i] <= 0.05) break;
                take(i, false, true);
            }
        }
        ctx.globalAlpha = 1;
    }

    // ------------------------------------------------------------ 交互

    private hitTest(cx: number, cy: number): number | null {
        return pickNode(this.proj, cx, cy);
    }

    private local(e: PointerEvent | MouseEvent | WheelEvent): [number, number] {
        const r = this.canvas.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    }

    private onDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        this.dragging = true;
        const [x, y] = this.local(e);
        this.lastX = x; this.lastY = y; this.moved = 0;
        this.canvas.style.cursor = 'grabbing';
        try { this.canvas.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    };

    private onMove = (e: PointerEvent) => {
        const [x, y] = this.local(e);
        if (this.dragging) {
            const dx = x - this.lastX, dy = y - this.lastY;
            this.lastX = x; this.lastY = y;
            this.moved += Math.abs(dx) + Math.abs(dy);
            this.anim = null;                                   // 用户接手，取消飞行动画
            this.cam.yaw -= dx * 0.0075;
            this.cam.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.cam.pitch + dy * 0.0075));
            this.invalidate();
            return;
        }
        const hit = this.hitTest(x, y);
        if (hit !== this.hover) {
            this.hover = hit;
            this.canvas.style.cursor = hit === null ? 'grab' : 'pointer';
            this.opts.onHover?.(hit);
            this.invalidate();
        }
    };

    private onUp = (e: PointerEvent) => {
        if (!this.dragging) return;
        this.dragging = false;
        if (this.moved > 4) this.dragEndAt = Date.now();
        try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
        this.canvas.style.cursor = this.hover === null ? 'grab' : 'pointer';
    };

    private onLeave = () => {
        if (this.hover !== null) { this.hover = null; this.opts.onHover?.(null); this.invalidate(); }
    };

    private onDbl = (e: MouseEvent) => {
        // 拖动后的余韵不该触发跳转（"想转个视角"变成"跳走了"很恼人）
        if (Date.now() - this.dragEndAt < DRAG_DBL_GUARD) return;
        const [x, y] = this.local(e);
        const hit = this.hitTest(x, y);
        if (hit !== null) this.opts.onActivate?.(hit);
    };

    private onWheel = (e: WheelEvent) => {
        e.preventDefault();
        this.anim = null;
        this.cam.dist = Math.max(DIST_MIN, Math.min(DIST_MAX, this.cam.dist * Math.exp(e.deltaY * 0.0012)));
        this.invalidate();
    };
}

/**
 * 命中一批词之后该把相机放哪：目标 = 加权质心，距离 = 刚好把命中簇框进视锥。
 * **朝向（yaw/pitch）保持不变**——定位时转视角会让人失去方位感，
 * 只推进去比"绕过去"更好读。没命中就原样返回，绝不乱动相机。
 */
export function cameraFor(g: GraphData, hits: LocateHit[], cur: Camera): Camera {
    if (!hits.length) return cur;
    const byWord = new Map<string, number>();
    for (let i = 0; i < g.nodes.length; i++) byWord.set(g.nodes[i].w, i);

    let sw = 0, cx = 0, cy = 0, cz = 0;
    const idx: number[] = [];
    for (const h of hits) {
        const i = byWord.get(h.w);
        if (i === undefined) continue;
        const w = Math.max(h.s, 1e-3);
        const n = g.nodes[i];
        sw += w; cx += n.x * w; cy += n.y * w; cz += n.z * w;
        idx.push(i);
    }
    if (!sw) return cur;
    cx /= sw; cy /= sw; cz /= sw;

    let radius = 0.22;
    for (const i of idx) {
        const n = g.nodes[i];
        const d = Math.hypot(n.x - cx, n.y - cy, n.z - cz);
        if (d > radius) radius = d;
    }
    // 取景距离的推导：视锥半高 = dist*tanθ，而包围球最外圈的点在近侧只有
    // (dist - radius) 深，透视放大后它偏出 f*radius/(dist-radius)。要求它不超过
    // 半高的 0.9 倍 ⇒ dist ≥ radius * (1 + 1/(0.9*tanθ)) ≈ 3.38*radius。
    // ⚠️ 别把系数往小调：调到刚好包住球心的话，最外圈的点会掉出画面，
    //    而"能看见全部命中词"正是这个功能存在的意义。
    const k = 1 + 1 / (0.9 * Math.tan(FOV / 2));
    const dist = Math.max(LOCATE_DIST_MIN, Math.min(DIST_MAX, radius * k));
    return { yaw: cur.yaw, pitch: cur.pitch, dist, target: [cx, cy, cz] };
}

// ==================================================================
// 投影与命中测试。抽成纯函数（不碰 DOM、不碰类状态）是为了能在 node 里
// 直接断言——这是整套渲染的数学核心，错了画面会静默地歪掉。
// ==================================================================

/** 一帧的屏幕坐标。x/y 是 CSS 像素（不是 DPR backing store），d 是到相机的距离 */
export class Projection {
    x: Float32Array;
    y: Float32Array;
    d: Float32Array;
    r: Float32Array;
    constructor(n: number) {
        this.x = new Float32Array(n);
        this.y = new Float32Array(n);
        this.d = new Float32Array(n);
        this.r = new Float32Array(n);
    }
}

/** 相机前方多近算"贴脸"（比这更近的点不画也不可命中，否则投影会炸到无穷远） */
export const NEAR = 0.05;
const FAR_X = -1e6;

export function projectNodes(nodes: GraphNode[], cam: Camera, w: number, h: number, out: Projection) {
    const { yaw, pitch, dist, target } = cam;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    // 从 target 指向 eye 的单位向量
    const dx = sy * cp, dy = sp, dz = cy * cp;
    const ex = target[0] + dist * dx, ey = target[1] + dist * dy, ez = target[2] + dist * dz;
    // 相机三轴（右手系；zAxis 从 target 指向 eye ⇒ 前方的点 pz<0，depth=-pz>0）
    const zx = dx, zy = dy, zz = dz;
    const xx = cy, xy = 0, xz = -sy;
    const yx = -sp * sy, yy = cp, yz = -sp * cy;
    const f = (h / 2) / Math.tan(FOV / 2);
    const hw = w / 2, hh = h / 2;
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const vx = n.x - ex, vy = n.y - ey, vz = n.z - ez;
        const depth = -(vx * zx + vy * zy + vz * zz);
        out.d[i] = depth;
        if (depth <= NEAR) { out.x[i] = FAR_X; out.y[i] = FAR_X; out.r[i] = 0; continue; }
        const inv = f / depth;
        out.x[i] = hw + (vx * xx + vy * xy + vz * xz) * inv;
        out.y[i] = hh - (vx * yx + vy * yy + vz * yz) * inv;
        // 基础半径按透视缩放（在 target 平面上正好等于括号里的值）
        out.r[i] = (1.7 + 3.1 * Math.sqrt(n.n)) * (dist / depth);
    }
}

/** 命中测试：多个点重叠时取离相机最近的那个（近的挡着远的，符合视觉直觉）。
 *  命中半径带 +4px 宽容，小点在鼠标下也要点得中。 */
export function pickNode(p: Projection, cx: number, cy: number): number | null {
    let best: number | null = null; let bestD = Infinity;
    for (let i = 0; i < p.d.length; i++) {
        const d = p.d[i];
        if (d <= NEAR) continue;
        const dx = cx - p.x[i], dy = cy - p.y[i];
        const rr = Math.max(6, p.r[i] + 4);
        const d2 = dx * dx + dy * dy;
        if (d2 <= rr * rr && d < bestD) { bestD = d; best = i; }
    }
    return best;
}

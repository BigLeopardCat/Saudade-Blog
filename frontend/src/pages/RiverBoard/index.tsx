import { useEffect, useRef, useState } from "react";
import "./index.scss";
import { runtimeBaseURL } from "../../utils/runtimeApi";

/* 河灯留言板 ── 一条只存在于路由之下的河。
   整页为独立顶层路由（/he），不挂博客的头部与底部。
   画面全部为 Canvas 逐帧绘制 + 预渲染灯笼精灵的 DOM 放置。 */

/* ------------------------- 心愿文案 ------------------------- */

const DEMO_MESSAGES = [
    "愿所有等待，终将迎来相逢。",
    "把今晚的月色，寄给远方的你。",
    "愿你走过的路，都开成了花。",
    "祝我爱的人和爱我的人，平安喜乐。",
    "愿你历尽千帆，归来仍是少年。",
    "想攒够温柔，洒给明天的自己。",
    "月亮不睡我不睡，把烦恼都丢进河里。",
    "愿世间美好，都与你我不期而遇。",
    "此时莺飞草长，爱的人正在路上。",
    "愿你三冬暖，愿你春不寒。",
    "别再熬夜赶工了，早点睡吧。",
    "希望某一天的灯下，见到想见的人。",
    "河灯会飘向远方，心事请留在这里。",
    "愿今年的愿望，明年还能在河里捞得到。",
    "把难过留在此刻的河面上，天亮就出发。",
    "愿你所求皆如愿，所行化坦途。",
];

/* 心愿分类：愿 / 寄 / 忆 / 诉（后续可让留言用户自选类型） */
const CATS = ["愿", "寄", "忆", "诉"];
const catOf = (s: string) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return CATS[h % CATS.length];
};

type Wish = { id: number; v: number; msg: string; cat: string };

/* ------------------------- 灯笼精灵预渲染 -------------------------
   三种花样：莲花灯 / 八角灯 / 圆笼灯，全部用 Canvas 手绘，
   比 CSS 拼装的灯笼精致得多，且只有一次离屏绘制成本。 */

const SPRITE_SIZE = 288;

function drawLotus(ctx: CanvasRenderingContext2D, S: number) {
    const cx = S / 2, cy = S / 2;
    // —— 外层花瓣环 ——
    const petalRim = S * 0.30, petalLen = S * 0.42;
    const petals = 7;
    for (let i = 0; i < petals; i++) {
        const a = (i / petals) * Math.PI * 2 - Math.PI / 2;
        const back = i % 2 === 0;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(a);
        const grad = ctx.createLinearGradient(0, 0, 0, -petalLen);
        grad.addColorStop(0, back ? "rgba(214,130,58,0.95)" : "rgba(240,168,90,0.98)");
        grad.addColorStop(0.6, back ? "rgba(250,196,120,0.9)" : "rgba(255,216,146,0.97)");
        grad.addColorStop(1, "rgba(255,228,170,0.92)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(petalRim * 0.55, -petalLen * 0.30, 0, -petalLen); // 右缘
        ctx.quadraticCurveTo(-petalRim * 0.55, -petalLen * 0.30, 0, 0);        // 左缘
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(168,86,32,0.35)";
        ctx.lineWidth = S * 0.008;
        ctx.stroke();
        // 花瓣中脉
        ctx.strokeStyle = "rgba(255,240,205,0.5)";
        ctx.lineWidth = S * 0.008;
        ctx.beginPath();
        ctx.moveTo(0, -petalLen * 0.08);
        ctx.quadraticCurveTo(petalRim * 0.14, -petalLen * 0.55, 0, -petalLen * 0.94);
        ctx.stroke();
        ctx.restore();
    }
    // —— 灯碗 ——
    const bowl = ctx.createRadialGradient(cx, cy, S * 0.02, cx, cy, S * 0.30);
    bowl.addColorStop(0, "rgba(255,238,196,0.98)");
    bowl.addColorStop(0.55, "rgba(252,196,112,0.98)");
    bowl.addColorStop(0.85, "rgba(226,138,62,0.98)");
    bowl.addColorStop(1, "rgba(176,92,34,0.98)");
    ctx.fillStyle = bowl;
    ctx.beginPath();
    ctx.ellipse(cx, cy, S * 0.30, S * 0.145, 0, 0, Math.PI * 2);
    ctx.fill();
    // 灯碗骨线（向中心聚拢的竖肋）
    ctx.strokeStyle = "rgba(150,74,22,0.30)";
    ctx.lineWidth = S * 0.008;
    for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * S * 0.015, cy + Math.sin(a) * S * 0.007);
        ctx.quadraticCurveTo(
            cx + Math.cos(a) * S * 0.16,
            cy + S * 0.10 + Math.sin(a) * S * 0.05,
            cx + Math.cos(a) * S * 0.295,
            cy + Math.sin(a) * S * 0.143
        );
        ctx.stroke();
    }
    // 碗沿
    ctx.strokeStyle = "rgba(255,238,200,0.55)";
    ctx.lineWidth = S * 0.010;
    ctx.beginPath();
    ctx.ellipse(cx, cy, S * 0.30, S * 0.145, 0, 0, Math.PI * 2);
    ctx.stroke();
    // —— 火焰 ——
    const fg = ctx.createRadialGradient(cx, cy - S * 0.01, 0, cx, cy - S * 0.01, S * 0.09);
    fg.addColorStop(0, "rgba(255,250,224,1)");
    fg.addColorStop(0.4, "rgba(255,228,150,0.95)");
    fg.addColorStop(1, "rgba(255,180,80,0)");
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.arc(cx, cy - S * 0.01, S * 0.09, 0, Math.PI * 2);
    ctx.fill();
    // 焰心竖滴（火苗）
    const tip = ctx.createLinearGradient(0, cy - S * 0.085, 0, cy + S * 0.015);
    tip.addColorStop(0, "rgba(255,252,235,0.95)");
    tip.addColorStop(1, "rgba(255,196,96,0)");
    ctx.fillStyle = tip;
    ctx.beginPath();
    ctx.ellipse(cx, cy - S * 0.035, S * 0.028, S * 0.052, 0, 0, Math.PI * 2);
    ctx.fill();
}

function drawOct(ctx: CanvasRenderingContext2D, S: number) {
    const cx = S / 2, cy = S / 2;
    const W = S * 0.315, H = S * 0.42; // 骨架略放大：把灯焰完整包进笼身
    // 六角灯笼身：六条竖棱的异形桶
    const pts: [number, number][] = [
        [cx, cy - H],
        [cx + W * 0.7, cy - H * 0.55],
        [cx + W, cy],
        [cx + W * 0.7, cy + H * 0.55],
        [cx, cy + H],
        [cx - W * 0.7, cy + H * 0.55],
        [cx - W, cy],
        [cx - W * 0.7, cy - H * 0.55],
    ];
    const body = ctx.createRadialGradient(cx, cy, 0, cx, cy, W);
    body.addColorStop(0, "rgba(255,240,198,0.98)");
    body.addColorStop(0.6, "rgba(250,196,120,0.97)");
    body.addColorStop(1, "rgba(214,128,56,0.96)");
    ctx.fillStyle = body;
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    ctx.closePath();
    ctx.fill();
    // 菱形编格
    ctx.strokeStyle = "rgba(150,72,20,0.28)";
    ctx.lineWidth = S * 0.008;
    for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(cx - W * 1.05, cy + i * H * 0.18);
        ctx.lineTo(cx + W * 1.05, cy - i * H * 0.18);
        ctx.stroke();
    }
    for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(cx - W * 1.05, cy - i * H * 0.18);
        ctx.lineTo(cx + W * 1.05, cy + i * H * 0.18);
        ctx.stroke();
    }
    // 上下金箍
    ctx.fillStyle = "rgba(196,124,52,0.95)";
    ctx.fillRect(cx - W * 0.78, cy - H * 0.60, W * 1.56, S * 0.035);
    ctx.fillRect(cx - W * 0.78, cy + H * 0.60 - S * 0.035, W * 1.56, S * 0.035);
    // 顶部提环（迷你）
    ctx.strokeStyle = "rgba(200,140,70,0.9)";
    ctx.lineWidth = S * 0.014;
    ctx.beginPath();
    ctx.arc(cx, cy - H - S * 0.015, S * 0.03, Math.PI * 1.15, Math.PI * 1.85, true);
    ctx.stroke();
    // 火焰
    const fg = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 0.10);
    fg.addColorStop(0, "rgba(255,250,230,1)");
    fg.addColorStop(0.45, "rgba(255,226,148,0.95)");
    fg.addColorStop(1, "rgba(255,176,80,0)");
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.arc(cx, cy, S * 0.10, 0, Math.PI * 2);
    ctx.fill();
    const tip = ctx.createLinearGradient(0, cy - S * 0.09, 0, cy + S * 0.02);
    tip.addColorStop(0, "rgba(255,252,238,0.95)");
    tip.addColorStop(1, "rgba(255,196,96,0)");
    ctx.fillStyle = tip;
    ctx.beginPath();
    ctx.ellipse(cx, cy, S * 0.030, S * 0.055, 0, 0, Math.PI * 2);
    ctx.fill();
}

function drawDrum(ctx: CanvasRenderingContext2D, S: number) {
    const cx = S / 2, cy = S / 2;
    const W = S * 0.25, H = S * 0.36; // 骨架略放大：把灯焰完整包进笼身
    // 圆笼灯笼身
    const body = ctx.createRadialGradient(cx, cy, 0, cx, cy, W);
    body.addColorStop(0, "rgba(255,238,192,0.98)");
    body.addColorStop(0.55, "rgba(248,190,110,0.98)");
    body.addColorStop(1, "rgba(208,124,54,0.98)");
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(cx - W, cy - H * 0.8);
    ctx.quadraticCurveTo(cx - W * 1.35, cy, cx - W, cy + H * 0.8);
    ctx.quadraticCurveTo(cx, cy + H, cx + W, cy + H * 0.8);
    ctx.quadraticCurveTo(cx + W * 1.35, cy, cx + W, cy - H * 0.8);
    ctx.quadraticCurveTo(cx, cy - H, cx - W, cy - H * 0.8);
    ctx.closePath();
    ctx.fill();
    // 纵向肋
    ctx.strokeStyle = "rgba(140,68,18,0.30)";
    ctx.lineWidth = S * 0.008;
    for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(cx + i * W * 0.4, cy - H * 0.78);
        ctx.quadraticCurveTo(cx + i * W * 0.52, cy, cx + i * W * 0.4, cy + H * 0.78);
        ctx.stroke();
    }
    // 横箍
    ctx.strokeStyle = "rgba(200,120,52,0.6)";
    ctx.lineWidth = S * 0.012;
    for (const t of [-0.5, 0, 0.5]) {
        ctx.beginPath();
        const y = cy + t * H * 0.9;
        ctx.moveTo(cx - W * 1.04, y);
        ctx.quadraticCurveTo(cx, y + H * 0.16, cx + W * 1.04, y);
        ctx.stroke();
    }
    // 上下盖
    ctx.fillStyle = "rgba(176,100,40,0.98)";
    ctx.beginPath();
    ctx.ellipse(cx, cy - H * 0.90, W * 0.9, S * 0.05, 0, 0, Math.PI * 2);
    ctx.ellipse(cx, cy + H * 0.90, W * 0.9, S * 0.05, 0, 0, Math.PI * 2);
    ctx.fill();
    // 火焰
    const fg = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 0.08);
    fg.addColorStop(0, "rgba(255,251,232,1)");
    fg.addColorStop(0.5, "rgba(255,228,152,0.95)");
    fg.addColorStop(1, "rgba(255,178,80,0)");
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.arc(cx, cy, S * 0.08, 0, Math.PI * 2);
    ctx.fill();
    const tip = ctx.createLinearGradient(0, cy - S * 0.075, 0, cy + S * 0.02);
    tip.addColorStop(0, "rgba(255,252,238,0.95)");
    tip.addColorStop(1, "rgba(255,196,96,0)");
    ctx.fillStyle = tip;
    ctx.beginPath();
    ctx.ellipse(cx, cy, S * 0.026, S * 0.05, 0, 0, Math.PI * 2);
    ctx.fill();
}

function buildSprites(): string[] {
    const c = document.createElement("canvas");
    c.width = SPRITE_SIZE;
    c.height = SPRITE_SIZE;
    const s = c.getContext("2d");
    if (!s) return [];
    const S = SPRITE_SIZE;
    s.clearRect(0, 0, S, S);
    drawLotus(s, S);
    const a = c.toDataURL("image/png");
    s.clearRect(0, 0, S, S);
    drawOct(s, S);
    const b = c.toDataURL("image/png");
    s.clearRect(0, 0, S, S);
    drawDrum(s, S);
    return [a, b, c.toDataURL("image/png")];
}

/* ------------------------- 场景参数 ------------------------- */

/* 月相：按上海时区日期计算（2000-01-06 18:14 UTC 为已知新月），
   返回明暗交界圆心的偏移量 e（以月盘半径为单位）与亮面占比 k。
   年龄 age∈[0,1)：0 新月 / 0.25 上弦 / 0.5 满月 / 0.75 下弦 */
const moonPhase = () => {
    const K0 = Date.UTC(2000, 0, 6, 18, 14);
    const t = (Date.now() + 8 * 3600e3 - K0) / 86400000; // 折算到上海时区
    const age = ((t / 29.53058867) % 1 + 1) % 1;
    const dark = (1 + Math.cos(2 * Math.PI * age)) / 2; // 暗面占比
    let th = Math.acos(1 - dark) * 1.55; // 初值，Newton 求解 2θ−sin2θ = π·dark
    for (let i = 0; i < 8; i++) {
        const f = 2 * th - Math.sin(2 * th) - Math.PI * dark;
        const fp = 2 - 2 * Math.cos(2 * th);
        if (Math.abs(fp) < 1e-9) break;
        th = Math.max(0, Math.min(Math.PI / 2, th - f / fp));
    }
    return { age, k: 1 - dark, e: 2 * Math.cos(th) };
};

// 月面暗斑（静海/澄海系），坐标系为月盘归一化 [-1,1]：[cx, cy, rx, ry]
const MARIA: [number, number, number, number][] = [
    [-0.16, -0.05, 0.26, 0.2],
    [0.18, 0.22, 0.2, 0.15],
    [-0.05, 0.3, 0.14, 0.11],
    [0.3, -0.12, 0.14, 0.1],
    [-0.3, 0.18, 0.11, 0.08],
];
// 环形山：[cx, cy, r]（归一化坐标），暗坑 + 迎光侧亮缘
const CRATERS: [number, number, number][] = [
    [0.22, 0.05, 0.055],
    [-0.12, 0.32, 0.045],
    [0.4, -0.18, 0.035],
    [-0.42, -0.24, 0.05],
    [0.05, -0.42, 0.03],
    [-0.28, -0.02, 0.03],
];

interface LanternMeta {
    id: number;
    v: number;
    u: number;
    d: number; // 世界景深 0..1：0=远山方向，1=眼前
    w: number;
    sway: number;
    hue: number;
    bright: number;
    oX: number; // 碰撞位移（屏幕像素，随时间衰减）
    oY: number;
    rip: number; // 涟漪倒计时（秒）：每灯独立随机触发，避免全场同时泛起
    ripT: number; // 当前一轮涟漪的进行时间（秒），-1 = 无涟漪进行中
}

interface Amb {
    stars: { x: number; y: number; r: number; tw: number; ph: number; warm: boolean; fl: boolean }[];
    streaks: { u: number; d: number; spd: number; ph: number; len: number; warm: boolean }[];
    glints: { u: number; d: number; ph: number; spd: number; warm: boolean; br: number }[];
    bands: { d0: number; wd: number; spd: number; ph: number }[];
    fireflies: { u: number; d: number; ph: number; flap: number }[];
    skyGlows: { x: number; y: number; spd: number; ph: number }[];
    mountain: Path2D; // 远山剪影（base 坐标系），用于遮挡动态星星/流星
    skyClip: Path2D; // 全屏矩形挖去山体（evenodd），动态天空元素只画在山体之外
    shoot: { t: number; x0: number; y0: number; dx: number; dy: number } | null;
    shootAt: number;
    now: number;
}

let amb: Amb | null = null;

/* 月亮几何（组件内多处共享：绘制与星光避让用同一份常量） */
const MOON = { x: 0.7, y: 0.16, r: 0.062 } as const;

/* ------------------------- 组件 ------------------------- */

export default function RiverBoard() {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const layerRef = useRef<HTMLDivElement | null>(null);
    const metaRef = useRef<LanternMeta[]>([]);
    const nodesRef = useRef<Map<number, HTMLDivElement | null>>(new Map());
    const viewRef = useRef({ w: 0, h: 0, yH: 0, dpr: 1, reduced: false });
    const mouseRef = useRef({ x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 });
    const touchRef = useRef(false);

    const [sprites] = useState<string[]>(buildSprites);
    const [lanterns, setLanterns] = useState<Wish[]>([]);
    const [ready, setReady] = useState(false);
    const [modal, setModal] = useState<Wish | null>(null); // 正中弹窗内的心愿

    /* 布局：视口与投影常量 */
    const layout = (w: number, h: number) => {
        const v = viewRef.current;
        v.w = w;
        v.h = h;
        v.yH = h * 0.33;
    };

    const riverX = (u: number, d: number) => {
        const v = viewRef.current;
        const bend = Math.sin(0.6 + d * 2.2);
        const c = v.w * (0.51 + 0.045 * bend);
        const hw = v.w * (0.085 + d * d * 0.95); // 远处收窄、近处展开（第 11 轮回拢：河道两侧露出，河灯可散布全河宽）
        return c + (u - 0.5) * 2 * hw;
    };
    const riverY = (d: number) => {
        const v = viewRef.current;
        // d 可能因重生为负数：pow 负数小数次幂是 NaN，会传染整帧绘制
        return v.yH + (v.h * 1.06 - v.yH) * Math.pow(Math.max(0, d), 1.42);
    };

    /* 灯笼像素坐标（与 DOM 写入完全同源：视差+晃摆+碰撞位移一次算齐，
       涟漪与灯笼本体再不会错位） */
    const lanternXY = (m: LanternMeta) => {
        const px = (mouseRef.current.x - 0.5) * 10;
        const d = Math.max(0, m.d);
        const bobY = Math.sin(amb!.now * 1.2 + m.sway) * 1.6 * (0.3 + d);
        return {
            x: riverX(m.u + Math.sin(amb!.now * 0.2 + m.sway) * 0.012, d) - px * 0.28 + m.oX,
            y: riverY(d) - bobY + m.oY,
        };
    };

    /* 场景初始化 */
    const buildAmb = () => {
        const v = viewRef.current;
        const dens = Math.min(1, Math.max(0.45, (v.w * v.h) / (1440 * 900)));
        const stars: Amb["stars"] = [];
        const nStar = Math.round(330 * dens);
        for (let i = 0; i < nStar; i++) {
            stars.push({
                x: Math.random(),
                y: Math.pow(Math.random(), 1.35) * 0.34,
                r: 0.4 + Math.random() * 1.4,
                tw: 0.6 + Math.random() * 2.4,
                ph: Math.random() * Math.PI * 2,
                warm: Math.random() < 0.14,
                fl: Math.random() < 0.1 && Math.random() > 0.02,
            });
        }
        const streaks: Amb["streaks"] = [];
        const nStreak = Math.round(170 * dens);
        for (let i = 0; i < nStreak; i++) {
            streaks.push({
                u: Math.pow(Math.random(), 1.3) * 0.92 + 0.04,
                d: Math.random(),
                spd: 0.6 + Math.random() * 1.6,
                ph: Math.random() * Math.PI * 2,
                len: 0.5 + Math.random() * 1.5,
                warm: Math.random() < 0.22,
            });
        }
        const glints: Amb["glints"] = [];
        const nGlint = Math.round(140 * dens);
        for (let i = 0; i < nGlint; i++) {
            glints.push({
                u: Math.pow(Math.random(), 1.25) * 0.9 + 0.05,
                d: Math.random(),
                ph: Math.random() * Math.PI * 2,
                spd: 0.7 + Math.random() * 1.8,
                warm: Math.random() < 0.35,
                br: 0.4 + Math.random() * 0.6,
            });
        }
        const bands: Amb["bands"] = [];
        for (let i = 0; i < 9; i++) {
            bands.push({
                d0: i / 9 + Math.random() * 0.03,
                wd: 0.012 + Math.random() * 0.03,
                spd: 0.05 + Math.random() * 0.06,
                ph: Math.random() * Math.PI * 2,
            });
        }
        // 宽幅水光带（缓慢漂移的整体明暗起伏）
        for (let i = 0; i < 3; i++) {
            bands.push({
                d0: 0.05 + Math.random() * 0.3,
                wd: 0.06 + Math.random() * 0.07,
                spd: 0.028 + Math.random() * 0.03,
                ph: Math.random() * Math.PI * 2,
            });
        }
        const fireflies: Amb["fireflies"] = [];
        const nFf = Math.round(17 * dens);
        for (let i = 0; i < nFf; i++) {
            fireflies.push({
                // 全部分布在河道上方：u 横跨河面，d 随深度（远处少、近处密）
                u: 0.05 + Math.random() * 0.9,
                d: 0.05 + Math.pow(Math.random(), 1.5) * 0.6,
                ph: Math.random() * Math.PI * 2,
                flap: 1.4 + Math.random() * 2.4,
            });
        }
        const skyGlows: Amb["skyGlows"] = [];
        const nGlow = Math.round(3 * dens) + 1;
        for (let i = 0; i < nGlow; i++) {
            skyGlows.push({
                x: 0.15 + Math.random() * 0.7,
                y: 0.55 + Math.random() * 0.2,
                spd: 0.012 + Math.random() * 0.015,
                ph: Math.random() * Math.PI * 2,
            });
        }
        amb = {
            stars, streaks, glints, bands, fireflies, skyGlows,
            mountain: new Path2D(), skyClip: new Path2D(),
            shoot: null, shootAt: 4 + Math.random() * 5, now: 0,
        };
    };

    const respawnStreak = (s: Amb["streaks"][number]) => {
        // 上游流向：从眼前（近端）出发，流向远山消散
        s.d = 0.9 + Math.random() * 0.08;
        s.u = Math.pow(Math.random(), 1.3) * 0.92 + 0.04;
        s.ph = Math.random() * Math.PI * 2;
        s.warm = Math.random() < 0.22;
    };

    /* 河流路径辅助（水里所有动态物件都画在它内部） */
    const traceRiver = (ctx: CanvasRenderingContext2D, dFrom: number, dTo: number, easeUDepth: boolean) => {
        const N = 46;
        const yF = riverY(dFrom), yT = riverY(dTo);
        ctx.beginPath();
        if (yF <= yT) {
            ctx.moveTo(riverX(0, dFrom), yF);
            for (let i = 1; i <= N; i++) {
                const d = dFrom + (dTo - dFrom) * (easeUDepth ? i / N : i / N);
                ctx.lineTo(riverX(0, d), riverY(d));
            }
            for (let i = N; i >= 0; i--) {
                const d = dFrom + (dTo - dFrom) * (i / N);
                ctx.lineTo(riverX(1, d), riverY(d));
            }
        } else {
            ctx.moveTo(riverX(0, dFrom), yF);
            for (let i = 1; i <= N; i++) {
                const d = dFrom + (dTo - dFrom) * (i / N);
                ctx.lineTo(riverX(0, d), riverY(d));
            }
            for (let i = N; i >= 0; i--) {
                const d = dFrom + (dTo - dFrom) * (i / N);
                ctx.lineTo(riverX(1, d), riverY(d));
            }
        }
        ctx.closePath();
    };

    /* ════════════════════════════════════════════════════════════
       分层渲染（DPR 修正）
       baseBack / baseFront：静态层，仅窗口变化时重绘一次
         baseBack  ：夜空、星辰、月、云影、远山、河水底色、河心天光带
         baseFront ：两岸剪影、苇丛、前景草、垂柳、近景水汽
       drawScene  ：逐帧动态层（宽幅水光带、月光碎影、流向纹、碎光点、
                     星光闪烁、萤火虫、孔明灯、流星）
       ──────────────────────────────────────────────────────────── */

    const MARGIN = 40; // 静态层出血边，给鼠标视差留位移余地

    /* ---- 静态层（背景） ---- */
    const renderBase = (
        backCv: HTMLCanvasElement,
        frontCv: HTMLCanvasElement
    ) => {
        const a = amb;
        if (!a) return;
        const back = backCv.getContext("2d")!;
        const front = frontCv.getContext("2d")!;
        const v = viewRef.current;
        const { w, h } = v;
        const prep = (ctx: CanvasRenderingContext2D) => {
            ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
            ctx.translate(MARGIN, MARGIN);
            ctx.clearRect(-MARGIN, -MARGIN, w + MARGIN * 2, h + MARGIN * 2);
        };
        const draw = (ctx: CanvasRenderingContext2D) => {

            // 夜空
            const sky = ctx.createLinearGradient(0, 0, 0, v.yH * 1.25);
            sky.addColorStop(0, "#02040c");
            sky.addColorStop(0.42, "#081029");
            sky.addColorStop(0.78, "#101a3c");
            sky.addColorStop(1, "#1c2450");
            ctx.fillStyle = sky;
            ctx.fillRect(-MARGIN, -MARGIN, w + MARGIN * 2, v.yH * 1.25 + MARGIN * 2);

            // 星辰（静态基色）
            for (const st of a.stars) {
                ctx.fillStyle = st.warm ? "rgba(255,236,205,0.62)" : "rgba(214,228,255,0.68)";
                ctx.beginPath();
                ctx.arc(st.x * w, st.y * h, st.r, 0, Math.PI * 2);
                ctx.fill();
            }

            // 月亮：真实月相（球面光照，无圆盘轮廓——暗面完全透明不画出）
            // 光方向绕盘面左右旋转：β=0 满月（正面照），β=±π/2 上下弦（侧照），
            // 盈月亮面在右、亏月亮面在左（北半球可见月相），β=±π 新月（背照）
            const mxMoon = w * MOON.x;
            const myMoon = h * MOON.y;
            const ph = moonPhase();
            const haloK = 0.35 + 0.65 * ph.k; // 新月时几乎无光晕
            const halo = ctx.createRadialGradient(mxMoon, myMoon, 0, mxMoon, myMoon, w * 0.34);
            halo.addColorStop(0, `rgba(255,238,200,${0.34 * haloK})`);
            halo.addColorStop(0.28, `rgba(255,226,170,${0.12 * haloK})`);
            halo.addColorStop(1, "rgba(255,226,170,0)");
            ctx.fillStyle = halo;
            ctx.fillRect(mxMoon - w * 0.36, myMoon - w * 0.36, w * 0.72, w * 0.72);
            const rMoon = Math.min(w, h) * MOON.r;
            const rD = rMoon * 0.82;
            const P = Math.max(8, Math.ceil(rD * 2 * v.dpr * 2));
            const R = P / 2;
            const mc = document.createElement("canvas");
            mc.width = mc.height = P;
            const mg = mc.getContext("2d")!;
            const img = mg.createImageData(P, P);
            const beta = Math.PI * (1 - 2 * Math.max(0, Math.min(1, ph.age))); // 相位→光照角
            const lInv = 1 / Math.hypot(Math.sin(beta), Math.cos(beta));
            const lx = Math.sin(beta) * lInv, lz = Math.cos(beta) * lInv;
            const data = img.data;
            for (let py = 0; py < P; py++) {
                const ny = (py + 0.5 - R) / R;
                for (let px = 0; px < P; px++) {
                    const nx = (px + 0.5 - R) / R;
                    const q = 1 - nx * nx - ny * ny;
                    const i4 = (py * P + px) * 4;
                    if (q <= 0) continue;
                    const radial = Math.sqrt(1 - q); // 0=月心 1=月缘
                    const nz = Math.sqrt(q);
                    const dot = nx * lx + nz * lz;
                    // —— 明暗（真实月相）：半影带精致过渡 ——
                    // 暗面（dot≤0.02）不再是透明窗：填极暗的月灰（略高于夜空一档），
                    // 月亮整体实心，星星不会透过月面看到
                    if (dot <= 0.02) {
                        data[i4] = 27;
                        data[i4 + 1] = 33;
                        data[i4 + 2] = 56;
                        data[i4 + 3] = 255;
                        continue;
                    }
                    // t 归一化受光强度（0=明暗界 1=最亮），指数让亮面更饱满
                    let b = Math.pow(Math.max(0, (dot - 0.02) / 0.96), 0.9);
                    // 边缘暗化（月面边缘微微变暗，不突兀）＋ 受光侧微热
                    b *= 1 - 0.26 * Math.pow(radial, 2.6);
                    b *= 1 + 0.10 * dot * dot;
                    // 月海（静海/澄海/湿海等大块暗斑，柔边）
                    for (const [cx, cy, rx, ry] of MARIA) {
                        const dx = nx - cx, dy = ny - cy;
                        const d2 = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
                        if (d2 < 1) b *= 1 - 0.5 * (1 - d2) * 0.5;
                    }
                    // 环形山：暗坑 + 受光侧亮缘
                    for (const [cxc, cyc, rc] of CRATERS) {
                        const dx = nx - cxc, dy = ny - cyc;
                        const d2 = (dx * dx + dy * dy) / (rc * rc);
                        if (d2 < 1) {
                            const inner = 1 - d2;
                            b *= 1 - 0.30 * inner; // 坑底变暗
                            if (d2 > 0.55 && dx * lx > 0) b *= 1 + 0.14 * inner; // 迎光壁更亮
                        }
                    }
                    // 表面颗粒噪声（沿光方向的高地纹理，确定性哈希）
                    const hsh = Math.abs(Math.sin(nx * 21.7 + ny * 9.3) * 43758.53);
                    b *= 0.965 + 0.035 * (hsh - Math.floor(hsh));
                    // 月面完全不透明（实心遮挡后方星空）；月缘不再做 alpha 渐变
                    const a = Math.round(b * 255);
                    if (a <= 0) continue;
                    // 受光处偏暖、暗部偏冷灰
                    data[i4] = Math.round((252 - (1 - b) * 56) + 6 * Math.max(0, dot));
                    data[i4 + 1] = Math.round(249 - (1 - b) * 62);
                    data[i4 + 2] = Math.round(230 - (1 - b) * 82);
                    data[i4 + 3] = a;
                }
            }
            mg.putImageData(img, 0, 0);
            back.drawImage(mc, mxMoon - rD, myMoon - rD, rD * 2, rD * 2);

            // 云影（静态，随视差层缓慢移动）
            ctx.fillStyle = "rgba(24,32,60,0.10)";
            for (let c = 0; c < 3; c++) {
                const cx = ((c * 431) % (w + 500)) * 0.6 + w * 0.1 + c * 120;
                const cy = h * (0.08 + c * 0.09);
                for (let b = 0; b < 5; b++) {
                    const bx = cx + Math.sin(c * 7.3 + b * 1.9) * 90;
                    const by = cy + Math.cos(c * 5.1 + b * 2.7) * 22;
                    const br = 60 + b * 26;
                    const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
                    g.addColorStop(0, "rgba(23,31,58,0.10)");
                    g.addColorStop(1, "rgba(23,31,58,0)");
                    ctx.fillStyle = g;
                    ctx.beginPath();
                    ctx.arc(bx, by, br, 0, Math.PI * 2);
                    ctx.fill();
                }
            }

            // 远山三层（纯剪影填充——不再画顶部波浪描边线，山体就是实的山）
            const ridge = (base: number, seed: number, amp: number, c1: string) => {
                ctx.beginPath();
                ctx.moveTo(-MARGIN - 20, h + MARGIN);
                ctx.lineTo(-MARGIN - 20, base);
                for (let x = -MARGIN - 20; x <= w + MARGIN + 20; x += 9) {
                    ctx.lineTo(
                        x,
                        base +
                            Math.sin(x * 0.0042 + seed) * amp * 1.2 +
                            Math.sin(x * 0.011 + seed * 2.7) * amp * 0.7 +
                            Math.sin(x * 0.023 + seed * 5.1) * amp * 0.28
                    );
                }
                ctx.lineTo(w + MARGIN + 20, h + MARGIN);
                ctx.closePath();
                ctx.fillStyle = c1;
                ctx.fill();
                // 同步把最前山层轮廓累积进遮罩 path（用于遮挡动态星星/流星）
                if (c1 === "#050a18") {
                    for (let x = -MARGIN - 20; x <= w + MARGIN + 20; x += 9) {
                        const y =
                            base +
                            Math.sin(x * 0.0042 + seed) * amp * 1.2 +
                            Math.sin(x * 0.011 + seed * 2.7) * amp * 0.7 +
                            Math.sin(x * 0.023 + seed * 5.1) * amp * 0.28;
                        x === -MARGIN - 20 ? skyPath.moveTo(x, y) : skyPath.lineTo(x, y);
                    }
                    skyPath.lineTo(w + MARGIN + 20, h + MARGIN);
                    skyPath.lineTo(-MARGIN - 20, h + MARGIN);
                    skyPath.closePath();
                }
            };
            ridge(v.yH * 0.82, 3.1, h * 0.045, "#0b1230");
            ridge(v.yH * 0.92, 8.7, h * 0.062, "#070d22");
            ridge(v.yH * 0.97, 1.7, h * 0.05, "#050a18");

            // 河水底色 + 河心天光带
            const riverBase = ctx.createLinearGradient(0, v.yH, 0, h);
            riverBase.addColorStop(0, "#1a2350");
            riverBase.addColorStop(0.3, "#0e1734");
            riverBase.addColorStop(0.62, "#080f24");
            riverBase.addColorStop(1, "#040818");
            traceRiver(ctx, 0, 1.14, false);
            ctx.fillStyle = riverBase;
            ctx.fill();
            traceRiver(ctx, 0, 1.14, false);
            ctx.save();
            ctx.clip();
            const heart = ctx.createLinearGradient(0, v.yH * 0.98, 0, h);
            heart.addColorStop(0, "rgba(150,180,255,0.19)");
            heart.addColorStop(0.45, "rgba(120,150,235,0.09)");
            heart.addColorStop(1, "rgba(90,120,210,0.03)");
            traceRiver(ctx, 0, 1.14, false);
            ctx.fillStyle = heart;
            ctx.fill();
            ctx.restore();

            // 岸线内侧柔光带：水面贴着两岸有一层青色微光，岸线不再生硬
            for (const [edge, side] of [
                [0, 1],
                [1, -1],
            ] as const) {
                for (let i = 0; i < 7; i++) {
                    const u0 = i / 7;
                    ctx.beginPath();
                    for (let s = 0; s <= 30; s++) {
                        const d = (s / 30) * 1.16;
                        ctx.lineTo(riverX(edge + side * u0 * 0.035, d), riverY(d));
                    }
                    for (let s = 30; s >= 0; s--) {
                        const d = (s / 30) * 1.16;
                        ctx.lineTo(riverX(edge + side * ((u0 + 1) / 7) * 0.035, d), riverY(d));
                    }
                    ctx.closePath();
                    const al = (1 - u0) * 0.10 + 0.02;
                    ctx.fillStyle = `rgba(${side > 0 ? "155,185,255" : "150,180,250"},${al.toFixed(3)})`;
                    ctx.fill();
                }
            }
        };

        prep(back);
        const skyPath = new Path2D(); // 由最前山层轮廓累积；随后转换进 amb 山体遮罩
        draw(back);
        if (amb) {
            const mountain = new Path2D();
            mountain.addPath(skyPath);
            amb.skyClip = new Path2D();
            amb.skyClip.rect(-MARGIN - 120, -MARGIN - 120, w + MARGIN * 2 + 240, h + MARGIN * 2 + 240);
            amb.skyClip.addPath(mountain);
            amb.mountain = mountain;
        }

        prep(front);
        front.drawImage(backCv, -MARGIN, -MARGIN, w + MARGIN * 2, h + MARGIN * 2);
        // 前层打底：河流两侧不再铺大块暗坡——整幅夜色水面渐变（水天一色延伸），
        // 河道由 backCv 的 riverBase 提亮出明暗层次，弧线边缘微光勾勒河道边界
        const shoreGrad = front.createLinearGradient(0, v.yH - 4, 0, h + 40);
        shoreGrad.addColorStop(0, "#0a132c");
        shoreGrad.addColorStop(0.55, "#061022");
        shoreGrad.addColorStop(1, "#040918");
        front.fillStyle = shoreGrad;
        front.fillRect(-MARGIN - 8, v.yH - 4, w + MARGIN * 2 + 16, h + 44);

        // 垂柳（右上空枝，加粗加密保证剪影清晰可见）
        front.strokeStyle = "#01030a";
        for (let s = 0; s < 7; s++) {
            const tx = w * 0.985 + s * 13;
            const ty = h * 0.05 + s * 24;
            front.lineWidth = 10 - s * 1.3;
            front.beginPath();
            front.moveTo(w * 0.985, h * 0.02);
            front.quadraticCurveTo(w * 0.985 + 18, h * 0.05 + 40, tx, ty);
            front.stroke();
        }
        front.lineWidth = 1.7;
        for (let s = 0; s < 9; s++) {
            const bx = w * 0.985 + s * 11;
            const by = h * 0.02 + s * 18 + 12;
            const hang = h * 0.52 * (0.55 + (s % 3) * 0.18);
            front.beginPath();
            front.moveTo(bx, by);
            front.quadraticCurveTo(bx - 6, by + hang * 0.5, bx - 12, by + hang);
            front.stroke();
            for (let l = 0; l < 5; l++) {
                const lt = l / 4;
                const lx = bx - 6 * 2 * lt - 6 * lt;
                const ly = by + hang * (lt * 0.85 + 0.15);
                front.save();
                front.translate(lx, ly);
                front.rotate(0.9);
                front.fillStyle = "rgba(4,8,16,0.85)";
                front.beginPath();
                front.ellipse(0, 0, 7, 2.2, 0, 0, Math.PI * 2);
                front.fill();
                front.restore();
            }
        }

        // 岸边垂柳（左岸中景 / 右岸中景，多株增加层次）
        const willow = (x: number, y: number, k: number, dir: number) => {
            front.strokeStyle = "#02050c";
            for (let s = 0; s < 5; s++) {
                front.lineWidth = (7 - s * 1.2) * k;
                front.beginPath();
                front.moveTo(x - dir * 30 * k, y + 8 * k);
                front.quadraticCurveTo(x - dir * 42 * k, y - 30 * k, x + dir * (s * 16 - 30) * k, y - (24 + s * 16) * k);
                front.stroke();
            }
            front.lineWidth = 1.3 * k;
            for (let s = 0; s < 6; s++) {
                const bx = x + dir * (s * 15 - 24) * k;
                const by = y - (18 + s * 12) * k;
                const hang = (58 + (s % 3) * 24) * k;
                front.beginPath();
                front.moveTo(bx, by);
                front.quadraticCurveTo(bx - dir * 4 * k, by + hang * 0.5, bx - dir * 9 * k, by + hang);
                front.stroke();
                for (let l = 0; l < 4; l++) {
                    const lt = l / 3;
                    const lx = bx - dir * 10 * k * lt;
                    const ly = by + hang * (lt * 0.85 + 0.15);
                    front.save();
                    front.translate(lx, ly);
                    front.rotate(0.9);
                    front.fillStyle = "rgba(4,8,16,0.8)";
                    front.beginPath();
                    front.ellipse(0, 0, 6 * k, 2 * k, 0, 0, Math.PI * 2);
                    front.fill();
                    front.restore();
                }
            }
        };
        // 左岸垂柳已按需求移除（左岸保持干净水面）；右岸保留一株平衡构图
        willow(riverX(1.038, 0.6) + 12, riverY(0.6) - 4, 1.05, -1);

        // 岸畔小亭剪影（右岸中景，飞檐翘角）
        const pkx = riverX(1.05, 0.62);
        const pky = riverY(0.62);
        front.fillStyle = "#03070f";
        front.fillRect(pkx - 40, pky - 6, 80, 9);
        front.fillRect(pkx - 30, pky - 54, 6.5, 48);
        front.fillRect(pkx + 24, pky - 54, 6.5, 48);
        front.beginPath();
        front.moveTo(pkx - 56, pky - 44);
        front.quadraticCurveTo(pkx - 34, pky - 42, pkx - 33, pky - 56);
        front.lineTo(pkx - 13, pky - 80);
        front.quadraticCurveTo(pkx, pky - 87, pkx + 13, pky - 80);
        front.lineTo(pkx + 33, pky - 56);
        front.quadraticCurveTo(pkx + 34, pky - 42, pkx + 56, pky - 44);
        front.closePath();
        front.fill();
        front.fillStyle = "#050a18";
        front.fillRect(pkx + 13, pky - 78, 3.5, 22);
        front.beginPath();
        front.arc(pkx + 14.75, pky - 86, 4.5, 0, Math.PI * 2);
        front.fill();

        // 近景水汽（横雾）
        for (const [base, amp, al] of [
            [v.yH * 0.98, 16, 0.11],
            [v.yH * 1.02, 30, 0.08],
        ] as const) {
            const fog = front.createLinearGradient(0, base - amp, 0, base + amp);
            fog.addColorStop(0, "rgba(120,150,220,0)");
            fog.addColorStop(0.5, `rgba(120,150,220,${al})`);
            fog.addColorStop(1, "rgba(120,150,220,0)");
            front.fillStyle = fog;
            front.fillRect(-MARGIN, base - amp, w + MARGIN * 2, amp * 2);
        }
    };

    /* ---- 逐帧动态层 ---- */
    const drawScene = (ctx: CanvasRenderingContext2D, t: number, reduce: boolean, baseBack: HTMLCanvasElement, baseFront: HTMLCanvasElement) => {
        if (!amb) return;
        const v = viewRef.current;
        const { w, h } = v;
        const px = (mouseRef.current.x - 0.5) * 26;
        const py = (mouseRef.current.y - 0.5) * 14;
        if (reduce) {
            mouseRef.current.x = 0.5;
            mouseRef.current.y = 0.5;
        }
        ctx.clearRect(0, 0, w, h);

        // 静态层合成（带视差）
        ctx.drawImage(baseBack, px * 0.2 - MARGIN, py * 0.1 - MARGIN, w + MARGIN * 2, h + MARGIN * 2);
        ctx.drawImage(baseFront, px * 0.42 - MARGIN, py * 0.2 - MARGIN, w + MARGIN * 2, h + MARGIN * 2);

        // 水面动态（河流裁剪区内）
        ctx.save();
        traceRiver(ctx, 0, 1.14, false);
        ctx.clip();

        // 宽幅水光带（随流向向远方缓慢漂移的整体明暗，羽化边避免块状感）
        for (const bd of amb.bands) {
            bd.d0 -= bd.wd * 0.7 * (reduce ? 0.15 : 1) * 0.022;
            if (bd.d0 + bd.wd < -0.05) bd.d0 = 0.96 + Math.random() * 0.04;
            const dTop = bd.d0, dBot = bd.d0 + bd.wd;
            const yT = riverY(dTop), yB = riverY(dBot);
            if (yB < v.yH - 4) continue;
            if (yT > h + 30) continue;
            const N = 22;
            const wobAmp = 0.011 * (0.4 + 0.6 * bd.wd * 4);
            ctx.beginPath();
            for (let i = 0; i <= N; i++) {
                const u = i / N;
                const wob = Math.sin(u * 7.4 + t * 0.5 * (reduce ? 0.2 : 1) + bd.ph) * wobAmp;
                ctx.lineTo(riverX(u, Math.min(1.09, dTop + wob * 0.3)), riverY(dTop + wob));
            }
            for (let i = N; i >= 0; i--) {
                const u = i / N;
                ctx.lineTo(riverX(u, dBot), riverY(dBot));
            }
            ctx.closePath();
            const g = ctx.createLinearGradient(0, yT, 0, yB);
            const balpha = bd.wd > 0.05 ? 0.05 : 0.036;
            g.addColorStop(0, "rgba(150,178,240,0)");
            g.addColorStop(0.3, `rgba(150,178,240,${balpha * 0.7})`);
            g.addColorStop(0.5, `rgba(150,178,240,${balpha})`);
            g.addColorStop(0.7, `rgba(150,178,240,${balpha * 0.7})`);
            g.addColorStop(1, "rgba(150,178,240,0)");
            ctx.fillStyle = g;
            ctx.fill();
        }

        // 月光倒影（电影级）：月亮正下方投下的纵向光柱——扇形展开、边缘随水波
        // 呼吸，河岸外被外层河流 clip 裁掉；水面细碎光斑呈纵向光丝顺流向散落，
        // 不再是一排整齐的交替横线
        const shaftX = w * MOON.x;
        const Ns = 30;
        const shaftBot = h * 0.98;
        // 主体光柱（扇形，近端更宽）
        const shaft = ctx.createLinearGradient(0, v.yH, 0, h);
        shaft.addColorStop(0, "rgba(255,226,170,0)");
        shaft.addColorStop(0.32, "rgba(255,230,180,0.22)");
        shaft.addColorStop(0.68, "rgba(255,228,172,0.14)");
        shaft.addColorStop(1, "rgba(255,220,160,0)");
        ctx.beginPath();
        ctx.moveTo(shaftX, v.yH - 2);
        for (let i = 1; i <= Ns; i++) {
            const k = i / Ns;
            const y = v.yH + (shaftBot - v.yH) * k;
            const half =
                w * (0.009 + 0.085 * Math.pow(k, 1.9)) *
                (1 + 0.07 * Math.sin(t * 0.6 + i * 2.7) * Math.sin(i * 5.3 + 1.1));
            ctx.lineTo(shaftX + half, y);
        }
        for (let i = Ns; i >= 1; i--) {
            const k = i / Ns;
            const y = v.yH + (shaftBot - v.yH) * k;
            const half =
                w * (0.009 + 0.085 * Math.pow(k, 1.9)) *
                (1 + 0.07 * Math.sin(t * 0.6 + i * 2.7) * Math.sin(i * 5.3 + 1.1));
            ctx.lineTo(shaftX - half, y);
        }
        ctx.closePath();
        ctx.fillStyle = shaft;
        ctx.fill();
        // 核心亮带（光柱最亮的中轴，略窄）
        const core = ctx.createLinearGradient(0, v.yH, 0, shaftBot);
        core.addColorStop(0, "rgba(255,240,205,0.08)");
        core.addColorStop(0.55, "rgba(255,242,210,0.20)");
        core.addColorStop(1, "rgba(255,235,190,0)");
        ctx.beginPath();
        ctx.moveTo(shaftX, v.yH - 2);
        for (let i = 1; i <= Ns; i++) {
            const k = i / Ns;
            const y = v.yH + (shaftBot - v.yH) * k;
            const half = w * (0.004 + 0.026 * Math.pow(k, 2.1));
            ctx.lineTo(shaftX + half, y);
        }
        for (let i = Ns; i >= 1; i--) {
            const k = i / Ns;
            const y = v.yH + (shaftBot - v.yH) * k;
            const half = w * (0.004 + 0.026 * Math.pow(k, 2.1));
            ctx.lineTo(shaftX - half, y);
        }
        ctx.closePath();
        ctx.fillStyle = core;
        ctx.fill();
        // 光柱内细碎光丝（纵向短丝顺流向，独立闪烁，不做整齐横排）
        for (let i = 0; i < 54; i++) {
            const k = Math.pow(Math.random(), 1.35);
            const y = v.yH + (shaftBot - v.yH) * k;
            const half = w * (0.012 + 0.07 * Math.pow(k, 1.85));
            const x = shaftX + (Math.random() * 2 - 1) * half;
            const a =
                (0.05 + 0.17 * Math.pow(Math.random(), 2)) *
                (0.45 + 0.55 * Math.sin(t * (1.4 + Math.random() * 1.6) + i * 9.1));
            if (a < 0.03) continue;
            ctx.strokeStyle = `rgba(255,234,190,${a})`;
            ctx.lineWidth = 0.7 + Math.random() * 1.1;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x, y - (2 + Math.random() * 7) * (0.4 + k * 0.9));
            ctx.stroke();
        }

        // 流向纹（顺流向的线性亮纹：自眼前出发，向远山方向流动消散）
        for (const s of amb.streaks) {
            s.d -= (0.06 + s.d * s.d * 0.62) * s.spd * 0.016 * (reduce ? 0.12 : 1);
            if (s.d < -0.04) respawnStreak(s);
            const dHead = Math.max(-0.02, s.d);
            const len = (0.02 + 0.11 * dHead * dHead) * s.len;
            const dTail = Math.min(1.02, dHead + len);
            const yH0 = riverY(dHead), yTl = riverY(dTail);
            if (yH0 < v.yH - 6 || yTl > h + 40) continue;
            const xH = riverX(s.u, dHead), xT = riverX(s.u, dTail);
            const midU = s.u + Math.sin(t * 0.9 + s.ph) * 0.006;
            const xm = riverX(midU, (dHead + dTail) / 2);
            const alpha = (0.05 + 0.072 * dHead) * (0.6 + 0.4 * Math.sin(t * 1.7 + s.ph));
            ctx.strokeStyle = s.warm
                ? `rgba(255,216,164,${Math.min(0.4, alpha * 1.15)})`
                : `rgba(198,216,255,${alpha * (dHead > 0.5 ? 0.85 : 1)})`;
            ctx.lineWidth = 0.7 + dHead * 2.2;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(xT, yTl);
            ctx.quadraticCurveTo(xm, (yH0 + yTl) / 2, xH, yH0);
            ctx.stroke();
        }

        // 波面碎光点（随流向向远方游动）
        for (const g of amb.glints) {
            g.d -= (0.06 + g.d * g.d * 0.62) * g.spd * 0.016 * (reduce ? 0.12 : 1);
            if (g.d < -0.03) {
                g.d = 0.88 + Math.random() * 0.12;
                g.u = Math.pow(Math.random(), 1.25) * 0.9 + 0.05;
            }
            if (g.d < 0) continue;
            const y = riverY(g.d);
            if (y < v.yH - 4 || y > h + 30) continue;
            const x = riverX(g.u, g.d);
            const a = 0.1 + 0.6 * g.br * Math.pow(0.5 + 0.5 * Math.sin(t * 3.1 + g.ph * 3.7), 3);
            if (a < 0.07) continue;
            ctx.strokeStyle = g.warm ? `rgba(255,226,172,${a})` : `rgba(205,220,255,${a})`;
            ctx.lineWidth = 0.6 + g.d * 1.4;
            ctx.lineCap = "round";
            const len = 1.0 + g.d * 2.4;
            ctx.beginPath();
            ctx.moveTo(x - len, y);
            ctx.lineTo(x + len, y);
            ctx.stroke();
            if (g.br > 0.8) {
                ctx.fillStyle = g.warm ? `rgba(255,240,205,${a * 0.7})` : `rgba(225,235,255,${a * 0.5})`;
                ctx.beginPath();
                ctx.arc(x, y, 0.7 + g.d, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // 河灯周围的水面涟漪（缓缓扩散的椭圆环）。
        // 显示逻辑：仅 d≥0.28 的灯笼；每灯独立随机倒计时（1.2-3.8s）触发一轮
        // 1.8s 的扩散（半径 12→68px 线性推移，alpha 按 sin(π·t) 渐强渐弱）。
        // 各灯计时独立、起点错开——同一时刻通常有多盏在各自扩散，但绝不全场
        // 齐步同现。近景灯此前"看不出涟漪"是灯体（DOM 精灵 118-130px）比环大
        // 盖住了它；半径随 scl 放大后近灯环正好超出灯体边缘可见。
        for (const m of metaRef.current) {
            if (m.d < 0.28 || m.ripT < 0) continue;
            const ph2 = Math.min(1, m.ripT / 1.8);
            const scl = Math.pow(Math.max(0, m.d), 1.15); // 与 DOM scale 同一缩放
            const rr = (12 + ph2 * 56) * (0.55 + 1.05 * scl);
            const li = lanternXY(m); // 与灯笼 DOM 同源坐标：涟漪以灯笼为中心
            const rx = li.x;
            // 圆笼灯（v=2）灯身最低处在灯笼中心下方 ≈42px·scl：涟漪从笼底溢出；
            // 八角/莲花仍以灯笼中心起始
            const ry = li.y + (m.v === 2 ? 42 * scl : 0) + 6;
            const ra = Math.sin(ph2 * Math.PI) * 0.16 * (0.35 + 0.65 * m.d);
            ctx.strokeStyle = `rgba(205,222,255,${ra})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.ellipse(rx, ry, rr, rr * 0.24, 0, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.restore();

        /* 星光闪烁 + 流星：整体裁剪在山体轮廓之外（星星/流星不再透过山的剪影，
           更不会"砸进"河里——clip 与 base 山体使用同一视差，裁剪随视差同步） */
        ctx.save();
        ctx.translate(px * 0.2, py * 0.1);
        ctx.clip(amb.skyClip, "evenodd");
        ctx.translate(-px * 0.2, -py * 0.1);
        /* 星光闪烁（只有少数亮星动态叠加；月盘内的星略过——月亮实心应遮挡星空） */
        const moonR = Math.min(w, h) * MOON.r * 0.82;
        const moonCX = w * MOON.x, moonCY = h * MOON.y;
        if (!reduce) {
            for (const st of amb.stars) {
                if (!st.fl) continue;
                const tw = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(t * st.tw + st.ph), 2);
                const sx = st.x * w + px * 0.18;
                const sy = st.y * h + py * 0.1;
                const mdx = sx - moonCX, mdy = sy - moonCY;
                if (mdx * mdx + mdy * mdy < moonR * moonR * 1.3) continue;
                if (tw < 0.45) continue;
                ctx.strokeStyle = `rgba(210,226,255,${tw * 0.3})`;
                ctx.lineWidth = 0.8;
                ctx.beginPath();
                ctx.moveTo(sx - st.r * 3.2, sy);
                ctx.lineTo(sx + st.r * 3.2, sy);
                ctx.moveTo(sx, sy - st.r * 3.2);
                ctx.lineTo(sx, sy + st.r * 3.2);
                ctx.stroke();
                ctx.fillStyle = `rgba(225,235,255,${tw * 0.9})`;
                ctx.beginPath();
                ctx.arc(sx, sy, st.r, 0, Math.PI * 2);
                ctx.fill();
            }
            /* 萤火虫（低空逡巡的荧光点）也走山体遮罩：河面上方、山脊之下的
               部分正常显示，落入远山剪影内的被裁掉——山上不再有光点透过 */
            for (const f of amb.fireflies) {
                f.u +=
                    (Math.sin(t * 0.07 + f.ph) * 0.0011 + Math.sin(t * 0.19 + f.ph * 1.7) * 0.0005) *
                    (reduce ? 0.1 : 1);
                f.d -= (Math.sin(t * 0.045 + f.ph * 2.3) * 0.0002 + 0.00004) * (reduce ? 0.1 : 1);
                if (f.u < 0.04) f.u = 0.04;
                if (f.u > 0.96) f.u = 0.96;
                if (f.d < 0.045) f.d = 0.9 + Math.random() * 0.06;
                if (f.d > 0.92) f.d = 0.92;
                const fx = riverX(f.u, f.d) + px * 0.5;
                const fy = riverY(f.d) - 22 - Math.sin(t * 1.3 + f.ph) * 5;
                const fl = 0.35 + 0.65 * Math.abs(Math.sin(t * f.flap + f.ph * 5));
                if (fl < 0.2) continue;
                const grad = ctx.createRadialGradient(fx, fy, 0, fx, fy, 7);
                grad.addColorStop(0, `rgba(236,255,170,${0.85 * fl})`);
                grad.addColorStop(0.5, `rgba(200,236,120,${0.32 * fl})`);
                grad.addColorStop(1, "rgba(180,220,100,0)");
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(fx, fy, 7, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore(); // 山体遮罩作用于星光闪烁与萤火虫；孔明灯在天际更高处，不被裁剪

        /* 孔明灯（远方天际的暖点） */
        for (const g of amb.skyGlows) {
            g.y -= g.spd * 0.004 * (reduce ? 0.05 : 1);
            if (g.y < 0.02) {
                g.y = 0.5 + Math.random() * 0.2;
                g.x = 0.12 + Math.random() * 0.76;
            }
            const gx = g.x * w + Math.sin(t * 0.3 + g.ph) * 8;
            const gy = g.y * h;
            const pulse = 0.5 + 0.5 * Math.sin(t * 0.9 + g.ph);
            const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, 10);
            grad.addColorStop(0, `rgba(255,214,140,${0.16 + 0.1 * pulse})`);
            grad.addColorStop(1, "rgba(255,200,120,0)");
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(gx, gy, 10, 0, Math.PI * 2);
            ctx.fill();
        }

        /* 流星（山体遮罩：只画在山脊之上，不会砸进河里） */
        ctx.save();
        ctx.translate(px * 0.2, py * 0.1);
        ctx.clip(amb.skyClip, "evenodd");
        ctx.translate(-px * 0.2, -py * 0.1);
        if (amb.shoot) {
            if (reduce) {
                amb.shoot = null;
                amb.shootAt = amb.now + 7 + Math.random() * 12;
            } else {
                amb.shoot.t += 0.016;
                if (amb.shoot.t > 1) {
                    amb.shoot = null;
                    amb.shootAt = amb.now + 7 + Math.random() * 12;
                } else {
                    const sh = amb.shoot;
                    const life = Math.min(1, sh.t / 0.18) * Math.min(1, (1 - sh.t) / 0.15);
                    const sx = sh.x0 + sh.dx * sh.t;
                    const sy = sh.y0 + sh.dy * sh.t;
                    const tail = 90;
                    const g = ctx.createLinearGradient(sx, sy, sx - sh.dx * 0.001 * tail, sy - sh.dy * 0.001 * tail);
                    g.addColorStop(0, `rgba(255,250,230,${0.8 * life})`);
                    g.addColorStop(1, "rgba(255,250,230,0)");
                    ctx.strokeStyle = g;
                    ctx.lineWidth = 1.6;
                    ctx.beginPath();
                    ctx.moveTo(sx, sy);
                    ctx.lineTo(sx - sh.dx * 0.001 * tail, sy - sh.dy * 0.001 * tail);
                    ctx.stroke();
                }
            }
        } else if (amb.now > amb.shootAt) {
            const ang = Math.PI * (0.7 + Math.random() * 0.35);
            const spd = 380 + Math.random() * 240;
            amb.shoot = {
                t: 0,
                x0: w * (0.1 + Math.random() * 0.6),
                y0: h * 0.02 + Math.random() * h * 0.08,
                dx: Math.cos(ang) * spd,
                dy: Math.sin(ang) * spd,
            };
        }
        ctx.restore();
    };

    /* 灯笼逐帧驱动：与河水同向，向远方缓流。
   速度按 d^1.35 递减：眼前出发快，中后段渐慢，最后一段接近远山时最慢，
   与视觉"渐行渐远（河面在远处收窄）"一致。 */
    const driveLanterns = (dt: number) => {
        const ms = metaRef.current;
        const pos: { m: LanternMeta; x: number; y: number; r: number }[] = [];
        for (const m of ms) {
            // 流速持续放缓（第 11 轮：系数 0.21/0.63 → 0.15/0.44，再降约 30%）
            m.d -= dt * m.w * (0.15 + 0.44 * Math.pow(Math.max(0.03, m.d), 1.35));
            // 涟漪随机触发：每灯独立倒计时（1.2-3.8s），回合 1.8s 扩散。
            // 间隔较短 + 起始错开 → 同一时刻有多盏灯在各自扩散（不同步齐整）
            m.rip -= dt;
            if (m.ripT < 0 && m.rip <= 0) {
                m.rip = 1.2 + Math.random() * 2.6;
                m.ripT = 0;
            }
            if (m.ripT >= 0) {
                m.ripT += dt;
                if (m.ripT > 1.8) {
                    m.ripT = -1;
                    m.rip = 1.2 + Math.random() * 2.6; // 上一轮结束，排下一轮
                }
            }
            if (m.d < -0.02) {
                m.d = 0.94 + Math.random() * 0.05; // 眼前重入
                m.u = 0.25 + Math.random() * 0.45;
                m.w = 0.03 + Math.random() * 0.045;
                m.oX = 0;
                m.oY = 0;
                m.rip = 1 + Math.random() * 3;
                m.ripT = -1;
            }
            const d = Math.max(0, m.d);
            const scl = Math.pow(d, 1.15);
            const li = lanternXY(m);
            pos.push({ m, x: li.x - m.oX, y: li.y - m.oY, r: scl * 46 + 7 });
        }
        // 体积碰撞（原始方案）：圆-圆分离，位移小且按景深加权，随后随流衰减归位
        for (let i = 0; i < pos.length; i++) {
            for (let j = i + 1; j < pos.length; j++) {
                const A = pos[i], B = pos[j];
                const dx = B.x + B.m.oX - A.x - A.m.oX;
                const dy = B.y + B.m.oY - A.y - A.m.oY;
                const d2 = dx * dx + dy * dy;
                const rr = A.r + B.r;
                if (d2 >= rr * rr || d2 < 0.001) continue;
                const dist = Math.sqrt(d2);
                const pen = (rr - dist) * 0.5;
                const nx = dx / dist, ny = dy / dist;
                // d 可能落在 (-0.02, 0) 的待重生区间：负底数小数次幂是 NaN，会把位移污染成 NaN
                const da = Math.max(0, A.m.d), db = Math.max(0, B.m.d);
                const wa = Math.pow(da, 0.9) + 0.25;
                const wb = Math.pow(db, 0.9) + 0.25;
                const sa = pen * (wb / (wa + wb)), sb = pen * (wa / (wa + wb));
                A.m.oX -= nx * sa; A.m.oY -= ny * sa;
                B.m.oX += nx * sb; B.m.oY += ny * sb;
            }
        }
        for (const m of ms) {
            m.oX *= Math.pow(0.9, dt * 60);
            m.oY *= Math.pow(0.9, dt * 60);
            const node = nodesRef.current.get(m.id);
            if (!node) continue;
            const d = Math.max(0, m.d);
            const rot = Math.sin(amb!.now * 0.55 + m.sway) * 3.2;
            const scl = Math.pow(d, 1.15);
            const li = lanternXY(m);
            node.style.transform =
                `translate3d(${li.x}px, ${li.y}px, 0) translate(-50%, -50%) scale(${scl}) rotate(${rot}deg)`;
            node.style.zIndex = String(200 + Math.round(d * 1000));
            node.style.opacity = String(0.45 + 0.55 * Math.pow(d, 0.8));
            node.style.filter = `brightness(${(0.72 + 0.34 * d) * m.bright}) hue-rotate(${m.hue}deg)`;
            node.style.pointerEvents = d < 0.24 ? "none" : "auto";
            const qt = node.querySelector(".rz-pool") as HTMLElement | null;
            if (qt) qt.style.opacity = String(0.4 + 0.6 * d);
        }
    };

    /* 主循环 */
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) return;

        let raf = 0;
        let last = performance.now();
        let disposed = false;
        let baseBack: HTMLCanvasElement | null = null;
        let baseFront: HTMLCanvasElement | null = null;

        const onResize = () => {
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const w = window.innerWidth;
            const h = window.innerHeight;
            const v = viewRef.current;
            v.dpr = dpr;
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            canvas.style.width = w + "px";
            canvas.style.height = h + "px";
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            layout(w, h);
            buildAmb();
            const makeBase = () => {
                const c = document.createElement("canvas");
                c.width = Math.round((w + MARGIN * 2) * dpr);
                c.height = Math.round((h + MARGIN * 2) * dpr);
                return c;
            };
            baseBack = makeBase();
            baseFront = makeBase();
            renderBase(baseBack, baseFront);
        };

        onResize();
        window.addEventListener("resize", onResize);

        const onMove = (e: MouseEvent) => {
            if (touchRef.current) return;
            mouseRef.current.tx = e.clientX / window.innerWidth;
            mouseRef.current.ty = e.clientY / window.innerHeight;
        };
        const onTouch = () => {
            touchRef.current = true;
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("touchstart", onTouch, { once: true });

        const frame = (now: number) => {
            if (disposed) return;
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            if (amb) amb.now += dt;
            mouseRef.current.x += (mouseRef.current.tx - mouseRef.current.x) * 0.05;
            mouseRef.current.y += (mouseRef.current.ty - mouseRef.current.y) * 0.05;
            drawScene(
                ctx,
                amb ? amb.now : 0,
                reduced(),
                baseBack!,
                baseFront!
            );
            driveLanterns(dt);
            if (!reduced()) scrollTick(dt);
            raf = requestAnimationFrame(frame);
        };

        const reduced = () =>
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        raf = requestAnimationFrame(frame);

        return () => {
            disposed = true;
            cancelAnimationFrame(raf);
            window.removeEventListener("resize", onResize);
            window.removeEventListener("mousemove", onMove);
        };
    }, []);

    /* 留言获取 + 点灯 */
    useEffect(() => {
        let cancelled = false;
        const initLights = (msgs: string[]) => {
            if (cancelled) return;
            const v = viewRef.current;
            const want = Math.round(((v.w * v.h) / (1920 * 1080)) * 16) + 8;
            const count = Math.max(8, Math.min(22, want));
            const metas: LanternMeta[] = [];
            const views: Wish[] = [];
            for (let i = 0; i < count; i++) {
                // 河灯散布整个河面宽度（河道两侧也适当有灯），不挤在河心
                const u = 0.25 + Math.random() * 0.45;
                // 初始分布偏近景：开场即见大河灯，且近场始终有灯
                const d = 1 - Math.pow(Math.random(), 1.8);
                const msg = msgs[i % msgs.length];
                metas.push({
                    id: i,
                    v: Math.floor(Math.random() * 3),
                    u,
                    d,
                    w: 0.03 + Math.random() * 0.045,
                    sway: Math.random() * Math.PI * 2,
                    hue: Math.round((Math.random() - 0.5) * 26),
                    bright: 0.85 + Math.random() * 0.25,
                    oX: 0,
                    oY: 0,
                    rip: 0.5 + Math.random() * 4.5, // 初始即错开相位
                    ripT: -1,
                });
                views.push({ id: i, v: metas[i].v, msg, cat: catOf(msg) });
            }
            metaRef.current = metas;
            setLanterns(views);
            // 入场渐显
            requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
        };

        initLights(DEMO_MESSAGES.slice(0, 12));

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        fetch(`${runtimeBaseURL}/api/public/talk`, { signal: ctrl.signal })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad status"))))
            .then((j: unknown) => {
                const data = (j as { data?: unknown })?.data;
                const arr = Array.isArray(data)
                    ? (data as Array<{ content?: unknown }>)
                    : Array.isArray(j)
                      ? (j as Array<{ content?: unknown }>)
                      : [];
                const texts = arr.map((x) => String(x?.content ?? "").trim()).filter(Boolean);
                if (texts.length >= 4) {
                    setLanterns((prev) =>
                        prev.map((p, i) => {
                            const msg = texts[i % texts.length];
                            return { ...p, msg, cat: catOf(msg) };
                        })
                    );
                }
            })
            .catch(() => {})
            .finally(() => clearTimeout(timer));

        return () => {
            cancelled = true;
            ctrl.abort();
        };
    }, []);

    /* 气泡长文滚动：JS 逐帧显式推进（CSS animation 偶发卡死不滚，改为可控的 transform） */
    const bubbleRefs = useRef<Map<number, HTMLDivElement | null>>(new Map());
    const scrollState = useRef<{ msg: HTMLElement; max: number; pos: number } | null>(null);
    const restartScroll = (handle: HTMLElement) => {
        const box = handle.querySelector(".rz-scroll") as HTMLElement | null;
        const msg = handle.querySelector(".rz-msg") as HTMLElement | null;
        if (!box || !msg) return;
        const max = msg.offsetHeight - box.clientHeight + 12;
        if (max <= 2) {
            scrollState.current = null;
            return;
        }
        msg.style.transform = "translateY(0px)";
        scrollState.current = { msg, max, pos: 0 };
    };
    // 每帧推进滚动（在 rAF 主循环里调用）；reduced-motion 时不动作
    const scrollTick = (dt: number) => {
        const st = scrollState.current;
        if (!st) return;
        if (!st.msg.isConnected) {
            scrollState.current = null;
            return;
        }
        st.pos += dt * 24; // ≈24px/s，慢速可读
        if (st.pos >= st.max) {
            st.msg.style.transform = `translateY(${-st.max}px)`;
            scrollState.current = null; // 停在末尾；再次打开从头滚
        } else {
            st.msg.style.transform = `translateY(${-st.pos}px)`;
        }
    };

    /* 开关气泡（pointerdown 直达触屏，click 仅兜底鼠标端） */
    const lastTouchToggle = useRef(0);
    const toggleMsg = (id: number, open?: boolean) => {
        const handle = document.querySelector(`[data-lid="${id}"]`) as HTMLElement | null;
        if (!handle) return;
        const willOpen = open ?? !handle.classList.contains("rz-open");
        handle.classList.toggle("rz-open", willOpen);
        if (willOpen) restartScroll(handle);
        const openOthers = () => {
            document.querySelectorAll<HTMLElement>(".rz-open").forEach((el) => {
                if (el !== handle) el.classList.remove("rz-open");
            });
            document.removeEventListener("click", openOthers);
        };
        document.removeEventListener("click", openOthers);
        if (willOpen) document.addEventListener("click", openOthers);
    };

    /* 点按河灯：气泡常显 + 正中弹窗细读 */
    const lastWishTouch = useRef(0);
    const openWish = (ln: Wish, fromTouch = false) => {
        toggleMsg(ln.id, true);
        if (fromTouch) lastWishTouch.current = Date.now();
        setModal(ln);
    };
    const closeModal = () => {
        // 弹窗关闭后，悬浮于河灯上的文本气泡一并收起
        document.querySelectorAll<HTMLElement>(".rz-open").forEach((el) => {
            el.classList.remove("rz-open");
        });
        setModal(null);
    };
    /* 触屏打开弹窗后，同一次点按的合成 click 会落在遮罩上误关；
       800ms 内的遮罩点击视为那次点按的跟随事件，忽略 */
    const dismissModal = () => {
        if (Date.now() - lastWishTouch.current < 800) return;
        closeModal();
    };
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setModal(null);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    if (sprites.length === 0) return <div className="rz-root" />;

    return (
        <div className="rz-root">
            <canvas ref={canvasRef} className="rz-canvas" aria-hidden />
            <div ref={layerRef} className="rz-lanterns" aria-hidden>
                {lanterns.map((ln) => (
                    <div
                        key={ln.id}
                        data-lid={ln.id}
                        ref={(el) => {
                            nodesRef.current.set(ln.id, el);
                        }}
                        className="rz-lantern"
                        role="button"
                        tabIndex={0}
                        aria-label="河灯心愿"
                        onMouseEnter={() => {
                            nodesRef.current.get(ln.id)?.classList.add("rz-open");
                            const h = nodesRef.current.get(ln.id);
                            if (h) restartScroll(h);
                        }}
                        onMouseLeave={() => {
                            if (!modal) nodesRef.current.get(ln.id)?.classList.remove("rz-open");
                        }}
                        onFocus={() => {
                            nodesRef.current.get(ln.id)?.classList.add("rz-open");
                            const h = nodesRef.current.get(ln.id);
                            if (h) restartScroll(h);
                        }}
                        onBlur={() => {
                            if (!modal) nodesRef.current.get(ln.id)?.classList.remove("rz-open");
                        }}
                        onPointerDown={(e) => {
                            if (e.pointerType === "touch") {
                                lastTouchToggle.current = Date.now();
                                openWish(ln, true);
                            }
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") openWish(ln);
                        }}
                        onClick={() => {
                            if (Date.now() - lastTouchToggle.current < 500) return;
                            openWish(ln);
                        }}
                    >
                        <div className="rz-halo" />
                        <div className="rz-pool">
                            <span className="rz-pool-light" />
                            <span className="rz-ring r1" />
                            <span className="rz-ring r2" />
                        </div>
                        <div
                            className={"rz-sprite" + (ln.v >= 1 ? " rz-oct" : "")}
                            style={ln.v >= 1 ? { width: 130, height: 130, margin: "-65px 0 0 -65px" } : undefined}
                        >
                            <img src={sprites[ln.v]} alt="" draggable={false} />
                            <div className="rz-flame" />
                        </div>
                        <div
                            ref={(el) => {
                                bubbleRefs.current.set(ln.id, el);
                            }}
                            className="rz-bubble"
                        >
                            <div className="rz-scroll">
                                <div className="rz-msg">{ln.msg}</div>
                            </div>
                            <span className="rz-seal">{ln.cat}</span>
                        </div>
                    </div>
                ))}
            </div>
            <div className="rz-ui">
                <header className="rz-title">
                    <i />
                    河灯寄语
                </header>
                <div className="rz-couplet">
                    <span>
                        <b>「</b>醉后不知天在水<b>」</b>
                    </span>
                    <span>
                        <b>「</b>满船清梦压星河<b>」</b>
                    </span>
                </div>
                <p className="rz-hint">悬停河灯读心愿 · 点按细细端详</p>
            </div>
            <div className="rz-veg" />
            {modal && (
                <div className="rz-modal" onClick={dismissModal} role="dialog" aria-modal="true" aria-label="心愿细读">
                    <div className="rz-modal-box" onClick={(e) => e.stopPropagation()}>
                        <div className="rz-scroll">
                            <div className="rz-msg">{modal.msg}</div>
                            {/* 关闭钮放进内容流：滚动到文本末尾才能看到，不再是悬浮在框底压住文本 */}
                            <button className="rz-modal-close" type="button" onClick={closeModal}>
                                <span>关闭</span>
                            </button>
                        </div>
                        <span className="rz-seal">{modal.cat}</span>
                    </div>
                </div>
            )}
            <div className={ready ? "rz-boot rz-boot-off" : "rz-boot"}>
                <div className="rz-boot-glow" />
                <p>河灯将明 · 稍候</p>
            </div>
        </div>
    );
}
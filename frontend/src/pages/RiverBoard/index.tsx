import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./index.scss";
import { runtimeBaseURL } from "../../utils/runtimeApi";
import { MOON_TEX } from "./moon_tex";
import Live2dAgent from "../../components/Live2dAgent"; // 沉浸页也保留看板娘（顶层路由无 App 布局）

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

/* 心愿分类：愿 / 寄 / 忆 / 诉（留言用户自选类型） */
const CATS = ["愿", "寄", "忆", "诉"];
const catOf = (s: string) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return CATS[h % CATS.length];
};
/* 四枚印章的介绍：愿 · 心灯祈愿 / 寄 · 尺素传情 / 忆 · 旧梦拾光 / 诉 · 临灯自语 */
const CAT_INFO: Record<string, { name: string; desc: string }> = {
    愿: { name: "心灯祈愿", desc: "长愿灯花照此身，人间万事俱成真。" },
    寄: { name: "尺素传情", desc: "欲寄彩笺兼尺素，灯影长流知我意。" },
    忆: { name: "旧梦拾光", desc: "故人往事随波去，一盏河灯一梦回。" },
    诉: { name: "临灯自语", desc: "此心幽处无人解，且付清波与灯听。" },
};
/* 三种灯型名称（与精灵 v 对应） */
const LAMP_NAMES = ["莲花灯", "八角灯", "圆笼灯"];
/* 河灯上的简短时刻（月-日 时:分），与灯影集完整时间区分 */
const shortTime = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/* 灯影集条目 */
type AlbumItem = {
    id: number;
    v: number;
    cat: string;
    author: string;
    msg: string;
    time: string;
    mine: boolean;
    approved: number; // 1=通过 / 0=待审 / 2=未通过（仅"我的河灯"接口返回非 1）
    reason?: string | null; // 驳回理由（20260923，仅 approved=2 可能有值）
};

type Wish = {
    id: number;
    v: number;
    msg: string;
    cat: string;
    author?: string;
    time?: string;
    /* 灯影集条目点开的灯（20260905 issue8 收回/状态用）：
       talkKey=留言 id；mine/approved 供弹窗显示状态标签与收回按钮 */
    talkKey?: number;
    mine?: boolean;
    approved?: number;
    reason?: string | null; // 驳回理由（20260923，仅 approved=2 可能有值）
};

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

// 月海暗斑（近地面真实分布，正弦投影近似），月盘归一化 [-1,1]：[cx, cy, rx, ry]
// nx 右=月面东（λ+），ny 上=月面北（φ+）。第 33 轮：替代原随机假暗斑，
// 风暴洋（西部大片）· 雨海（西北）· 静海（东中）· 澄海（东北）· 丰富海（东）
// · 危海（东北缘）· 汽海（中北）· 云海（南中）· 湿海（西南）
const MARIA: [number, number, number, number][] = [
    [-0.4, 0.05, 0.3, 0.26], // 风暴洋
    [-0.2, 0.38, 0.17, 0.13], // 雨海
    [0.24, 0.12, 0.18, 0.14], // 静海
    [0.14, 0.27, 0.13, 0.1], // 澄海
    [0.45, -0.02, 0.14, 0.1], // 丰富海
    [0.55, 0.16, 0.1, 0.07], // 危海
    [0.06, 0.2, 0.1, 0.07], // 汽海
    [-0.13, -0.24, 0.14, 0.1], // 云海
    [-0.33, -0.21, 0.1, 0.07], // 湿海
];
// 环形山：真实月面（近地面，地球裸眼视角）知名环形山，[cx, cy, r] 归一化。
// 坐标 = 正弦投影 (sinλ·cosφ, sinφ)，r 由真实直径换算（D km → sin(D/3474·90°)）
// 后按视觉 ×1.4 艺术放大——月亮在场景中偏小，真实比例在画面里不可见。
// 第 33 轮：替代原随机假分布——第谷 Tycho（南，辐射纹最醒目）· 哥白尼 Copernicus
// · 开普勒 Kepler · 阿里斯塔克斯 Aristarchus（月面最亮）· 柏拉图 Plato（暗底）
// · 克拉维乌斯 Clavius（南极大环）· 阿基米德 Archimedes · 亚里士多德 Aristoteles
// · 喜帕恰斯 Hipparchus · 托勒密 Ptolemaeus · 阿尔芬苏斯 Alphonsus
// · 泰奥菲勒斯 Theophilus · 朗格伦 Langrenus（东缘）· 佩塔维乌斯 Petavius（东缘）
// · 恩迪米翁 Endymion · 阿特拉斯 Atlas · 皮科洛米尼 Piccolomini
const CRATERS: [number, number, number][] = [
    [-0.141, -0.686, 0.053], // 第谷
    [-0.339, 0.167, 0.059], // 哥白尼
    [-0.61, 0.141, 0.02], // 开普勒
    [-0.674, 0.402, 0.025], // 阿里斯塔克斯
    [-0.1, 0.784, 0.064], // 柏拉图
    [-0.126, -0.855, 0.098], // 克拉维乌斯
    [-0.061, 0.495, 0.052], // 阿基米德
    [0.191, 0.768, 0.055], // 亚里士多德
    [0.083, -0.096, 0.07], // 喜帕恰斯
    [-0.031, -0.16, 0.07], // 托勒密
    [-0.049, -0.232, 0.056], // 阿尔芬苏斯
    [0.436, -0.198, 0.063], // 泰奥菲勒斯
    [0.864, -0.155, 0.07], // 朗格伦
    [0.788, -0.424, 0.084], // 佩塔维乌斯
    [0.495, 0.805, 0.07], // 恩迪米翁
    [0.48, 0.728, 0.053], // 阿特拉斯
    [0.463, -0.495, 0.056], // 皮科洛米尼
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
    _dq?: number; // 景深档位缓存（性能：filter/zIndex 换档才重写，不逐帧写）
    _pe?: string; // pointerEvents 缓存（性能：只在实际变化时写，不逐帧写）
    _poolNode?: HTMLDivElement | null; // .rz-pool 查询时的节点身份（换节点才重新查）
    _pool?: HTMLElement | null; // .rz-pool 子节点缓存（性能：消掉每帧每灯一次 querySelector）
}

interface Amb {
    stars: { x: number; y: number; r: number; tw: number; ph: number; warm: boolean; fl: boolean }[];
    streaks: { u: number; d: number; spd: number; ph: number; len: number; warm: boolean }[];
    glints: { u: number; d: number; ph: number; spd: number; warm: boolean; br: number }[];
    bands: { d0: number; wd: number; spd: number; ph: number }[];
    fireflies: { u: number; d: number; ph: number; flap: number }[];
    shoot: { t: number; x0: number; y0: number; dx: number; dy: number } | null;
    shootAt: number;
    now: number;
}

let amb: Amb | null = null;

/* 月亮几何（组件内多处共享：绘制与星光避让用同一份常量） */
const MOON = { x: 0.7, y: 0.16, r: 0.073 } as const; // r 0.093 → 0.073：月亮缩小

/* 第 34 轮：真实月球照片反照率纹理（sample_moon_tex.py 生成，192×192，
   月盘外透明）。纹理就绪后替代手写 MARIA/CRATERS 分布——月海、环形山、
   辐射纹等全部来自真实照片；异步加载，未就绪帧回退到手写分布 */
const moonTexN = 192;
let moonTexA: Float32Array | null = null;
let moonTexLoading = false;
/* 反照率标定（加载时按盘内 p5/p95/中位数算出，见 loadMoonTex） */
let moonTexLo = 0;
let moonTexHi = 1;
let moonTexMed = 0.5;
const moonTexWaiters: Array<() => void> = [];
/* 第 37 轮：支持就绪回调——月亮在静态层渲染，纹理异步就绪后必须重绘一次
   静态层才能真正上月亮（此前仅 drawScene 每帧调用，静态层永不重画，
   月亮一直用 fallback 手写分布+颗粒噪声渲染，照片纹理从未生效）。
   加载中挂起的回调统一在 onload 后触发 */
const loadMoonTex = (onReady?: () => void) => {
    if (moonTexA) {
        onReady?.();
        return;
    }
    if (moonTexLoading) {
        if (onReady) moonTexWaiters.push(onReady);
        return;
    }
    moonTexLoading = true;
    const im = new Image();
    im.onload = () => {
        const c = document.createElement("canvas");
        c.width = c.height = moonTexN;
        const g = c.getContext("2d")!;
        g.drawImage(im, 0, 0, moonTexN, moonTexN);
        const d = g.getImageData(0, 0, moonTexN, moonTexN).data;
        const a = new Float32Array(moonTexN * moonTexN);
        for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3] > 128 ? d[i * 4] / 255 : -1;
        // 反照率区间自适应标定（20260912 写实化）：拿盘内值的 p5/p95 当 0..1 的锚，
        // 渲染时映射到 0.70..1.30 的亮度区间（月海:高地 ≈ 1.6:1）。硬编码中位数不可靠——
        // 纹理是离线脚本「围绕中位 ×1.8 + BoxBlur」做的，中位不一定落在 0.5
        const vals = Array.from(a).filter((v) => v >= 0).sort((x, y) => x - y);
        if (vals.length > 16) {
            moonTexLo = vals[Math.floor(vals.length * 0.05)];
            moonTexHi = vals[Math.floor(vals.length * 0.95)];
            moonTexMed = vals[vals.length >> 1];
            if (moonTexHi - moonTexLo < 0.05) { moonTexLo = 0; moonTexHi = 1; } // 极端平纹理兜底
        }
        moonTexA = a;
        moonTexLoading = false;
        for (const w of moonTexWaiters) w();
        moonTexWaiters.length = 0;
        onReady?.();
    };
    im.src = MOON_TEX;
};

/* 性能（P2-2）：canvas 场景 dpr 上限。dpr 2 → 1.5 时全屏像素量 -44%
（576万 → 324万/帧），是砍全屏重绘 GPU 填充的最大单刀；
1.5 下 2D 光效场景清晰度差异极小（DOM 河灯是 CSS 渲染不受影响）。
真机观感不满意可调回 1.75 / 2。 */
const DPR_CAP = 1.5;

/* 萤火虫/孔明灯光点贴图：同参数的 radial 渐变只渲染一次（2x 超采样），
   之后逐帧 drawImage —— 消除每帧 createRadialGradient + arc 填充 */
const glowSprite = (r: number, stops: Array<[number, string]>) => {
    const s = (r * 2 + 4) * 2;
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, r * 2);
    for (const [p, col] of stops) grad.addColorStop(p, col);
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    return c;
};
const FIREFLY_SPRITE = glowSprite(7, [
    [0, "rgba(236,255,170,1)"],
    [0.5, "rgba(200,236,120,0.38)"],
    [1, "rgba(180,220,100,0)"],
]);

/* 月光碎影静态光晕独立层：在 renderBase 构建一次，drawScene 每帧一次 drawImage */
let moonGlowCv: HTMLCanvasElement | null = null;
/* 河灯水面照明贴图（第 29 轮）：512×256 椭圆暖光，drawScene 每帧在每盏灯所在
   河面 lighter 合成——灯真正"照亮"周围水面（此前只有 DOM 300px 光晕，河面依旧黑） */
let lanternLightCv: HTMLCanvasElement | null = null;
/* 慢层（流向纹/碎光点/涟漪）：离屏缓冲 ≈20fps 重绘，主画布每帧一次 drawImage 合成 */
let slowCv: HTMLCanvasElement | null = null;
let slowTick = 0;

/* ------------------------- 组件 ------------------------- */

export default function RiverBoard() {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const layerRef = useRef<HTMLDivElement | null>(null);
    const metaRef = useRef<LanternMeta[]>([]);
    const nodesRef = useRef<Map<number, HTMLDivElement | null>>(new Map());
    const viewRef = useRef({ w: 0, h: 0, yH: 0, dpr: 1, reduced: false, texApplied: false });
    const mouseRef = useRef({ x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 });
    const touchRef = useRef(false);

    const [sprites] = useState<string[]>(buildSprites);
    const [lanterns, setLanterns] = useState<Wish[]>([]);
    const [ready, setReady] = useState(false);
    const [modal, setModal] = useState<Wish | null>(null); // 正中弹窗内的心愿
    /* 收回河灯（20260905 issue8）：两步确认——先点「收回河灯」武装成「确认收回」再执行 */
    const [reclaimArm, setReclaimArm] = useState(false);
    const [reclaimBusy, setReclaimBusy] = useState(false);
    const [reclaimErr, setReclaimErr] = useState("");

    /* 此心为灯 · 留言流程：0 选灯型 → 1 选印章 → 2 书写/放下 */
    const [wishOpen, setWishOpen] = useState(false);
    const [wishStep, setWishStep] = useState<0 | 1 | 2>(0);
    const [wishV, setWishV] = useState(0);
    const [wishCat, setWishCat] = useState("愿");
    const [wishText, setWishText] = useState("");
    const [wishBusy, setWishBusy] = useState(false);
    const [wishDone, setWishDone] = useState(false);
    // 放下结果进待审（后端人工复核开时 data="Pending"，20260905）：完成页提示
    const [wishPending, setWishPending] = useState(false);
    const wishSeq = useRef(0); // 新河灯自增 id（避开现有 0..n）
    /* 刚放下的灯快照："再看一眼"按同一盏灯重新点放（复用其留名/灯型/内容） */
    const lastDroppedWish = useRef<Wish | null>(null);

    /* 河流留言批次轮播（第 22 轮）：全量留言按时间倒序（最新在前）。
    初始时河灯承载最新一批（前 N 条）；每盏灯漂出视野「眼前重入」时，
    从批次序列取下一条留言换上 → 窗口整体向更早推进，滚到最早一条后
    回到最新一批循环（指针取模）。窗口移动节奏 = 灯的漂流周期（约 1 分钟一批）。
    演示灯阶段（数据未回）不推进。 */
    const allTalksRef = useRef<Wish[]>([]);
    const batchPtr = useRef(0); // 已发放条数（含初始最新一批）
    const lanternCountRef = useRef(0);

    /* 灯 id 重入时换上批次序列下一条留言。
       useCallback 空依赖：实现里只读 ref、只调 setState 与模块级 catOf，
       所以首次闭包永久有效；稳定身份让下面的 QA effect 与河灯 DOM 的 memo 不被逐 render 打破 */
    const advanceMsg = useCallback((id: number) => {
        const items = allTalksRef.current;
        if (items.length === 0) return;
        // 池子被灯数全覆盖（留言数 ≤ 灯数）：不做轮换，重入保持原留言——
        // 轮换语义是「更多留言分批涌来」，池内每条的归属已经唯一，轮换只会制造瞬时重复
        if (items.length <= lanternCountRef.current) return;
        const it = items[batchPtr.current % items.length];
        batchPtr.current++;
        setLanterns((prev) =>
            prev.map((p) =>
                p.id === id
                    ? { ...p, msg: it.msg, cat: it.cat || catOf(it.msg), v: it.v, author: it.author, time: it.time }
                    : p
            )
        );
        // 灯型（v）同步进 meta：圆笼灯（v=2）的涟漪偏移以 meta.v 为准
        const meta = metaRef.current.find((m) => m.id === id);
        if (meta && it.v >= 0) meta.v = it.v;
    }, []);

    /* 灯影集：收录全部留言的古籍卷册 */
    const [albumOpen, setAlbumOpen] = useState(false);
    const [albumItems, setAlbumItems] = useState<AlbumItem[]>([]);
    // "我的河灯"数据源（20260905 issue8）：本人全部河灯含待审(0)/未通过(2)——
    // 公开列表只放行通过态，看不到自己的待审/被驳回的灯
    const [albumMine, setAlbumMine] = useState<AlbumItem[]>([]);
    const [albumTabs, setAlbumTabs] = useState<"time" | "mine" | "cat">("time");
    const [albumTimeAsc, setAlbumTimeAsc] = useState(false); // 时序正序/倒序
    const [albumCatFilter, setAlbumCatFilter] = useState<string[]>([]); // 类型筛选（空=全部）
    const [albumSearch, setAlbumSearch] = useState(false);
    const [albumQuery, setAlbumQuery] = useState("");
    /* 灯影集：选中留言弹详情期间隐藏卷册，关闭后恢复原浏览位置（第 32 轮） */
    const albumListRef = useRef<HTMLDivElement | null>(null); // 列表滚动容器
    const albumResumeRef = useRef<number | null>(null); // 暂存恢复时的 scrollTop
    /* 留言留名（可选；预填当前账号昵称，可一键匿名；检索框按留名/用户名查找） */
    const [wishAuthor, setWishAuthor] = useState("");
    /* 当前账号真实昵称（预填来源）：留名与之不一致时视为"匿名·自定义留名" */
    const profileNickRef = useRef("");
    /* 未登录留言门禁：留言板公告 */
    const [noticeOpen, setNoticeOpen] = useState(false);

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
        const hw = v.w * (0.15 + d * d * 1.08); // 远处收窄、近处展开（第 23 轮：0.12 → 0.15 远端再加宽，前端基本不变）
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
        const px = (mouseRef.current.x - 0.5) * 14;
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
        // 河灯照明贴图：椭圆暖光（横向椭圆，贴图 scale(1,0.625) 压扁），
        // 内芯暖白 → 外围淡橙渐隐；绘制时随灯 scl 缩放、近亮远暗。
        // 第 30 轮：渐变圆心取 (256,256) 而非 (256,128)——圆心会被 scale 变换
        // 一并缩放，原写法压扁后圆心落在 y=64、椭圆上缘伸出画布顶边，y=0 处
        // 残留 alpha≈0.28 暖色，被画布顶边硬切成水平亮线（"光晕上侧水平截断"）。
        // 现圆心 scale 后落在 (256,160)，椭圆 256×160 完美内切 512×320，四周
        // 弧形渐隐到 alpha 0，无任何平边；纵向加高让光晕上部弧线更完整。
        // 第 31 轮：内芯 alpha 1.0 → 0.5 并整体压暗柔化（用户反馈光晕太亮不
        // 自然、灯焰被淹没）——渐变衰减放缓（0.18 处 0.75→0.38、0.42 处
        // 0.32→0.18），近灯处不再白亮一片。
        lanternLightCv = document.createElement("canvas");
        lanternLightCv.width = 512;
        lanternLightCv.height = 320;
        const lg = lanternLightCv.getContext("2d")!;
        const lgrad = lg.createRadialGradient(256, 256, 0, 256, 256, 256);
        lgrad.addColorStop(0, "rgba(255,232,178,0.5)");
        lgrad.addColorStop(0.18, "rgba(255,206,132,0.38)");
        lgrad.addColorStop(0.42, "rgba(255,185,110,0.18)");
        lgrad.addColorStop(1, "rgba(255,185,110,0)");
        lg.save();
        lg.scale(1, 0.625);
        lg.fillStyle = lgrad;
        lg.fillRect(0, 0, 512, 512); // scale 后视觉覆盖 512×320
        lg.restore();
        amb = {
            stars, streaks, glints, bands, fireflies,
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

            // 月亮常量先行：星辰绘制需跳过月盘（星星不得透过月亮）
            const mxMoon = w * MOON.x;
            const myMoon = h * MOON.y;
            const rMoon = Math.min(w, h) * MOON.r;

            // 星辰（静态基色）；月盘内的星略过——月亮实心，星星不得透过
            for (const st of a.stars) {
                const sx = st.x * w, sy = st.y * h;
                const mdx = sx - mxMoon, mdy = sy - myMoon;
                if (mdx * mdx + mdy * mdy < rMoon * rMoon * 1.15) continue;
                ctx.fillStyle = st.warm ? "rgba(255,236,205,0.62)" : "rgba(214,228,255,0.68)";
                ctx.beginPath();
                ctx.arc(sx, sy, st.r, 0, Math.PI * 2);
                ctx.fill();
            }

            // 月亮：真实月相（球面光照，无圆盘轮廓——暗面完全透明不画出）
            // 光方向绕盘面左右旋转：β=0 满月（正面照），β=±π/2 上下弦（侧照），
            // 盈月亮面在右、亏月亮面在左（北半球可见月相），β=±π 新月（背照）
            const ph = moonPhase();
            // 第 33 轮：月相细粒度 8 档离散（新月/蛾眉/上弦/盈凸/满月/亏凸/下弦/残月
            // 各占 1/8 月龄）。此前光照方向 β 虽量化 8 档，但亮面占比 k 仍按连续
            // age 渐变——相邻档的差异被连续渐变稀释，视觉上只感知到 4 种形态；
            // 现 k 与 β 同步按 qAge 量化，8 种月相各自稳定清晰、档间跳变分明
            // 8 档月相量化，但**夹住两端半档**（20260912 用户反馈"现在是峨眉月吧，结果月全食了"）：
            // 月龄 0.5 天（真实是一弯细峨眉）在 round(0.017×8)/8 = 0 处被归成"新月"→ 亮面占比 0，
            // 配合不透明月盘就成了夜空里一个黑盘（月全食观感）。夹到 1/16 后该相位是一弯细牙，
            // 新月当天也始终有月牙可看（真实新月物理上确实几乎不可见，但观感上"没有月亮"更糟）
            const qAge = Math.min(15 / 16, Math.max(1 / 16, Math.round(ph.age * 8) / 8));
            const beta = Math.PI * (1 - 2 * Math.max(0, Math.min(1, qAge))); // 相位→光照角
            const lInv = 1 / Math.hypot(Math.sin(beta), Math.cos(beta));
            const lx = Math.sin(beta) * lInv, lz = Math.cos(beta) * lInv;
            // 光晕以发光区域（亮月牙）中心为圆心向四周完整扩散（不再裁剪半圆）：
            // 圆心随月相偏到亮面侧，暗面侧自然远离光心渐弱，不再有生硬的半圆边界。
            // 亮面占比 k 与 β 同步按 qAge 量化（新月几乎无光晕、满月最强）
            const haloK = 0.35 + 0.65 * (1 - (1 + Math.cos(2 * Math.PI * qAge)) / 2);
            const hx = mxMoon + lx * rMoon * 0.5, hy = myMoon;
            const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, w * 0.22);
            halo.addColorStop(0, `rgba(255,238,200,${0.26 * haloK})`);
            halo.addColorStop(0.3, `rgba(255,226,170,${0.09 * haloK})`);
            halo.addColorStop(1, "rgba(255,226,170,0)");
            ctx.fillStyle = halo;
            ctx.fillRect(hx - w * 0.32, hy - w * 0.32, w * 0.64, w * 0.64);
            const rD = rMoon * 0.82;
            const P = Math.max(8, Math.ceil(rD * 2 * v.dpr * 2));
            const R = P / 2;
            const mc = document.createElement("canvas");
            mc.width = mc.height = P;
            const mg = mc.getContext("2d")!;
            const img = mg.createImageData(P, P);
            const data = img.data;
            /* 月面渲染（20260912 两轮返工后的定稿）：
               ① alpha 与亮度解耦、且**只有受光面遮挡背景**（occlude = min(1, lum*6)）——
                  暗面完全透出背景。曾试过两种"让暗面可见"的做法（不透明深灰盘 / lighter 加光层），
                  用户两次都判为"假的圆形底盘"：夜空不是纯黑而是带光晕的蓝，任何整圆轮廓都会露馅；
               ② 反照率进亮度域并拉开对比（旧的 0.5+1.2t 把照片纹理压成一片白，满月看不出月海）；
               ③ 亮面亮度按相位归一（摄影语义：八种月相最亮点亮度一致）。 */
            const EXPOSURE = 0.70;     // 亮面峰值 ≈ 0.70×1.28 = 0.90（229/255）：明亮但不满溢
            // 相位亮度归一（摄影语义：相机按月亮曝光，八种月相的最亮点亮度应一致）：
            // 不归一的话上下弦最亮点只有满月的约一半，叠加 8 档月相量化会看着"忽明忽暗"
            // 额外的周边限暗压得很轻（0.12）：照片纹理自身已带月缘暗化，叠加会double成"黑圈"
            const limbKp = 0.12 + 0.24 * (1 - Math.abs(lz));
            const limbPeak = lz >= 0
                ? 1 - limbKp * Math.pow(Math.abs(lx), 2.6)
                : (1 - limbKp) * Math.pow(Math.abs(lx), 0.9);
            const sunGain = Math.min(2.2, 1 / Math.max(0.05, limbPeak));
            const rOut = R + 0.75;
            for (let py = 0; py < P; py++) {
                const Y = py + 0.5 - R;
                for (let px = 0; px < P; px++) {
                    const X = px + 0.5 - R;
                    const i4 = (py * P + px) * 4;
                    const rho2 = X * X + Y * Y;
                    if (rho2 > rOut * rOut) continue;      // 盘外（含 1px 过渡带外侧）
                    const rho = Math.sqrt(rho2);
                    const cov = Math.min(1, rOut - rho);   // 覆盖率：外沿 0.75px 线性升到 1（抗锯齿）
                    if (cov <= 0) continue;
                    const nx = X / R, ny = Y / R;
                    const radial = rho / R;                // 0=月心 1=月缘
                    const nz = Math.sqrt(Math.max(0, 1 - radial * radial));
                    // 终止线回到几何位置（旧写法 dot<=0.02 直接跳过 → 暗面整片消失）
                    const dot = nx * lx + nz * lz;
                    const sun = Math.pow(Math.max(0, dot), 0.9);
                    // 周边限暗：满月最平（真实满月本就没什么立体感），上下弦最陡
                    const limb = 1 - limbKp * Math.pow(radial, 2.6);
                    let alb = 1;
                    if (moonTexA) {
                        // 双线性采样 + 区间自适应标定到 0.70..1.30（月海:高地 ≈ 1.6:1）。
                        // 对比拉开后最近邻会露出 2× 块状，双线性只在静态层跑一次、成本可忽略；
                        // 盘外(-1)按中位数顶替，避免月缘被 -1 拉出一圈黑边
                        const fx = ((nx + 1) / 2) * moonTexN - 0.5;
                        const fy = ((1 - ny) / 2) * moonTexN - 0.5;
                        const ix0 = Math.floor(fx), iy0 = Math.floor(fy);
                        const tx = fx - ix0, ty = fy - iy0;
                        const cx0 = Math.min(moonTexN - 1, Math.max(0, ix0));
                        const cx1 = Math.min(moonTexN - 1, Math.max(0, ix0 + 1));
                        const cy0 = Math.min(moonTexN - 1, Math.max(0, iy0));
                        const cy1 = Math.min(moonTexN - 1, Math.max(0, iy0 + 1));
                        const s00 = moonTexA[cy0 * moonTexN + cx0];
                        const s10 = moonTexA[cy0 * moonTexN + cx1];
                        const s01 = moonTexA[cy1 * moonTexN + cx0];
                        const s11 = moonTexA[cy1 * moonTexN + cx1];
                        const t =
                            ((s00 < 0 ? moonTexMed : s00) * (1 - tx) + (s10 < 0 ? moonTexMed : s10) * tx) * (1 - ty) +
                            ((s01 < 0 ? moonTexMed : s01) * (1 - tx) + (s11 < 0 ? moonTexMed : s11) * tx) * ty;
                        const n01 = (t - moonTexLo) / (moonTexHi - moonTexLo);
                        // 0.80..1.28（月海:高地 ≈ 1.6:1）——下沿不再压到 0.70：纹理的月缘本来就暗，
                        // 下沿过低会与周边限暗叠成"黑圈"（满月看着像镶了边）
                        alb = 0.80 + 0.48 * (n01 < 0 ? 0 : n01 > 1 ? 1 : n01);
                    } else {
                        // 月海（静海/澄海/湿海等大块暗斑，柔边，暗区更明显）
                        for (const [cx, cy, rx, ry] of MARIA) {
                            const dx = nx - cx, dy = ny - cy;
                            const d2 = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
                            if (d2 < 1) alb *= 1 - 0.6 * (1 - d2) * 0.55;
                        }
                        // 环形山：暗坑加深 + 受光侧亮缘
                        for (const [cxc, cyc, rc] of CRATERS) {
                            const dx = nx - cxc, dy = ny - cyc;
                            const d2 = (dx * dx + dy * dy) / (rc * rc);
                            if (d2 < 1) {
                                const inner = 1 - d2;
                                alb *= 1 - 0.5 * inner; // 坑底变暗（第 33 轮 0.44→0.5：小月亮上环形山更可辨）
                                if (d2 > 0.55 && dx * lx > 0) alb *= 1 + 0.2 * inner; // 迎光壁更亮
                            }
                        }
                        // 表面颗粒噪声（沿光方向的高地纹理，确定性哈希）——仅手写 fallback 用；
                        // 照片纹理自带高频细节，叠加确定性哈希会在小月亮上形成"老人脸"麻点
                        const hsh = Math.abs(Math.sin(nx * 21.7 + ny * 9.3) * 43758.53);
                        alb *= 0.965 + 0.035 * (hsh - Math.floor(hsh));
                    }
                    // 受光面：只有太阳直射那一项（地球反照走下面单独的叠加层）
                    const lum = Math.min(1, EXPOSURE * sunGain * sun * alb * limb);
                    const warm = 1 + 0.05 * Math.max(0, dot); // 受光处偏暖
                    // 颜色只表达色温/亮度，alpha 只表达几何覆盖（两者解耦是本轮的核心）。
                    // occlude：只有**真的亮起来**的岩面才遮挡背景。暗面不遮挡——月盘周围那圈光晕
                    // 是大气散射，物理上就在月亮前面，会照亮整个盘面；旧写法暗面也不透明，盖住
                    // 光晕后成了夜空里一块比背景还暗的黑板（20260912 用户："黑底盘太假"）。
                    // 用 lum 而不是 sun 做判据：明暗交界带本来就该是"从透明渐显"（柔和的终止线），
                    // 而亮起来的部分（新月牙、满月盘）完全遮挡 → 月缘清晰
                    const occlude = Math.min(1, lum * 6);
                    data[i4] = Math.round(255 * lum * warm);
                    data[i4 + 1] = Math.round(255 * lum * 0.975 * warm);
                    data[i4 + 2] = Math.round(255 * lum * 0.92);
                    data[i4 + 3] = Math.round(cov * occlude * 255);
                    // 地球反照层（已下线，见下方合成处注释）。恢复时把下面三行放回去即可：
                    //   const shade = Math.max(0, 1 - Math.max(0, dot) * 4);
                    //   const earthL = earthBase * shade * alb * (0.55 + 0.45 * nz) * (1 - 0.22 * radial);
                    //   dataE[i4] = 255*earthL*0.72; dataE[i4+1] = 255*earthL*0.82; dataE[i4+2] = 255*earthL;
                    //   dataE[i4 + 3] = Math.round(cov * 255);   // 冷蓝灰，配合 lighter 只加光不压暗
                }
            }
            mg.putImageData(img, 0, 0);
            back.drawImage(mc, mxMoon - rD, myMoon - rD, rD * 2, rD * 2);
            // 地球反照叠加层已下线（20260912 用户第二次反馈："我不希望看到他的底盘和边缘形状…
            // 现在就能看到灰蒙蒙的月亮圆形轮廓"）。物理上地球反照是对的，但在这幅画里它表现为
            // 一个边缘可辨的灰盘：夜空背景不是纯黑而是带光晕的蓝，任何"整圆"都会读成虚假的底盘。
            // 结论：暗面完全不画（透出背景），只留受光的那部分 —— imgE/dataE 保留但不再合成，
            // 想恢复只需把下面这三行放回来。
            // mg.putImageData(imgE, 0, 0);
            // back.save();
            // back.globalCompositeOperation = "lighter";
            // back.drawImage(mc, mxMoon - rD, myMoon - rD, rD * 2, rD * 2);
            // back.restore();
            /* 月缘近场辉光（写实化第 2 项的补偿）已下线（20260912 同上）：它是一圈内半径
               1.0·rMoon 的环形渐变，暗面侧会露出一段圆弧内边界 —— 那正是"月亮的圆形轮廓"。
               光晕统一由上面那道以亮面为圆心、半径 0.22w 的软光晕承担（无内边界、不成环） */


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
            };
            ridge(v.yH * 0.82, 3.1, h * 0.045, "#0b1230");
            ridge(v.yH * 0.92, 8.7, h * 0.062, "#070d22");
            ridge(v.yH * 0.97, 1.7, h * 0.05, "#050a18");

            // 河水底色 + 河心天光带
            const riverBase = ctx.createLinearGradient(0, v.yH, 0, h);
            // 第 23 轮：整体调暗到接近背景（山体 #050a18-#0b1230），河面不再比远山更亮
            riverBase.addColorStop(0, "#0e1738");
            riverBase.addColorStop(0.3, "#081030");
            riverBase.addColorStop(0.62, "#050b22");
            riverBase.addColorStop(1, "#02040d");
            traceRiver(ctx, 0, 1.14, false);
            ctx.fillStyle = riverBase;
            ctx.fill();
            traceRiver(ctx, 0, 1.14, false);
            ctx.save();
            ctx.clip();
            const heart = ctx.createLinearGradient(0, v.yH * 0.98, 0, h);
            heart.addColorStop(0, "rgba(150,180,255,0.15)");
            heart.addColorStop(0.45, "rgba(120,150,235,0.07)");
            heart.addColorStop(1, "rgba(90,120,210,0.02)");
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
        draw(back);

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

        // 月光碎影静态光晕独立层：渐变+路径只构建一次，drawScene 每帧一次
        // drawImage 合成——保持原合成顺序（bands 之上），避免烘焙进基底被遮挡
        const glow = document.createElement("canvas");
        glow.width = Math.round((w + MARGIN * 2) * v.dpr);
        glow.height = Math.round((h + MARGIN * 2) * v.dpr);
        const gc = glow.getContext("2d")!;
        gc.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
        gc.translate(MARGIN, MARGIN);
        traceRiver(gc, 0, 1.14, false);
        gc.save();
        gc.clip();
        const glowC = gc.createLinearGradient(0, v.yH * 0.99, 0, h);
        glowC.addColorStop(0, "rgba(255,224,160,0)");
        glowC.addColorStop(0.5, "rgba(255,224,160,0.05)");
        glowC.addColorStop(1, "rgba(255,224,160,0)");
        traceRiver(gc, 0, 1.08, false);
        gc.fillStyle = glowC;
        gc.fill();
        moonGlowCv = glow;

        // 慢层离屏缓冲（流向纹/碎光点/涟漪）：resize 时重建并立即画首帧
        const slow = document.createElement("canvas");
        slow.width = Math.round((w + MARGIN * 2) * v.dpr);
        slow.height = Math.round((h + MARGIN * 2) * v.dpr);
        slowCv = slow;
        slowTick = 0;
        renderSlow(slow.getContext("2d")!);
    };

    /* 慢层（流向纹/碎光点/涟漪）：合并到离屏缓冲，每 3 帧重绘一次（≈20fps）。
       三者流速极慢（每帧约 0.3-2px），低频重绘视觉无差；主画布每帧仅一次
       drawImage 合成——每帧约 320 次绘制调用降为 1 次 */
    function renderSlow(sc: CanvasRenderingContext2D) {
        if (!amb) return;
        const v = viewRef.current;
        const { h } = v;
        const t = amb.now;
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        sc.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
        sc.translate(MARGIN, MARGIN);
        sc.clearRect(-MARGIN, -MARGIN, v.w + MARGIN * 2, v.h + MARGIN * 2);
        traceRiver(sc, 0, 1.14, false);
        sc.save();
        sc.clip();
        // 流向纹（顺流向的线性亮纹：自眼前出发，向远山方向流动消散）
        for (const s of amb.streaks) {
            s.d -= (0.06 + s.d * s.d * 0.62) * s.spd * 0.0035 * (reduce ? 0.12 : 1); // 流向纹：慢流（≈河灯速度 1/4）
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
            sc.strokeStyle = s.warm
                ? `rgba(255,216,164,${Math.min(0.4, alpha * 1.15)})`
                : `rgba(198,216,255,${alpha * (dHead > 0.5 ? 0.85 : 1)})`;
            sc.lineWidth = 0.7 + dHead * 2.2;
            sc.lineCap = "round";
            sc.beginPath();
            sc.moveTo(xT, yTl);
            sc.quadraticCurveTo(xm, (yH0 + yTl) / 2, xH, yH0);
            sc.stroke();
        }

        // 波面碎光点（随流向向远方游动）
        for (const g of amb.glints) {
            g.d -= (0.06 + g.d * g.d * 0.62) * g.spd * 0.0035 * (reduce ? 0.12 : 1); // 碎光点：慢流（≈河灯速度 1/4）
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
            sc.strokeStyle = g.warm ? `rgba(255,226,172,${a})` : `rgba(205,220,255,${a})`;
            sc.lineWidth = 0.6 + g.d * 1.4;
            sc.lineCap = "round";
            const len = 1.0 + g.d * 2.4;
            sc.beginPath();
            sc.moveTo(x - len, y);
            sc.lineTo(x + len, y);
            sc.stroke();
            if (g.br > 0.8) {
                sc.fillStyle = g.warm ? `rgba(255,240,205,${a * 0.7})` : `rgba(225,235,255,${a * 0.5})`;
                sc.beginPath();
                sc.arc(x, y, 0.7 + g.d, 0, Math.PI * 2);
                sc.fill();
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
            const scl = Math.min(1, Math.pow(Math.max(0, m.d), 1.15) * 1.25); // 与 DOM scale 同一缩放
            const rr = (12 + ph2 * 56) * (0.55 + 1.05 * scl);
            const li = lanternXY(m); // 与灯笼 DOM 同源坐标：涟漪以灯笼为中心
            const rx = li.x;
            // 圆笼灯（v=2）灯身最低处在灯笼中心下方 ≈42px·scl：涟漪从笼底溢出；
            // 八角/莲花仍以灯笼中心起始
            const ry = li.y + (m.v === 2 ? 42 * scl : 0) + 6;
            const ra = Math.sin(ph2 * Math.PI) * 0.16 * (0.35 + 0.65 * m.d);
            sc.strokeStyle = `rgba(205,222,255,${ra})`;
            sc.lineWidth = 1;
            sc.beginPath();
            sc.ellipse(rx, ry, rr, rr * 0.24, 0, 0, Math.PI * 2);
            sc.stroke();
        }

        // 河灯对水面的照明（第 31 轮）：lighter 合成暖光斑，以灯底为中心——
        // 第 30 轮上部弧线完整环绕灯身后，用户反馈光晕太亮不自然、灯焰被
        // 淹没。本轮：光斑中心从灯底上方 0.05·lh 下移到灯底下方 0.08·lh
        // （上部弧线止于灯顶附近，火焰区域完全脱离光斑不再被罩住），
        // globalAlpha 0.45+0.35·scl → 0.35+0.3·scl，叠加贴图内芯 0.5，
        // 近灯处有效亮度约为第 29 轮的 1/3。下部仍延伸到灯下 ~150px 河面。
        // 近亮远暗，远到看不见的灯（scl<0.06）跳过。贴图只构建一次。
        if (lanternLightCv) {
            sc.save();
            sc.globalCompositeOperation = "lighter";
            for (const m of metaRef.current) {
                const scl = Math.min(1, Math.pow(Math.max(0, m.d), 1.15) * 1.25);
                if (scl < 0.06) continue;
                const li = lanternXY(m);
                const lw = 420 * scl;
                const lh = lw * 0.625; // 贴图 512×320 纵横比
                sc.globalAlpha = 0.35 + 0.3 * scl;
                sc.drawImage(lanternLightCv, li.x - lw / 2, li.y - lh * 0.42, lw, lh);
            }
            sc.restore();
        }
        sc.restore();
    }

    /* ---- 逐帧动态层 ---- */

    /* 山体剪影裁剪路径（就地构建，第 22 轮修复"星星透过山的剪影"）：
       三层山由远到近叠放（0b1230 → 070d22 → 050a18），后画的覆盖前层下部，
       最终可见的山体上缘 = 三层脊线曲线逐 x 取最小值；clip 用
       「全屏矩形 + 山体区域」evenodd 镂空 → 动态星星/流星只画在山体之外。
       此前经 renderBase 传递 amb.skyClip 未生效（且只裁最前层，前两层透星），
       改为每帧就地构建；w/h 缓存，resize 才重建 */
    let skyClipCache: { w: number; h: number; p: Path2D } | null = null;
    const buildSkyClip = (w: number, h: number) => {
        if (skyClipCache && skyClipCache.w === w && skyClipCache.h === h) return skyClipCache.p;
        const p = new Path2D();
        p.rect(-MARGIN - 120, -MARGIN - 120, w + MARGIN * 2 + 240, h + MARGIN * 2 + 240);
        p.moveTo(-MARGIN - 20, h + MARGIN + 2);
        for (let x = -MARGIN - 20; x <= w + MARGIN + 20; x += 9) {
            const yH0 = viewRef.current.yH;
            const y1 = yH0 * 0.82 + h * 0.045 * (1.2 * Math.sin(x * 0.0042 + 3.1) + 0.7 * Math.sin(x * 0.011 + 3.1 * 2.7) + 0.28 * Math.sin(x * 0.023 + 3.1 * 5.1));
            const y2 = yH0 * 0.92 + h * 0.062 * (1.2 * Math.sin(x * 0.0042 + 8.7) + 0.7 * Math.sin(x * 0.011 + 8.7 * 2.7) + 0.28 * Math.sin(x * 0.023 + 8.7 * 5.1));
            const y3 = yH0 * 0.97 + h * 0.05 * (1.2 * Math.sin(x * 0.0042 + 1.7) + 0.7 * Math.sin(x * 0.011 + 1.7 * 2.7) + 0.28 * Math.sin(x * 0.023 + 1.7 * 5.1));
            p.lineTo(x, Math.min(y1, y2, y3));
        }
        p.closePath();
        skyClipCache = { w, h, p };
        return p;
    };

    // reduce = 性能降级（perfDynReduce/软渲染/系统偏好任一命中：水流带减速、
    // 视差归零等成本控制）；sysReduce = 仅系统 prefers-reduced-motion——星光/
    // 萤火虫/流星等"氛围装饰"只随系统偏好关（20260905 用户反馈：软渲染静态
    // 强制 reduced 把萤火虫也关了 → 装饰类改由 sysReduce 单独门控，性能降级
    // 不再剥夺它们）
    const drawScene = (ctx: CanvasRenderingContext2D, t: number, reduce: boolean, sysReduce: boolean, baseBack: HTMLCanvasElement, baseFront: HTMLCanvasElement) => {
        if (!amb) return;
        // 第 34 轮：真实月面纹理（幂等，onload 后 moonTexA 就绪）
        // 第 37 轮：月亮画在静态层（renderBase 仅初始化/resize 时渲染），
        // 纹理异步就绪时静态层早已用 fallback 画完且永不重画——照片纹理从未
        // 真正上月亮（用户看到的麻点=fallback 颗粒噪声）。就绪后重绘一次：
        loadMoonTex(() => {
            if (baseBack && !viewRef.current.texApplied) {
                viewRef.current.texApplied = true;
                renderBase(baseBack, baseFront);
            }
        });
        const v = viewRef.current;
        const { w, h } = v;
        const px = (mouseRef.current.x - 0.5) * 40; // 第 23 轮：左右视角加大（26 → 40）
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
            bd.d0 -= bd.wd * 0.7 * (reduce ? 0.15 : 1) * 0.005; // 宽幅水光带：慢漂（≈河灯速度的 1/4）
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
            // 远端渐隐：水光带只在中近段有（d 中点 < 0.2 完全淡出），
            // 河流尽头远端不保留反光
            const farFade = Math.min(1, Math.max(0, (dTop + dBot) / 2 - 0.2) / 0.3);
            const balpha = farFade * (bd.wd > 0.05 ? 0.042 : 0.03); // 第 22 轮：河面亮度略降
            g.addColorStop(0, "rgba(150,178,240,0)");
            g.addColorStop(0.3, `rgba(150,178,240,${balpha * 0.7})`);
            g.addColorStop(0.5, `rgba(150,178,240,${balpha})`);
            g.addColorStop(0.7, `rgba(150,178,240,${balpha * 0.7})`);
            g.addColorStop(1, "rgba(150,178,240,0)");
            ctx.fillStyle = g;
            ctx.fill();
        }

        // 月光碎影（"波光粼粼"）：贴水面的碎光横线列，自脚下向河心延伸
        // （静态光晕为独立预渲染层，bands 之上合成）。第 24 轮细节优化：
        // ① 透视修正——近景线粗长、远景线细短（旧版 lineWidth 随 k 变粗、spread 变宽，
        //    反透视）；
        // ② 每行带按 i 固定的伪随机横向错落（抖动仅水平、随波不随形），
        //    碎感真实，不再是一条均匀的线列；
        // ③ 范围收止 d≈0.19（第 25 轮加长，原 0.31）——河流尽头远端不保留反光；
        // ④ 远段闪烁熄灭门槛更高、亮度衰减更陡，闪灭节奏越远越碎。
        if (moonGlowCv) ctx.drawImage(moonGlowCv, -MARGIN, -MARGIN, w + MARGIN * 2, h + MARGIN * 2);
        const uM = 0.5;
        ctx.save();
        for (let i = 0; i < 46; i++) {
            const k = i / 46;
            const d = 0.93 - Math.pow(k, 1.16) * 0.74; // 近景 0.93 → 远景 0.19（远端收止）
            const flick = 0.06 + 0.52 * Math.abs(Math.sin(t * 2.6 + i * 7.7) * Math.sin(t * 1.1 + i * 3.3));
            if (k > 0.45 && flick < 0.17) continue;
            const jit = (Math.sin(i * 12.9898) * 0.5 + Math.sin(i * 78.233 + 3) * 0.5) * 0.006;
            const u = uM + Math.pow(k, 1.5) * 0.05 * Math.sin(t * 1.4 + i * 2.1) + jit;
            const spreadU = 0.022 - 0.012 * k; // 近宽远窄（透视）
            const y = riverY(d);
            const xl = riverX(u - spreadU, d);
            const xr = riverX(u + spreadU, d);
            ctx.strokeStyle = `rgba(255,232,178,${flick * (1 - k * 0.7)})`;
            ctx.lineWidth = 1.6 - k * 1.05; // 近粗远细（透视）
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(xl, y);
            ctx.lineTo(xr, y);
            ctx.stroke();
        }
        ctx.restore();

        // 流向纹/碎光点/涟漪：慢层离屏缓冲每 3 帧重绘，主画布每帧一次合成
        if (slowTick++ % 3 === 0 && slowCv) renderSlow(slowCv.getContext("2d")!);
        if (slowCv) ctx.drawImage(slowCv, -MARGIN, -MARGIN, w + MARGIN * 2, h + MARGIN * 2);
        ctx.restore();

        /* 星光闪烁 + 流星：整体裁剪在山体轮廓之外（星星/流星不再透过山的剪影，
           更不会"砸进"河里——clip 与 base 山体使用同一视差，裁剪随视差同步） */
        ctx.save();
        ctx.translate(px * 0.2, py * 0.1);
        ctx.clip(buildSkyClip(w, h), "evenodd");
        ctx.translate(-px * 0.2, -py * 0.1);
        /* 星光闪烁（只有少数亮星动态叠加；月盘内的星略过——月亮实心应遮挡星空） */
        const moonR = Math.min(w, h) * MOON.r * 0.82;
        const moonCX = w * MOON.x, moonCY = h * MOON.y;
        if (!sysReduce) {
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
        }
        ctx.restore(); // 山体遮罩作用于星光闪烁；孔明灯在天际更高处，不被裁剪

        /* 萤火虫（低空逡巡的荧光点）：画在山体遮罩之外——遮罩把"山脊线以下
           （含整条河）"都裁掉了，萤火虫在河面上方低空飞，必须走无裁剪路径。
           20260905：只随系统 prefers-reduced-motion 关（软渲染/动态降级不再
           剥夺——降级只控制 fps 与水流带成本，萤火虫每只仅 1 次预渲染贴图
           drawImage，开销可忽略） */
        if (!sysReduce) {
            for (const f of amb.fireflies) {
                f.u +=
                    (Math.sin(t * 0.07 + f.ph) * 0.0011 + Math.sin(t * 0.19 + f.ph * 1.7) * 0.0005);
                f.d -= (Math.sin(t * 0.045 + f.ph * 2.3) * 0.0002 + 0.00004);
                if (f.u < 0.04) f.u = 0.04;
                if (f.u > 0.96) f.u = 0.96;
                if (f.d < 0.045) f.d = 0.9 + Math.random() * 0.06;
                if (f.d > 0.92) f.d = 0.92;
                const fx = riverX(f.u, f.d) + px * 0.5;
                const fy = riverY(f.d) - 22 - Math.sin(t * 1.3 + f.ph) * 5;
                const fl = 0.35 + 0.65 * Math.abs(Math.sin(t * f.flap + f.ph * 5));
                if (fl < 0.2) continue;
                // 预渲染光点贴图：globalAlpha 携带闪烁系数，省略渐变创建与路径填充
                ctx.globalAlpha = fl * 0.85;
                ctx.drawImage(FIREFLY_SPRITE, fx - 7, fy - 7, 14, 14);
                ctx.globalAlpha = 1;
            }
        }

        /* 流星（山体遮罩：只画在山脊之上，不会砸进河里） */
        ctx.save();
        ctx.translate(px * 0.2, py * 0.1);
        ctx.clip(buildSkyClip(w, h), "evenodd");
        ctx.translate(-px * 0.2, -py * 0.1);
        if (amb.shoot) {
            if (sysReduce) {
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
                m.u = 0.15 + Math.random() * 0.7; // 河面加宽后灯散布更开（0.15-0.85）
                m.w = 0.03 + Math.random() * 0.045;
                m.oX = 0;
                m.oY = 0;
                m.rip = 1 + Math.random() * 3;
                m.ripT = -1;
                advanceMsg(m.id); // 批次轮播：重入时换上更早一批的留言
            }
            const d = Math.max(0, m.d);
            const scl = Math.min(1, Math.pow(d, 1.15) * 1.25); // 整体等比放大（保原透视形状）
            const li = lanternXY(m);
            pos.push({ m, x: li.x - m.oX, y: li.y - m.oY, r: scl * 53 });
        }
        /* 水面漂浮物软排斥（PBD 式松弛，无余量）：只在真实重叠（dist < rr）时推挤——
           相切对（dist === rr）零受力，刚接触的灯不会抖；每帧只消解重叠的一小部分
           （pen*0.28，封顶 1.5px/帧），指数松弛收敛、无过冲——浅接触近乎无感，
           深重叠 20-30 帧缓缓让开，观感是"挤过去"而不是"撞过去"。
           分离分三路（都吃同一份软推力，不留任何"整段穿透"硬推）：
           ① oX/oY 瞬态推挤（随流衰减 0.975/帧，≈1.5s 消散）——接触瞬间的轻微"顶开"；
           ② 法线水平分量约一半转入 u 空间（dx/du ≈ 2*hw，u 不衰减）——横向让行：
           河道收窄挤住的灯对缓缓侧滑互相让过，一次让开不再叠回；
           ③ 近垂直对（|nx| < 0.25）再把约一半转入 d 空间——d 不衰减且更深者流速更快
           （自增强），前后对随流错开；软推下局部导数的小幅低估只会让分离稍慢、
           不会过冲震荡（第 23 轮的 1.15 补偿是为整段穿透准备的，已随硬推一起移除）。
           垂直分量留在 oX/oY 而非 d 空间：同向同速对由流速差自然拉开；
           半径 r = scl*53 与灯体视觉尺寸同源（无 +7 常数）——远端不再有
           "视觉未接触却判定碰撞"的幻影重叠 */
        const vNow = viewRef.current;
        for (let i = 0; i < pos.length; i++) {
            for (let j = i + 1; j < pos.length; j++) {
                const A = pos[i], B = pos[j];
                const dx = B.x + B.m.oX - A.x - A.m.oX;
                const dy = B.y + B.m.oY - A.y - A.m.oY;
                const d2 = dx * dx + dy * dy;
                const rr = A.r + B.r;
                if (d2 >= rr * rr || d2 < 0.001) continue;
                const dist = Math.sqrt(d2);
                const pen = rr - dist;                      // >0 仅真实重叠
                const push = Math.min(pen * 0.28, 1.5);
                const nx = dx / dist, ny = dy / dist;
                // d 可能落在 (-0.02, 0) 的待重生区间：负底数小数次幂是 NaN，会把位移污染成 NaN
                const da = Math.max(0, A.m.d), db = Math.max(0, B.m.d);
                const wa = Math.pow(da, 0.9) + 0.25;        // 景深加权：浅灯让位更多
                const wb = Math.pow(db, 0.9) + 0.25;
                const sa = push * (wb / (wa + wb)), sb = push * (wa / (wa + wb));
                A.m.oX -= nx * sa; A.m.oY -= ny * sa;
                B.m.oX += nx * sb; B.m.oY += ny * sb;
                // 横向让行：约一半推力转入 u 空间（u 不衰减，clamp 在河道内）
                const hwA = vNow.w * (0.15 + da * da * 1.08);
                const hwB = vNow.w * (0.15 + db * db * 1.08);
                A.m.u = Math.max(0.13, Math.min(0.87, A.m.u - nx * ((sa * 0.5) / (2 * hwA))));
                B.m.u = Math.max(0.13, Math.min(0.87, B.m.u + nx * ((sb * 0.5) / (2 * hwB))));
                // 近垂直对（法线水平分量弱，u 让行无力）：纵向让行转入 d 空间
                if (Math.abs(nx) < 0.25) {
                    const kA = (vNow.h * 1.06 - vNow.yH) * 1.42 * Math.pow(da, 0.42);
                    const kB = (vNow.h * 1.06 - vNow.yH) * 1.42 * Math.pow(db, 0.42);
                    A.m.d = Math.max(0.02, Math.min(1, A.m.d - ny * ((sa * 0.5) / kA)));
                    B.m.d = Math.max(0.02, Math.min(1, B.m.d + ny * ((sb * 0.5) / kB)));
                }
            }
        }
        for (const m of ms) {
            m.oX *= Math.pow(0.975, dt * 60);
            m.oY *= Math.pow(0.975, dt * 60);
            const node = nodesRef.current.get(m.id);
            if (!node) continue;
            const d = Math.max(0, m.d);
            const rot = Math.sin(amb!.now * 0.55 + m.sway) * 3.2;
            const scl = Math.min(1, Math.pow(d, 1.15) * 1.25); // 与 pos 同一缩放（整体等比放大）
            // P1-3（20260831）：远景灯停内部动画层（halo/光斑/涟漪/火焰动画 none），
            // 合成层数随远景灯比例大幅下降——老内核软渲染逐层合成的主成本来源
            node.classList.toggle("rz-far", d < 0.15);
            const li = lanternXY(m);
            node.style.transform =
                `translate3d(${li.x}px, ${li.y}px, 0) translate(-50%, -50%) scale(${scl}) rotate(${rot}deg)`;
            node.style.opacity = String(0.45 + 0.55 * Math.pow(d, 0.8));
            // pointerEvents 只在真正换档时写（逐帧写一个几乎不变的属性会白白触发样式失效计算）
            const pe = d < 0.24 ? "none" : "auto";
            if (pe !== m._pe) {
                m._pe = pe;
                node.style.pointerEvents = pe;
            }
            // 性能：filter/zIndex 只在景深换档（0.05 一档）时重写——filter 逐帧变化
            // 会强制元素重栅格化（GPU 最贵操作）；降频后亮度/层级渐变肉眼不可察。
            // hue-rotate(0deg) 为无效操作，灯型不变时省略
            const dq = Math.round(d * 20) / 20;
            if (dq !== m._dq) {
                m._dq = dq;
                node.style.zIndex = String(200 + Math.round(dq * 1000));
                node.style.filter =
                    m.hue === 0
                        ? `brightness(${(0.72 + 0.34 * dq) * m.bright})`
                        : `brightness(${(0.72 + 0.34 * dq) * m.bright}) hue-rotate(${m.hue}deg)`;
            }
            // 水面亮斑：原来每帧每灯一次 querySelector（22 次/帧、约 1300 次/秒）。
            // 缓存子节点引用，只在「节点换了身份」时重查——React 换 key/重挂载后旧引用
            // 会变成游离节点，所以用身份判断而不是查一次就永久信任。
            if (m._poolNode !== node) {
                m._poolNode = node;
                m._pool = node.querySelector<HTMLElement>(".rz-pool");
            }
            if (m._pool) m._pool.style.opacity = String(0.4 + 0.6 * d);
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

        // 软渲染/老内核检测（20260831）：无 WebGL = 无 GPU 合成与硬件光栅化，
        // canvas 全屏重绘与 DOM transform 动画全部 CPU 软件绘制，帧成本数倍于
        // 硬件渲染——必须走降级（dpr 1 + 45fps 节流 + 水流带减速路径），否则
        // "一卡一卡"（帧成本超 16.7ms 预算导致的掉帧）。20260905：帧率由
        // 30fps 提到 45fps（用户反馈 30fps 下流动仍不流畅），且氛围装饰
        // （星光/萤火虫/流星）不再被软渲染连坐关闭，只随系统偏好
        const softRender = !(
            document.createElement("canvas").getContext("webgl") ||
            document.createElement("canvas").getContext("experimental-webgl")
        );
        const calcDpr = () => Math.min(softRender ? 1 : DPR_CAP, window.devicePixelRatio || 1);

        /* 纯几何同步（不重建粒子/静态层）：拖动窗口时每帧只做这一趟，
           否则防抖窗口内 canvas 的 CSS 尺寸停在旧值，放大窗口会在右侧/下侧露出
           .rz-root 的底色黑边。静态层被 drawImage 拉伸贴上去（短暂发虚，松手即锐）。 */
        const applySize = () => {
            const w = window.innerWidth;
            const h = window.innerHeight;
            const dpr = calcDpr();
            const v = viewRef.current;
            if (w === v.w && h === v.h && dpr === v.dpr) return; // 幂等：手机 URL 栏/软键盘抖动不打转
            v.dpr = dpr;
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            canvas.style.width = w + "px";
            canvas.style.height = h + "px";
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            layout(w, h);
        };

        const applyResize = () => {
            const w = window.innerWidth;
            const h = window.innerHeight;
            const dpr = calcDpr();
            const v = viewRef.current;
            if (w === v.w && h === v.h && dpr === v.dpr && baseBack && baseFront) return; // 幂等早退
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
            loadMoonTex(); // 第 37 轮：提前开始加载（renderBase 前），缩短 fallback 暴露时间
            // 纹理已就绪就标 true：drawScene 里那个「纹理到达后补画一次」的回调是同步执行的
            // （loadMoonTex 已加载时立即回调），标 false 会让每次 resize 白跑两遍 renderBase
            //（含月面 10-15 万像素循环）
            viewRef.current.texApplied = !!moonTexA;
            renderBase(baseBack, baseFront);
        };

        // resize 防抖（20260912）：下面这一趟会重建全部粒子 + 两张全屏画布 + renderBase
        // （含月面 10-15 万像素逐像素循环），老设备上拖窗口＝每个事件"重开一次场景"，
        // 直接卡成 PPT。尾防抖 150ms：拖动期间只记住尺寸，停下后一次性重建。
        // 拖动期间走 applySize（几何即时同步，无黑边）；首次仍同步执行，不留白屏。
        const RESIZE_DEBOUNCE_MS = 150;
        let resizeTimer = 0;
        let sizeRaf = 0;
        const onResize = () => {
            if (!sizeRaf) {
                sizeRaf = requestAnimationFrame(() => {
                    sizeRaf = 0;
                    if (!disposed) applySize();
                });
            }
            if (resizeTimer) window.clearTimeout(resizeTimer);
            resizeTimer = window.setTimeout(() => {
                resizeTimer = 0;
                if (disposed) return;
                applyResize();
            }, RESIZE_DEBOUNCE_MS);
        };

        applyResize();
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
            // 软渲染降频（20260831 初版 30fps 每 2 帧处理 1 次；20260905 用户反馈
            // "流动不流畅/萤火虫没了" → 帧率提到 45fps = 每 4 帧处理 3 帧（预算
            // 22ms），并只降帧率、不再把氛围装饰连坐关掉；硬件渲染不受影响
            if (softRender && (++softSkip & 3) === 3) {
                raf = requestAnimationFrame(frame);
                return;
            }
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            // P2-3（20260831）动态降级：实测帧耗时（rAF 间隔含绘制成本），EMA 平滑后
            // 超预算自动切 reduced 渲染路径（水流带减速/视差归零等成本控制），预算
            // 恢复自动还原；滞回 13ms 进 / 9ms 出防抖——GPU 忙时自动降级；软渲染
            // 直接静态进 reduced（softRender）。20260905：reduced 只剩成本控制，
            // 氛围装饰（星光/萤火虫/流星）改由 sysReduce（系统偏好）单独门控
            const fms = now - lastFrameT;
            lastFrameT = now;
            perfEma = perfEma * 0.92 + Math.min(50, fms) * 0.08;
            if (!perfDynReduce && perfEma > 13) perfDynReduce = true;
            else if (perfDynReduce && perfEma < 9) perfDynReduce = false;
            if (amb) amb.now += dt;
            mouseRef.current.x += (mouseRef.current.tx - mouseRef.current.x) * 0.05;
            mouseRef.current.y += (mouseRef.current.ty - mouseRef.current.y) * 0.05;
            drawScene(
                ctx,
                amb ? amb.now : 0,
                reduced() || perfDynReduce || softRender, // 性能降级（水流带减速等）
                reduced(), // 系统级装饰门控：星光/萤火虫/流星只随系统偏好（20260905）
                baseBack!,
                baseFront!
            );
            driveLanterns(dt);
            if (!reduced()) scrollTick(dt); // 气泡滚动是用户主动操作，不受动态降级影响
            raf = requestAnimationFrame(frame);
        };

        const reduced = () =>
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        // P2-3 动态降级状态（frame 闭包内）：帧耗时 EMA + 降级标志 + 上一帧时间戳
        let lastFrameT = performance.now();
        let perfEma = 16.7;
        let perfDynReduce = false;
        // 软渲染 45fps 节流计数器（每 4 帧跳过 1 帧）
        let softSkip = 0;

        raf = requestAnimationFrame(frame);

        // 后台标签暂停（20260912）：切走时掐掉 rAF 链，切回时重置时间基准再无跳变续上。
        // 现代浏览器本来就会挂起后台标签的 rAF，但老内核/webview 不保证；这一页每帧画满屏
        // 加 22 盏灯的图层，后台空转纯烧 CPU。灯的位置是按帧积分（暂停即静止、切回不跳），
        // 唯一需要处理的是回来第一帧的 dt——重置 last 让它从 0 重新累积。
        const onVisibility = () => {
            if (document.hidden) {
                if (raf) { cancelAnimationFrame(raf); raf = 0; }
            } else if (!raf && !disposed) {
                last = performance.now();
                lastFrameT = performance.now();
                perfEma = 16.7; // 旧帧耗时样本（后台期间不可信）也一并丢掉
                raf = requestAnimationFrame(frame);
            }
        };
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            disposed = true;
            cancelAnimationFrame(raf);
            if (sizeRaf) cancelAnimationFrame(sizeRaf);
            if (resizeTimer) window.clearTimeout(resizeTimer);
            document.removeEventListener("visibilitychange", onVisibility);
            window.removeEventListener("resize", onResize);
            window.removeEventListener("mousemove", onMove);
        };
    }, []);

    /* 留言获取 + 点灯 */
    /* `?lid=<id>` 定位（20260923）：审核结果通知里的「去看看」跳到 `/guestbook?lid=<id>`，
       要把那盏灯找出来给用户看。lid 在挂载时从地址栏读一次（不跟 URL 变化走：这个页面
       自身不产生 lid，只有外部链接带进来）。
       `locateFromLidRef` 是"给上面的挂载 effect 用的句柄"——真正的实现定义在下面
       （要用 openWish / fetchMyAlbum），而 effect 的依赖数组是空的，只认第一次渲染的闭包；
       用 ref 传一份最新的，公开池加载完调一次。 */
    const [lid] = useState(() => {
        const n = Number(new URLSearchParams(window.location.search).get("lid"));
        return Number.isFinite(n) && n > 0 ? n : 0;
    });
    const locatedRef = useRef(false); // 一次会话只定位一次（重试无意义，且会反复抢弹窗）
    const locateFromLidRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        let cancelled = false;
        const initLights = (msgs: string[]) => {
            if (cancelled) return;
            const v = viewRef.current;
            const want = Math.round(((v.w * v.h) / (1920 * 1080)) * 16) + 8;
            const count = Math.max(8, Math.min(22, want));
            lanternCountRef.current = count;
            const metas: LanternMeta[] = [];
            const views: Wish[] = [];
            for (let i = 0; i < count; i++) {
                // 河灯散布整个河面宽度（河道两侧也适当有灯），不挤在河心
                const u = 0.15 + Math.random() * 0.7; // 河面加宽后灯散布更开（0.15-0.85）
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
            // 入场渐显（加载幕多停留 1 秒，让"河灯将明"的氛围充分呈现）
            setTimeout(() => {
                if (cancelled) return;
                requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
            }, 1000);
        };

        initLights(DEMO_MESSAGES.slice(0, 12));

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        fetch(`${runtimeBaseURL}/api/public/board`, { signal: ctrl.signal })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad status"))))
            .then((j: unknown) => {
                const data = (j as { data?: unknown })?.data;
                const arr = Array.isArray(data)
                    ? (data as Array<{ talkKey?: unknown; content?: unknown; cat?: unknown; v?: unknown; author?: unknown; createTime?: unknown }>)
                    : Array.isArray(j)
                      ? (j as Array<{ talkKey?: unknown; content?: unknown; cat?: unknown; v?: unknown; author?: unknown; createTime?: unknown }>)
                      : [];
                const items = arr
                    .map((x) => ({
                        id: Number(x?.talkKey ?? 0),
                        msg: String(x?.content ?? "").trim(),
                        cat: CATS.includes(String(x?.cat ?? "")) ? String(x.cat) : "",
                        v: [0, 1, 2].includes(Number(x?.v)) ? Number(x.v) : -1,
                        author: String(x?.author ?? ""),
                        time: String(x?.createTime ?? "").slice(5, 16), // MM-DD HH:mm
                    }))
                    .filter((i) => i.msg);
                if (items.length >= 1) {
                    // 留言少于灯数时裁掉多余灯：否则 items[i % items.length] 取模回绕，
                    // 同一条留言会被分配到多盏灯同时漂浮（"双胞胎"）——重复不是轮播造成的，
                    // 是填满河面时取模的必然结果；裁到与留言数一致后每条留言只占一盏灯
                    //（1-3 条留言同理：哪怕河面变疏也不该出现同一条留言重复占灯）
                    const over = lanternCountRef.current - items.length;
                    if (over > 0) {
                        // 只裁 meta 与数量，DOM 由 React 在 views 收缩时自行卸载
                        //（手动 remove 会与 React 卸载冲突）；nodesRef 残留条目无引用方，无害
                        metaRef.current = metaRef.current.slice(0, items.length);
                        lanternCountRef.current = items.length;
                    }
                    // 全量数据入批次轮播池；初始灯承载全部留言（池 > 灯时才截最新一批）
                    allTalksRef.current = items;
                    batchPtr.current = lanternCountRef.current || items.length;
                    setLanterns((prev) =>
                        prev.slice(0, lanternCountRef.current).map((p, i) => {
                            const it = items[i % items.length];
                            // 同步 meta 的 v：圆笼灯（v=2）的涟漪偏移以 meta.v 为准
                            const meta = metaRef.current[i];
                            if (meta && it.v >= 0) meta.v = it.v;
                            return { ...p, msg: it.msg, cat: it.cat || catOf(it.msg), v: it.v >= 0 ? it.v : p.v, author: it.author, time: it.time };
                        })
                    );
                }
                // 公开池就绪后再试一次 `?lid=` 定位（通知链接进来的场景）
                locateFromLidRef.current?.();
            })
            .catch(() => {})
            .finally(() => clearTimeout(timer));

        return () => {
            cancelled = true;
            ctrl.abort();
        };
    }, []);

    /* 气泡长文滚动：JS 逐帧显式推进（CSS animation 偶发卡死不滚，改为可控的 transform） */
    /* 气泡节点表已删除（20260912）：bubbleRefs 只写不读，每次河灯列表重建都白写 22 次；
       气泡滚动走的是 scrollState + restartScroll(handle)，不需要这张表 */
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
        setReclaimArm(false); // 换一盏灯，收回确认态复位
        setReclaimErr("");
    };
    const closeModal = () => {
        // 弹窗关闭后，悬浮于河灯上的文本气泡一并收起
        document.querySelectorAll<HTMLElement>(".rz-open").forEach((el) => {
            el.classList.remove("rz-open");
        });
        setModal(null);
        setReclaimArm(false);
        setReclaimBusy(false);
        setReclaimErr("");
        // 从灯影集进入的详情弹窗：关闭后重新展开灯影集，并还原到原浏览位置
        if (albumResumeRef.current !== null) {
            const pos = albumResumeRef.current;
            albumResumeRef.current = null;
            setAlbumOpen(true);
            requestAnimationFrame(() => {
                if (albumListRef.current) albumListRef.current.scrollTop = pos;
            });
        }
    };
    /* 触屏打开弹窗后，同一次点按的合成 click 会落在遮罩上误关；
       800ms 内的遮罩点击视为那次点按的跟随事件，忽略 */
    const dismissModal = () => {
        if (Date.now() - lastWishTouch.current < 800) return;
        closeModal();
    };

    /* 此心为灯：把留言放下河——新灯在近景出现，随后随流漂远 */
    const dropLantern = async () => {
        const msg = wishText.trim();
        if (!msg || wishBusy) return;
        setWishBusy(true);
        try {
            // 留名规则：留空→纯匿名（无名）；与真实账号昵称一致→正常留名；
            // 其他自定义留名→视为"匿名·自定义留名"，归入匿名类（作者维度）
            const rawAuthor = wishAuthor.trim().slice(0, 20);
            const author =
                rawAuthor === "" ? "" : rawAuthor === profileNickRef.current ? rawAuthor : `匿名·${rawAuthor}`;
            const token = localStorage.getItem("tokenKey");
            const res = await fetch(`${runtimeBaseURL}/api/public/board`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                body: JSON.stringify({ content: msg, cat: wishCat, v: wishV, talkTitle: "", author }),
            });
            if (!res.ok) throw new Error("bad status");
            const jj = (await res.json()) as { code?: number; message?: string; data?: unknown };
            if (jj?.code !== 200) throw new Error(jj?.message || "留言失败");
            // 人工复核开启时新灯进待审（后端 approved=0 → data="Pending"）：
            // 灯仍放上河面漂流但处于"未点亮"态（20260905 #4b：河面不给亮灯
            // 光效——无光晕/水面光斑/烛火，见 .rz-lantern.rz-unlit），不入
            // 公开列表；灯影集「我的河灯」页签可见，状态标签「待审」，
            // 审核通过后自动入册点亮
            const pending = jj?.data === "Pending";
            setWishPending(pending);
            const metas = metaRef.current;
            const id = 10000 + wishSeq.current++;
            metas.push({
                id,
                v: wishV,
                u: 0.32 + Math.random() * 0.36,
                d: 0.8, // 近景放下，开场即见
                w: 0.03 + Math.random() * 0.04,
                sway: Math.random() * Math.PI * 2,
                hue: 0,
                bright: 1,
                oX: 0,
                oY: 0,
                rip: 0.8,
                ripT: -1,
            });
            metaRef.current = metas;
            // 待审（approved=0）：河面按"未点亮"渲染（rz-unlit）；通过态不带
            // approved → 默认亮灯（undefined 与 1 均视为已点亮）
            const wish: Wish = { id, v: wishV, msg, cat: wishCat, author, time: shortTime(new Date()), approved: pending ? 0 : undefined };
            // 快照刚放的灯："再看一眼"时按同一盏灯重新点放（留名/灯型/内容一致）
            lastDroppedWish.current = wish;
            setLanterns((prev) => [...prev, wish]);
            // 作废灯影集缓存 + 「我的河灯」懒加载标记：下次打开灯影集重拉一次即可看到
            // 刚放的灯（后端 POST 只回 "Created"/"Pending"，不返回新 talkKey，
            // 所以本地补不出池子条目——交给那一次重拉）
            boardCacheRef.current = null;
            albumMineLoadedRef.current = false;
            setWishDone(true);
        } catch (err) {
            setWishBusy(false);
            // 登录失效/未登录 → 弹公告引导登录
            if (String(err).includes("登录")) setNoticeOpen(true);
        }
    };
    const closeWishFlow = () => {
        setWishOpen(false);
        setWishDone(false);
        setWishPending(false);
        setWishBusy(false);
        setWishStep(0);
        setWishText("");
        setWishAuthor("");
    };

    /* 此心为灯：未登录先弹留言板公告；已登录进入留言流程并预填账号昵称 */
    const openWishFlow = async () => {
        if (!localStorage.getItem("tokenKey")) {
            setNoticeOpen(true);
            return;
        }
        setWishText("");
        setWishStep(0);
        setWishDone(false);
        setWishPending(false);
        setWishOpen(true);
        if (!wishAuthor) {
            try {
                const token = localStorage.getItem("tokenKey");
                const res = await fetch(`${runtimeBaseURL}/api/protected/profile`, {
                    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
                });
                const j = (await res.json()) as { data?: { nickname?: string } };
                if (j?.data?.nickname) {
                    profileNickRef.current = j.data.nickname;
                    setWishAuthor(j.data.nickname);
                }
            } catch {
                /* 拉取失败则留空，可手填或匿名 */
            }
        }
    };

    /* 我的河灯（20260905 issue8）：本人全部河灯（含待审 0/未通过 2）。
       公开列表只放行通过态——被审核拦下的灯只有这里能看到状态并收回 */
    const fetchMyAlbum = async (): Promise<AlbumItem[] | null> => {
        const token = localStorage.getItem("tokenKey");
        if (!token) return null;
        try {
            const res = await fetch(`${runtimeBaseURL}/api/protect/board/mine`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const j = (await res.json()) as { data?: unknown };
            const arr = Array.isArray(j?.data)
                ? (j.data as Array<{ talkKey?: unknown; v?: unknown; cat?: unknown; author?: unknown; content?: unknown; createTime?: unknown; approved?: unknown; rejectReason?: unknown }>)
                : [];
            const mine = arr.map((x) => ({
                id: Number(x?.talkKey ?? 0),
                v: [0, 1, 2].includes(Number(x?.v)) ? Number(x.v) : 0,
                cat: CATS.includes(String(x?.cat ?? "")) ? String(x.cat) : catOf(String(x?.content ?? "")),
                author: String(x?.author ?? ""),
                msg: String(x?.content ?? ""),
                time: String(x?.createTime ?? "").slice(0, 16),
                mine: true,
                approved: [0, 1, 2].includes(Number(x?.approved)) ? Number(x.approved) : 1,
                // 驳回理由（20260923）：空串/缺失都归 null（后端也是这个口径）
                reason: String(x?.rejectReason ?? "").trim() || null,
            }));
            setAlbumMine(mine);
            return mine;
        } catch {
            /* 拉取失败则保持旧数据（公开列表仍可用） */
            return null;
        }
    };

    /* `?lid=` 定位的实现（20260923，句柄注册在文件上方的挂载 effect 里）。
       两级查找：① **我的河灯**——审核结果通知只有登录用户收得到，而待审/未通过的灯
       在公开池里根本不存在（驳回通知点进来必然走这一支）；顺带把 mine 标记带上，
       弹窗里才有「收回河灯」。② 公开池兜底（别人的灯、或未登录点进来）。
       都找不到就**安静兜底**：页面本身已经打开，不再弹提示（用户拍板"定不到就安静
       兜底回页面"）。 */
    const locateFromLid = useCallback(async () => {
        if (!lid || locatedRef.current) return;
        let hit: AlbumItem | null = null;
        let owned = false;
        const mine = await fetchMyAlbum();
        if (mine) {
            hit = mine.find((x) => x.id === lid) ?? null;
            owned = !!hit;
        }
        if (!hit) {
            const pub = allTalksRef.current.find((t) => t.id === lid);
            if (pub) {
                hit = {
                    id: pub.id,
                    v: pub.v,
                    cat: pub.cat,
                    // author/time 在 Wish 上是可选（老灯没有），AlbumItem 上必填 ⇒ 兜空串
                    author: pub.author ?? "",
                    msg: pub.msg,
                    time: pub.time ?? "",
                    mine: false,
                    approved: 1, // 公开池里的灯必然是放行态
                    reason: null,
                };
            }
        }
        if (!hit) return; // 定不到：安静兜底
        locatedRef.current = true;
        // 这盏灯此刻正漂在河面上就连气泡一起展开：按留言原文找灯位（灯位与留言的绑定
        // 会随批次轮播变化，只有 DOM 上的当前渲染是可信的）
        const node = Array.from(document.querySelectorAll<HTMLElement>("[data-lid]")).find(
            (el) => (el.querySelector(".rz-msg")?.textContent || "").trim() === hit!.msg
        );
        const lanternId = node ? Number(node.dataset.lid) : -1; // -1 找不到节点时弹窗照开、只没气泡
        openWish({
            id: lanternId,
            v: hit.v,
            msg: hit.msg,
            cat: hit.cat,
            author: hit.author,
            time: hit.time,
            talkKey: hit.id,
            mine: owned,
            approved: hit.approved,
            reason: hit.reason ?? null,
        });
        // openWish/fetchMyAlbum 只读写 ref 与 setState（见 lanternNodes 那段"安全前提"），
        // **不能**把它们写进依赖：它们每次渲染都换身份，而下面那个 effect 以本回调为依赖
        // ⇒ 会变成每渲染一次就重跑一遍定位（定不到时每次都多发一次 /board/mine 请求）
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lid]);

    useEffect(() => {
        locateFromLidRef.current = () => void locateFromLid();
    });
    // 挂载即试一次（我的河灯那支不依赖公开池）；公开池加载完会再试一次（见上方 fetch 的 then）
    useEffect(() => {
        void locateFromLid();
    }, [locateFromLid]);

    /* 收回河灯（20260905 issue8）：删除自己放的河灯。
       两步确认防误删：第一击武装（按钮变「确认收回？」），第二击执行 DELETE。
       成功 → 从灯影集两数据源 + 河流轮播池剔除，撤下弹窗 */
    /* 灯影集数据缓存（20260912）：打开灯影集原来每次都全量重拉两个接口——
       挂载时已经拉过一次全量公开列表，同一次会话里同一份数据被拉 3 次。
       TTL 内直接复用；放灯/收回会作废缓存（见 dropLantern）。 */
    const BOARD_CACHE_TTL = 20000;
    const albumSeqRef = useRef(0);           // 竞态守卫：只认最后一次请求的响应
    const albumMineLoadedRef = useRef(false); // 「我的河灯」按需拉取的一次性标记
    const boardCacheRef = useRef<{ at: number; items: AlbumItem[] } | null>(null);

    const reclaimLantern = async () => {
        const tk = modal?.talkKey;
        const gid = modal?.id;
        if (!tk || !modal?.mine || reclaimBusy) return;
        if (!reclaimArm) {
            setReclaimArm(true);
            return;
        }
        setReclaimBusy(true);
        setReclaimErr("");
        try {
            const token = localStorage.getItem("tokenKey");
            const res = await fetch(`${runtimeBaseURL}/api/protect/board/mine/${tk}`, {
                method: "DELETE",
                headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            });
            const j = (await res.json()) as { code?: number; message?: string };
            if (!res.ok || j?.code !== 200) throw new Error(j?.message || "收回失败");
            setAlbumItems((prev) => prev.filter((x) => x.id !== tk));
            setAlbumMine((prev) => prev.filter((x) => x.id !== tk));
            if (allTalksRef.current.length) {
                // 两个写入点的结构不同：挂载时入池的条目只有 id（无 talkKey），
                // 开灯影集时入池的条目两者都有。只比 talkKey 会让「没开过灯影集就收回」
                // 变成空操作——被收回的留言仍留在轮播池里继续漂（20260912 修）
                allTalksRef.current = allTalksRef.current.filter((t) => t.talkKey !== tk && t.id !== tk);
            }
            // 河面这盏灯（灯影集点起的实例）一并撤走
            setLanterns((prev) => prev.filter((p) => p.id !== gid));
            closeModal();
        } catch (err) {
            setReclaimBusy(false);
            setReclaimArm(false);
            setReclaimErr(String(err).replace(/^Error:\s*/, "") || "收回失败，请稍后再试");
        }
    };

    /* 灯影集：打开时拉取全部留言。
       20260912：数据在 TTL 内复用（挂载时已拉过一次全量）+ 竞态守卫（连点/快速开关时
       只认最后一次请求的响应，旧数据后到不再覆盖新数据）；「我的河灯」改为切到该页签
       时才拉（原来看时序页签也会多拉一次 /api/protect/board/mine）。
       放灯后会作废缓存（见 dropLantern），所以"刚放的灯要重开一次灯影集才看到"的
       旧体验不变，但同一次浏览里反复开关灯影集不再重复打后端 */
    const openAlbum = async () => {
        setAlbumOpen(true);
        setAlbumSearch(false);
        setAlbumQuery("");
        if (albumTabs === "mine") {
            albumMineLoadedRef.current = true;
            fetchMyAlbum();
        }
        const cached = boardCacheRef.current;
        if (cached && Date.now() - cached.at < BOARD_CACHE_TTL) {
            setAlbumItems(cached.items);
            return; // 复用缓存：不动轮播池指针（重置指针会让轮播从头开始）
        }
        const seq = ++albumSeqRef.current;
        try {
            // 带上 token：后端据此标记每条留言是否当前用户所放（"我的河灯"）
            const token = localStorage.getItem("tokenKey");
            const res = await fetch(`${runtimeBaseURL}/api/public/board`, {
                headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            });
            const j = (await res.json()) as { data?: unknown };
            const arr = Array.isArray(j?.data)
                ? (j.data as Array<{ talkKey?: unknown; v?: unknown; cat?: unknown; author?: unknown; content?: unknown; createTime?: unknown; mine?: unknown; approved?: unknown }>)
                : [];
            if (seq !== albumSeqRef.current) return; // 过期响应：丢弃（下一次请求才是权威）
            const items: AlbumItem[] = arr.map((x) => ({
                id: Number(x?.talkKey ?? 0),
                v: [0, 1, 2].includes(Number(x?.v)) ? Number(x.v) : 0,
                cat: CATS.includes(String(x?.cat ?? "")) ? String(x.cat) : catOf(String(x?.content ?? "")),
                author: String(x?.author ?? ""),
                msg: String(x?.content ?? ""),
                time: String(x?.createTime ?? "").slice(0, 16),
                mine: x?.mine === true,
                approved: Number(x?.approved ?? 1), // 公开列表全为通过态
            }));
            setAlbumItems(items);
            // 顺带刷新河流批次轮播池（新放灯的留言进入轮播序列，指针回到最新一批）
            const talks: Wish[] = arr
                .map((x) => ({
                    id: Number(x?.talkKey ?? 0),
                    v: [0, 1, 2].includes(Number(x?.v)) ? Number(x.v) : 0,
                    cat: CATS.includes(String(x?.cat ?? "")) ? String(x.cat) : catOf(String(x?.content ?? "")),
                    author: String(x?.author ?? ""),
                    msg: String(x?.content ?? ""),
                    time: String(x?.createTime ?? "").slice(0, 16),
                    talkKey: Number(x?.talkKey ?? 0), // 收回河灯时按留言 id 从轮播池剔除
                }))
                .filter((t) => t.msg);
            boardCacheRef.current = { at: Date.now(), items };
            if (talks.length >= 4) {
                allTalksRef.current = talks;
                batchPtr.current = lanternCountRef.current || talks.length;
            }
        } catch {
            /* 拉取失败则保持空卷 */
        }
    };

    /* 灯影集：选中一条留言 → 河灯排到近景列队起始位置 + 亮起气泡 + 打开弹窗详情 */
    const lightFromAlbum = (it: AlbumItem) => {
        const metas = metaRef.current;
        const id = 10000 + wishSeq.current++;
        metas.push({
            id,
            v: it.v,
            u: 0.3 + Math.random() * 0.4,
            d: 0.88, // 列队起始位置：眼前近景
            w: 0.03 + Math.random() * 0.04,
            sway: Math.random() * Math.PI * 2,
            hue: 0,
            bright: 1,
            oX: 0,
            oY: 0,
            rip: 0.6,
            ripT: -1,
        });
        metaRef.current = metas;
        // talkKey/mine/approved 随 Wish 带到弹窗（20260905 issue8）：自己点开的河灯
        // 弹窗可显示审核状态标签 + 收回按钮（收回按 talkKey 调 DELETE）
        const wish: Wish = {
            id,
            v: it.v,
            msg: it.msg,
            cat: it.cat,
            author: it.author,
            time: it.time,
            talkKey: it.id,
            mine: it.mine,
            approved: it.approved,
            reason: it.reason ?? null, // 驳回理由（20260923）随行带到弹窗
        };
        setLanterns((prev) => [...prev, wish]);
        // 详情弹窗打开期间隐藏灯影集（避免两个浮层重叠），关闭后恢复到原浏览位置
        // （记录列表 scrollTop，closeModal 时重新展开并还原；页签/筛选/检索状态
        // 是独立 state 不受 albumOpen 影响，天然保留）
        albumResumeRef.current = albumListRef.current?.scrollTop ?? 0;
        setAlbumOpen(false);
        requestAnimationFrame(() => openWish(wish)); // 气泡 + 弹窗详情
    };
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") closeModal(); // 与遮罩/关闭按钮同路径：弹窗关闭同时恢复灯影集
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    /* QA 钩子：暴露批次推进，供自动化验证轮播（生产环境无害）。
       advanceMsg 已 useCallback 稳定身份 → 这个 effect 只在挂载时跑一次（原来是
       没有依赖数组，每次 render 都新建一个对象写 window） */
    useEffect(() => {
        (window as unknown as { __qaBoard?: { advanceMsg: (id: number) => void } }).__qaBoard = { advanceMsg };
    }, [advanceMsg]);

    /* 灯影集：按当前页签排序 + 类型筛选 + 按检索词过滤
       "我的河灯"数据源 = albumMine（本人全部河灯，含待审 0 / 未通过 2——公开列表
       只放行通过态，看不到自己的待审/被驳回的灯，20260905 issue8）；
       其余页签 = 公开列表 albumItems。
       useMemo：这段要复制数组三遍 + 中文 localeCompare 排序，而河面主循环每 2.5-4s
       就有一次 setLanterns 触发的整组件重渲染、输入框每敲一个字也重渲染一次——
       没必要跟着跑；卷册没打开时（下面 {albumOpen && ...} 之外无人消费）直接给空数组 */
    const albumSorted = useMemo(() => {
        if (!albumOpen) return [] as typeof albumItems;
        const q = albumQuery.trim();
        const albumBase = albumTabs === "mine" ? albumMine : albumItems;
        return [...albumBase]
            .filter((it) => albumTabs !== "mine" || it.mine) // mine 页签数据源已全为本人，此过滤保底
            .filter((it) => albumCatFilter.length === 0 || albumCatFilter.includes(it.cat))
            .filter((it) => q === "" || it.msg.includes(q) || it.author.includes(q) || it.cat === q)
            .sort((a, b) => {
                if (albumTabs === "cat") return a.cat.localeCompare(b.cat, "zh") || b.id - a.id;
                // 我的河灯：仅按时间（新近在前）
                if (albumTabs === "mine") return a.time < b.time ? 1 : a.time > b.time ? -1 : b.id - a.id;
                const cmp = a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
                return albumTimeAsc ? cmp || a.id - b.id : -cmp || b.id - a.id;
            });
    }, [albumOpen, albumItems, albumMine, albumTabs, albumCatFilter, albumQuery, albumTimeAsc]);

    /* 河灯 DOM：用 useMemo 固定元素引用 —— React 对「同一个元素对象」会直接跳过整棵
       子树的协调，于是输入框/灯影集检索/弹窗等高频 state 变化不再带着 22 盏灯的 200+
       元素一起重渲染。位置与透明度永远由 rAF 直写 DOM，React 只在下面三个依赖变化时
       重建（灯列表变化=批次轮换/放灯/收回；精灵图就绪；弹窗开关）。
       安全前提：JSX 里用到的 handler（openWish/toggleMsg/restartScroll）只读写 ref 与
       setState，复用旧闭包无副作用；若将来它们开始读 state，必须把那个 state 加进依赖 */
    const lanternNodes = useMemo(
        () =>
            lanterns.map((ln) => (
                <div
                    key={ln.id}
                    data-lid={ln.id}
                    ref={(el) => {
                        nodesRef.current.set(ln.id, el);
                    }}
                    className={
                        "rz-lantern" +
                        // 20260905 #4b：approved 0(待审)/2(未通过) = 未点亮——
                        // 河面只放暗灯笼轮廓，不渲染亮灯光效；undefined/1 = 已点亮
                        (ln.approved === undefined || ln.approved === 1 ? "" : " rz-unlit")
                    }
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
                    <div className="rz-bubble">
                        <div className="rz-scroll">
                            <div className="rz-msg">{ln.msg}</div>
                            {(ln.author || ln.time) && (
                                <div className="rz-who">
                                    {ln.author || "无名"} · {ln.time || ""}
                                </div>
                            )}
                        </div>
                        <span className="rz-seal">{ln.cat}</span>
                    </div>
                </div>
            )),
        [lanterns, sprites, modal]
    );

    if (sprites.length === 0) return <div className="rz-root" />;

    return (
        <>
            <div className="rz-root">
            <canvas ref={canvasRef} className="rz-canvas" aria-hidden />
            <div ref={layerRef} className="rz-lanterns" aria-hidden>
                {lanternNodes}
            </div>
            <div className="rz-ui">
                <header className="rz-title">
                    <i />
                    河灯寄语
                    {/* 诗句：位于标题正下方、相对标题水平居中；右→左古文顺序 */}
                    <div className="rz-couplet">
                        <span>
                            <b>「</b>醉后不知天在水<b>」</b>
                        </span>
                        <span>
                            <b>「</b>满船清梦压星河<b>」</b>
                        </span>
                    </div>
                </header>
                <p className="rz-hint">灯浮星河处，停舟问归期。 轻触荧惑光，细听灯中语。</p>
                {/* 左下角留言入口组 */}
                <button className="rz-album-btn" type="button" onClick={openAlbum}>
                    <svg viewBox="0 0 1024 1024" width="30" height="30" fill="currentColor" aria-hidden>
                        <path d="M637.213 212.88H765.33v372.705H637.213V212.88zM153.856 954.683h124.235V768.331h-62.12v-23.293h62.12V522.502h-62.12V499.21h62.12V271.392h-62.12v-23.294h62.12V61.745H153.856z" />
                        <path d="M311.086 69.316v892.939h559.058V69.315H311.086z m477.536 539.638H613.916V189.661h174.706v419.293z" />
                    </svg>
                    <span>灯影集</span>
                </button>
                <button className="rz-wish-btn" type="button" onClick={openWishFlow}>
                    <i />
                    此心为灯
                </button>
            </div>
            {/* 此心为灯 · 留言流程：选灯型 → 选印章 → 书写放下 */}
            {wishOpen && (
                <div className="rz-modal rz-wish-modal" onClick={closeWishFlow} role="dialog" aria-modal="true" aria-label="点一盏河灯">
                    <div
                        className="rz-modal-box rz-wish-box"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {wishStep === 0 && (
                            <div className="rz-wish-step">
                                <h3 className="rz-wish-title">点一盏河灯</h3>
                                <p className="rz-wish-sub">先挑一盏喜欢的灯</p>
                                <div className="rz-lamp-grid">
                                    {[0, 1, 2].map((lv) => (
                                        <button
                                            key={lv}
                                            type="button"
                                            className={"rz-lamp-card" + (wishV === lv ? " sel" : "")}
                                            onClick={() => setWishV(lv)}
                                        >
                                            <img src={sprites[lv]} alt="" draggable={false} />
                                            <span>{LAMP_NAMES[lv]}</span>
                                        </button>
                                    ))}
                                </div>
                                <div className="rz-wish-foot">
                                    <button type="button" className="rz-wish-ghost" onClick={closeWishFlow}>
                                        再想想
                                    </button>
                                    <button type="button" className="rz-wish-primary" onClick={() => setWishStep(1)}>
                                        下一程
                                    </button>
                                </div>
                            </div>
                        )}
                        {wishStep === 1 && (
                            <div className="rz-wish-step">
                                <h3 className="rz-wish-title">选一枚印章</h3>
                                <p className="rz-wish-sub">为这盏灯盖一枚心印</p>
                                <div className="rz-cat-grid">
                                    {CATS.map((c) => (
                                        <button
                                            key={c}
                                            type="button"
                                            className={"rz-cat-card" + (wishCat === c ? " sel" : "")}
                                            onClick={() => setWishCat(c)}
                                        >
                                            <span className="rz-seal rz-cat-seal">{c}</span>
                                            <span className="rz-cat-name">
                                                <b>
                                                    {c} · {CAT_INFO[c].name}
                                                </b>
                                                <i>{CAT_INFO[c].desc.replace("，", "，\n")}</i>
                                            </span>
                                        </button>
                                    ))}
                                </div>
                                <div className="rz-wish-foot">
                                    <button type="button" className="rz-wish-ghost" onClick={() => setWishStep(0)}>
                                        上一步
                                    </button>
                                    <button type="button" className="rz-wish-primary" onClick={() => setWishStep(2)}>
                                        下一程
                                    </button>
                                </div>
                            </div>
                        )}
                        {wishStep === 2 && !wishDone && (
                            <div className="rz-wish-step">
                                <h3 className="rz-wish-title">以言载灯</h3>
                                <p className="rz-wish-sub">点亮的是灯，留下的是心</p>
                                <textarea
                                    className="rz-wish-input"
                                    value={wishText}
                                    onChange={(e) => setWishText(e.target.value.slice(0, 200))}
                                    placeholder="此刻想说的话…"
                                    rows={4}
                                    maxLength={200}
                                />
                                <div className="rz-wish-count">{wishText.length}/200</div>
                                <div className="rz-wish-author-row">
                                    <input
                                        className="rz-wish-author"
                                        value={wishAuthor}
                                        onChange={(e) => setWishAuthor(e.target.value.slice(0, 20))}
                                        placeholder="留名（默认当前账号昵称）"
                                        maxLength={20}
                                    />
                                    <button
                                        type="button"
                                        className={"rz-wish-anon" + (wishAuthor.trim() === "" ? " on" : "")}
                                        onClick={() => setWishAuthor("")}
                                        title="匿名放灯：清空留名，归入无名"
                                    >
                                        匿名
                                    </button>
                                </div>
                                <div className="rz-wish-foot">
                                    <button type="button" className="rz-wish-ghost" onClick={() => setWishStep(1)}>
                                        上一步
                                    </button>
                                    <button
                                        type="button"
                                        className="rz-wish-primary"
                                        disabled={!wishText.trim() || wishBusy}
                                        onClick={dropLantern}
                                    >
                                        {wishBusy ? "放下中…" : "放下河灯"}
                                    </button>
                                </div>
                            </div>
                        )}
                        {wishDone && (
                            <div className="rz-wish-step rz-wish-done">
                                <div className="rz-wish-done-glow" />
                                <h3 className="rz-wish-title">灯已入河</h3>
                                {wishPending ? (
                                    <p className="rz-wish-sub">
                                        灯入待审，通过后即在河面公开点亮。
                                        可到灯影集「我的河灯」查看状态或收回
                                    </p>
                                ) : (
                                    <p className="rz-wish-sub">{CAT_INFO[wishCat].desc}</p>
                                )}
                                <div className="rz-wish-foot">
                                    <button
                                        type="button"
                                        className="rz-wish-primary"
                                        onClick={() => {
                                            const w = lastDroppedWish.current;
                                            closeWishFlow();
                                            if (!w) return;
                                            // 与灯影集选中同款：灯排到近景列队起始 + 亮起气泡 + 打开弹窗详情
                                            const metas = metaRef.current;
                                            const id = 10000 + wishSeq.current++;
                                            metas.push({
                                                id,
                                                v: w.v,
                                                u: 0.3 + Math.random() * 0.4,
                                                d: 0.88, // 列队起始位置：眼前近景
                                                w: 0.03 + Math.random() * 0.04,
                                                sway: Math.random() * Math.PI * 2,
                                                hue: 0,
                                                bright: 1,
                                                oX: 0,
                                                oY: 0,
                                                rip: 0.6,
                                                ripT: -1,
                                            });
                                            metaRef.current = metas;
                                            const again: Wish = { ...w, id };
                                            setLanterns((prev) => [...prev, again]);
                                            requestAnimationFrame(() => openWish(again)); // 气泡 + 弹窗详情
                                        }}
                                    >
                                        再看一眼
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
            {/* 未登录留言门禁：留言板公告 */}
            {noticeOpen && (
                <div className="rz-modal rz-notice-modal" onClick={() => setNoticeOpen(false)} role="dialog" aria-modal="true" aria-label="留言板公告">
                    <div className="rz-modal-box rz-notice-box" onClick={(e) => e.stopPropagation()}>
                        <h3 className="rz-notice-title">留言板公告</h3>
                        <div className="rz-notice-body">
                            <p>尊敬的访客：</p>
                            <p>本网站当前为非交互式个人站点。留言板等功能仅供内部测试、研究学习使用，暂不对公众开放交互服务。</p>
                            <p>我们正在积极筹备交互式网站备案的转型工作，预计将于12月完成升级。</p>
                            <p>届时，欢迎您再次来访，体验完整的河灯留言互动功能。</p>
                            <p>Saudade Blog</p>
                            <p>2026年8月21日</p>
                        </div>
                        <div className="rz-notice-foot">
                            <button type="button" className="rz-wish-primary" onClick={() => setNoticeOpen(false)}>
                                我知道了
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {/* 灯影集：收录全部留言的古籍卷册 */}
            {albumOpen && (
                <div className="rz-modal rz-album-modal" onClick={() => setAlbumOpen(false)} role="dialog" aria-modal="true" aria-label="灯影集">
                    <div className="rz-album-box" onClick={(e) => e.stopPropagation()}>
                        <button
                            className={"rz-album-find" + (albumSearch ? " on" : "")}
                            type="button"
                            onClick={() => setAlbumSearch((s) => !s)}
                        >
                            <svg viewBox="0 0 1024 1024" width="20" height="20" aria-hidden>
                                <path d="M898.3 420s-56.9 2.6-117.8 30.3c8.6-73.5-13.3-157.4-13.3-157.4s-53 14.6-104.1 43.3c-30.2-50.8-68.9-90.5-68.9-90.5s-38.7 39.7-68.9 90.5c-51-28.6-104.1-43.3-104.1-43.3s-20.9 80.6-13.7 153C351.3 424.5 302 423.3 302 423.3s19.5 107.4 98.8 175.1c34.6 29.5 70.1 52.2 101.2 65.9-30.7 5.8-50.3 14.5-50.3 24.2 0 17.7 65.1 32 145.4 32 80.3 0 145.4-14.3 145.4-32 0-8.6-15.5-16.4-40.6-22.2 31.3-14.4 67-38.1 101.6-69.1 77.8-69.5 94.8-177.2 94.8-177.2" fill="#FCC75B" />
                                <path d="M525.5 627.4c-31.1 0-60.1-18.1-81.6-50.9-20.6-31.5-32-73.2-32-117.4 0-38.3 18.1-83.8 53.6-135.3 26.1-37.8 51.8-64.2 53-65.3 1.8-1.9 4.4-3 7-3s5.2 1 7 3c1.1 1.1 26.8 27.6 53 65.3 35.6 51.4 53.6 97 53.6 135.3 0 44.2-11.4 85.9-32 117.4-21.6 32.8-50.5 50.9-81.6 50.9z m0-347.5c-23 25.4-93.9 109.7-93.9 179.2 0 40.4 10.2 78.3 28.8 106.6 17.7 27 40.9 42 65.1 42 24.3 0 47.4-14.9 65.1-42 18.6-28.3 28.8-66.2 28.8-106.6 0-69.6-71-153.9-93.9-179.2z m2.8 470.1c-39.5 0-76.8-3.4-105-9.6-33.8-7.4-50.3-18-50.3-32.2 0-14.2 16.5-24.8 50.3-32.2 28.2-6.2 65.4-9.6 105-9.6 39.5 0 76.8 3.4 105 9.6 33.8 7.4 50.3 18 50.3 32.2 0 14.2-16.5 24.8-50.3 32.2-28.2 6.1-65.4 9.6-105 9.6z m-135.1-41.9c2.7 2.8 13.1 8.9 39.8 14.2 26.1 5.2 59.9 8 95.3 8s69.2-2.9 95.3-8c26.6-5.3 37-11.4 39.8-14.2-2.7-2.8-13.1-8.9-39.8-14.2-26.1-5.2-59.9-8-95.3-8s-69.2 2.9-95.3 8c-26.7 5.3-37.1 11.4-39.8 14.2z" fill="#ECB823" />
                                <path d="M491.1 708.8c-13.6 0-29.8-3.4-48-10.2-36.6-13.7-78.4-39.6-117.6-73.1-42.4-36.2-67.9-83.4-81.8-116.6-15-35.8-20.1-63-20.2-64.2-0.6-2.9 0.3-5.9 2.2-8.2 1.9-2.2 4.7-3.5 7.7-3.4 1.1 0 28.8 0.7 66.6 10 35 8.6 85.5 26.3 127.9 62.6 39.2 33.5 71.4 70.6 90.6 104.7 20.8 37 24.2 66.8 9.3 84.2-8.1 9.5-20.6 14.2-36.7 14.2z m-245.3-255c2.9 11 8 28.2 16.3 48 13 31 36.9 75.1 76.2 108.7 37.5 32 77.1 56.7 111.7 69.6 30.5 11.4 54 12 62.8 1.7 8.8-10.3 4.6-33.4-11.4-61.8-18.1-32.1-48.7-67.4-86.2-99.4-60.2-51.2-138.9-63.8-169.4-66.8z" fill="#ECB823" />
                                <path d="M488 637.2c-8.9 0-18.1-1.3-27.4-3.8-42.2-11.4-83.9-47-111.4-95.5-18.8-33.2-25.5-81.8-20-144.4 4.1-45.9 13.4-81.9 13.8-83.4 0.6-2.6 2.3-4.7 4.6-6.1 2.3-1.3 5-1.7 7.5-1 1.5 0.4 36.8 10.2 77.9 29.6 56.1 26.4 94.1 56.7 113 89.9 21.7 38.3 32.3 80.2 30 118-2.5 39.3-18.6 69.6-45.6 85.4-12.6 7.6-27 11.3-42.4 11.3zM359.8 325c-7.4 33.5-27.5 143 6.6 203.2 25 44 62.1 76.2 99.4 86.2 20.5 5.5 39.4 3.6 54.8-5.4 21.1-12.4 33.8-37.1 35.9-69.7 2.2-34-7.6-72-27.4-107-34.3-60.2-137.1-97-169.3-107.3z" fill="#ECB823" />
                                <path d="M664.7 561c0 74.6-58.3 141.9-135 141.9-76.6 0-142.4-67.4-142.4-141.9s138.6-184.6 138.6-184.6S664.7 486.5 664.7 561z" fill="#FFFFFF" />
                                <path d="M529.8 712.8c-81.1 0-152.2-70.9-152.2-151.8 0-33.5 24.2-76.2 72-127 34.7-37 69-64.2 70.4-65.3 3.6-2.9 8.6-2.9 12.2 0 1.4 1.1 35.6 28.4 70.4 65.3 47.8 50.8 72 93.5 72 127 0 38.6-15 77.1-41.4 105.5-27.5 29.9-64.2 46.3-103.4 46.3zM526 389.2c-11.4 9.5-37 31.6-62.3 58.6-43.5 46.2-66.5 85.4-66.5 113.3 0 70.3 61.9 132.1 132.6 132.1 67.8 0 125.1-60.5 125.1-132.1 0-27.9-23-67-66.5-113.4-25.3-26.9-50.9-49-62.4-58.5z" fill="#ECB823" />
                                <path d="M558.6 419.6s-122 96.8-122 162.3c0 28.7 11.1 56.2 29.4 78.1 21.8 18.1 49.3 29.4 78.6 29.4 67.4 0 118.7-59.2 118.7-124.7 0-34.1-33-76.6-64.6-109.5-22.2-21.4-40.1-35.6-40.1-35.6z" fill="#FCC75B" />
                            </svg>
                            寻灯
                        </button>
                        <h3 className="rz-album-title">灯影集</h3>
                        {albumSearch && (
                            <div className="rz-album-search">
                                <input
                                    value={albumQuery}
                                    onChange={(e) => setAlbumQuery(e.target.value)}
                                    placeholder="检索心愿、留名或印章…"
                                />
                            </div>
                        )}
                        <div className="rz-album-tabs">
                            <button
                                type="button"
                                className={albumTabs === "time" ? "sel" : ""}
                                onClick={() => {
                                    if (albumTabs === "time") setAlbumTimeAsc((a) => !a); // 再点切换正/倒序
                                    else {
                                        setAlbumTabs("time");
                                        setAlbumTimeAsc(false); // 切回时序默认倒序（新近在前）
                                    }
                                }}
                            >
                                时序{albumTabs === "time" && (albumTimeAsc ? "↑" : "↓")}
                            </button>
                            <button
                                type="button"
                                className={albumTabs === "mine" ? "sel" : ""}
                                onClick={() => {
                                    setAlbumTabs("mine");
                                    // 「我的河灯」按需拉取：只在真的切到这个页签时请求
                                    //（原来一开灯影集就无条件拉一次 /api/protect/board/mine）
                                    if (!albumMineLoadedRef.current) {
                                        albumMineLoadedRef.current = true;
                                        fetchMyAlbum();
                                    }
                                }}
                            >
                                我的河灯
                            </button>
                            <button type="button" className={albumTabs === "cat" ? "sel" : ""} onClick={() => setAlbumTabs("cat")}>
                                类型
                            </button>
                        </div>
                        {/* 类型页签：四枚印章手动筛选（可多选） */}
                        {albumTabs === "cat" && (
                            <div className="rz-album-catf">
                                {CATS.map((c) => (
                                    <button
                                        key={c}
                                        type="button"
                                        className={"rz-seal rz-album-catf-seal" + (albumCatFilter.includes(c) ? " sel" : "")}
                                        onClick={() =>
                                            setAlbumCatFilter((prev) =>
                                                prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]
                                            )
                                        }
                                    >
                                        {c}
                                    </button>
                                ))}
                            </div>
                        )}
                        <div className="rz-album-list" ref={albumListRef}>
                            {albumSorted.map((it) => (
                                <button key={it.id} type="button" className="rz-album-item" onClick={() => lightFromAlbum(it)}>
                                    <span className="rz-seal rz-album-seal">{it.cat}</span>
                                    <span className="rz-album-msg">{it.msg}</span>
                                    <span className="rz-album-meta">
                                        {it.author || "无名"} · {it.time}
                                        {/* 我的河灯：待审(0)/未通过(2)状态标签（20260905 issue8）——
                                           点进详情可收回；通过态无标签 */}
                                        {albumTabs === "mine" && it.approved === 0 && (
                                            <i className="rz-minetag rz-wait" title="等待审核，通过后才在河面公开点亮">待审</i>
                                        )}
                                        {albumTabs === "mine" && it.approved === 2 && (
                                            <i className="rz-minetag rz-no" title="审核未通过，仅在「我的河灯」可见">未通过</i>
                                        )}
                                    </span>
                                    {/* 驳回理由（20260923）：跨满整行（grid 三列之外的
                                        第四个子项自动落到第二行），逐条能看到"为什么没通过" */}
                                    {albumTabs === "mine" && it.approved === 2 && (
                                        <span className="rz-album-reason">
                                            驳回理由：{it.reason || "未填写"}
                                        </span>
                                    )}
                                </button>
                            ))}
                            {albumSorted.length === 0 && (
                                <p className="rz-album-empty">
                                    {albumTabs === "mine" && !localStorage.getItem("tokenKey")
                                        ? "登录后可在「我的河灯」查看与收回所放河灯"
                                        : "卷中暂无留言"}
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            )}
            <div className="rz-veg" />
            {modal && (
                <div className="rz-modal" onClick={dismissModal} role="dialog" aria-modal="true" aria-label="心愿细读">
                    <div className="rz-modal-box" onClick={(e) => e.stopPropagation()}>
                        <div className="rz-scroll">
                            <div className="rz-msg">{modal.msg}</div>
                            {(modal.author || modal.time) && (
                                <div className="rz-who">
                                    {modal.author || "无名"} · {modal.time || ""}
                                </div>
                            )}
                            {/* 驳回理由（20260923）：只有未通过才有。与「我的河灯」列表、
                                个人中心「留言记录」同源（都读 talk.reject_reason）——
                                没写理由时如实说「未填写」，不编一句替代 */}
                            {modal.approved === 2 && (
                                <div className="rz-reject">
                                    <span className="rz-reject-label">驳回理由</span>
                                    {modal.reason || "未填写"}
                                </div>
                            )}
                            {/* 自己的河灯（灯影集点开，20260905 issue8）：
                               待审/未通过状态 + 收回河灯（两步确认） */}
                            {modal.mine && modal.talkKey && (
                                <div className="rz-mine-row">
                                    {modal.approved === 0 && (
                                        <span className="rz-minetag rz-wait">待审</span>
                                    )}
                                    {modal.approved === 2 && (
                                        <span className="rz-minetag rz-no">未通过</span>
                                    )}
                                    {modal.approved !== 0 && modal.approved !== 2 && (
                                        <span className="rz-minetag rz-ok">已点亮</span>
                                    )}
                                    <button
                                        type="button"
                                        className={"rz-reclaim" + (reclaimArm ? " armed" : "")}
                                        disabled={reclaimBusy}
                                        onClick={reclaimLantern}
                                        title={
                                            reclaimArm
                                                ? "再点一次确认：河灯将从灯影集与河面移去，不可恢复"
                                                : "收回这盏河灯（删除这条留言）"
                                        }
                                    >
                                        {reclaimBusy ? "收回中…" : reclaimArm ? "确认收回？" : "收回河灯"}
                                    </button>
                                    {reclaimErr && <span className="rz-reclaim-err">{reclaimErr}</span>}
                                </div>
                            )}
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
            <Live2dAgent />
        </>
    );
}
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./index.scss";
import { runtimeBaseURL } from "../../utils/runtimeApi";
import { LanternArt } from "./LanternArt";
import { useRiverScene, riverImage } from "./useRiverScene";
import { type RiverQuality, WATER_TOP } from "./sceneBudget";
import "./cinematic.scss";
import { useDialogFocus } from "./useDialogFocus";
import { useLiveRefresh } from "../../utils/liveRefresh";
import { useNavigate } from "react-router-dom";
const Live2dAgent = lazy(() => import("../../components/Live2dAgent"));

/* 业务状态、Canvas 场景与一次性灯体贴图分别维护。
   场景预算和生命周期见 sceneBudget.ts / useRiverScene.ts。 */

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
/* 河灯 id 的分界（20260926 起在代码里具名，此前只在三处写成字面量 `10000 +`）：
  判据是**灯的来历**，不是大小——`id < USER_LANTERN_BASE` 是开场铺在河面上的那批（id = 0..n-1，
   内容来自公开留言池）；`id ≥ USER_LANTERN_BASE` 是**用户自己弄起来的**（刚放下的灯、灯影集里
   点亮的灯）。两者数据源不同：后者的内容可能是待审的、根本不在公开池里 ⇒ 任何"跟着公开池
   调整河面"的逻辑都必须放过它们（见 syncPublicBoard）。 */
const USER_LANTERN_BASE = 10000;
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

interface LanternMeta {
    id: number;
    v: number;
    u: number;
    d: number; // 世界景深 0..1：0=远山方向，1=眼前
    w: number;
    sway: number;

    oX: number; // 碰撞位移（屏幕像素，随时间衰减）
    oY: number;

    _dq?: number; // 景深档位缓存（性能：filter/zIndex 换档才重写，不逐帧写）
    _pe?: string; // pointerEvents 缓存（性能：只在实际变化时写，不逐帧写）

}

/* ------------------------- 组件 ------------------------- */

export default function RiverBoard() {
    const navigate = useNavigate();
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const layerRef = useRef<HTMLDivElement | null>(null);
    const metaRef = useRef<LanternMeta[]>([]);
    const nodesRef = useRef<Map<number, HTMLDivElement | null>>(new Map());
    const viewRef = useRef({ w: window.innerWidth, h: window.innerHeight, yH: window.innerHeight * WATER_TOP });
    const mouseRef = useRef({ x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 });
    const sceneTime = useRef({ now: 0 });
    const [assistantOpen, setAssistantOpen] = useState(false);
    const [quality, setQuality] = useState<RiverQuality>(() => {
        try { const q = localStorage.getItem("river-quality"); if (q === "balanced" || q === "still") return q; } catch { /* storage may be disabled */ }
        return "cinematic";
    });

    const [lanterns, setLanterns] = useState<Wish[]>([]);
    const [ready, setReady] = useState(false);
    const [boardStatus, setBoardStatus] = useState<"loading" | "ready" | "error">("loading");
    const [boardReload, setBoardReload] = useState(0);
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
    const [wishError, setWishError] = useState("");
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
        v.yH = h * WATER_TOP;
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
        const bobY = Math.sin(sceneTime.current.now * 1.2 + m.sway) * 1.6 * (0.3 + d);
        return {
            x: riverX(m.u + Math.sin(sceneTime.current.now * 0.2 + m.sway) * 0.012, d) - px * 0.28 + m.oX,
            y: riverY(d) - bobY + m.oY,
        };
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
            if (m.d < -0.02) {
                m.d = 0.94 + Math.random() * 0.05; // 眼前重入
                m.u = 0.15 + Math.random() * 0.7; // 河面加宽后灯散布更开（0.15-0.85）
                m.w = 0.03 + Math.random() * 0.045;
                m.oX = 0;
                m.oY = 0;

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
                const push = Math.min(pen * (1 - Math.pow(0.72, dt * 60)), 90 * dt);
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
            const rot = Math.sin(sceneTime.current.now * 0.55 + m.sway) * 3.2;
            const scl = Math.min(1, Math.pow(d, 1.15) * 1.25); // 与 pos 同一缩放（整体等比放大）
            // P1-3（20260831）：远景灯停内部动画层（halo/光斑/涟漪/火焰动画 none），
            // 合成层数随远景灯比例大幅下降——老内核软渲染逐层合成的主成本来源
            node.classList.toggle("rz-far", d < 0.15);
            const li = lanternXY(m);
            node.style.transform =
                `translate3d(${li.x}px, ${li.y}px, 0) translate(-50%, -50%) scale(${scl}) rotate(${rot}deg)`;
            node.style.opacity = String(0.52 + 0.48 * Math.pow(d, 0.8));
            // pointerEvents 只在真正换档时写（逐帧写一个几乎不变的属性会白白触发样式失效计算）
            const pe = d < 0.10 ? "none" : "auto";
            if (pe !== m._pe) {
                m._pe = pe;
                node.style.pointerEvents = pe;
            }
            // Depth sorting is quantized; no per-lantern filter/rasterization.
            const dq = Math.round(d * 20) / 20;
            if (dq !== m._dq) {
                m._dq = dq;
                node.style.zIndex = String(200 + Math.round(dq * 1000));

            }

        }
    };

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
            const count = v.w < 620 ? 9 : v.w < 1100 ? 12 : 16;
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

                    oX: 0,
                    oY: 0,

                });
                views.push({ id: i, v: metas[i].v, msg, cat: catOf(msg) });
            }
            metaRef.current = metas;
            setLanterns(views);
            setReady(true);
        };

        setBoardStatus("loading");
        initLights(DEMO_MESSAGES.slice(0, 12));

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        fetch(`${runtimeBaseURL}/api/public/board`, { signal: ctrl.signal })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad status"))))
            .then((j: unknown) => {
                if (cancelled) return;
                const envelope = j as { code?: number; data?: unknown };
                if (envelope.code !== undefined && envelope.code !== 200) throw new Error("board unavailable");
                const data = envelope.data;
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
                setBoardStatus("ready");
                if (items.length === 0) {
                    allTalksRef.current = []; metaRef.current = []; lanternCountRef.current = 0; setLanterns([]);
                }
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
            .catch(() => { if (!cancelled) setBoardStatus("error"); })
            .finally(() => clearTimeout(timer));

        return () => {
            cancelled = true;
            ctrl.abort();
            clearTimeout(timer);
        };
    }, [boardReload]);

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

    useRiverScene({
        canvas: canvasRef, quality,
        paused: !!modal || wishOpen || albumOpen || noticeOpen,
        revision: lanterns,
        resize: layout,
        step: (dt) => { sceneTime.current.now += dt; driveLanterns(dt); if (dt > 0) scrollTick(dt); },
        lights: () => metaRef.current.map((m) => {
            const position = lanternXY(m), depth = Math.max(0, m.d);
            const scale = Math.min(1, Math.pow(depth, 1.15) * 1.25);
            const node = nodesRef.current.get(m.id);
            return { x: position.x, y: position.y + 35 * scale, depth, phase: m.sway,
                lit: !!node && !node.classList.contains('rz-unlit'),
                active: !!node?.matches(':hover, :focus-visible') };
        }),
    });

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
        setWishError("");
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
            if (!res.ok) throw new Error("放灯暂时未能完成，请稍后重试");
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
            const id = USER_LANTERN_BASE + wishSeq.current++;
            metas.push({
                id,
                v: wishV,
                u: 0.32 + Math.random() * 0.36,
                d: 0.8, // 近景放下，开场即见
                w: 0.03 + Math.random() * 0.04,
                sway: Math.random() * Math.PI * 2,

                oX: 0,
                oY: 0,

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
            setWishError(err instanceof Error ? err.message : "放灯暂时未能完成，请重试");
            // 登录失效/未登录 → 弹公告引导登录
            if (String(err).includes("登录")) setNoticeOpen(true);
        } finally {
            setWishBusy(false);
        }
    };
    const closeWishFlow = () => {
        if (wishBusy && !wishDone) return;
        setWishError("");
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

    /* 跨端同步（20260926，用户报「评论状态变更前端跟不上 agent，也要刷新网页」）：
       留言板上的可见性是**服务端**说了算——看板娘驳回一条、或主人自己在后台通过一条，
       河面此前只在挂载时拉过那一次，于是"被驳回的灯还在河上漂、新通过的灯一直不出现"。

       这份重拉**只做合并**（不重建灯、不动镜头、不重挂 canvas、不重置轮播指针）：
         · 池子换新 + 指针夹回新长度内（**不重置**：重置会让整条河的留言成片跳一次）；
         · 只动"当前漂着的那句话已经不在池子里"的灯（刚被驳回/删除）——还在池子里的
           一个字都不改：正漂在眼前的那句话无故换掉，比旧一点更让人困惑；
         · `id ≥ USER_LANTERN_BASE` 的灯（主人自己放的、灯影集里点亮的）**一个都不碰**：
           它们的出处不是这个公开池（待审的灯压根不在里面），按池子去"纠正"会把主人
           刚放下的灯当场换成别人的留言；
         · 灯影集那份（`albumItems`：还带 mine/approved 两个公开池没有的字段）不在这里拼，
           只把 TTL 缓存作废——下次打开灯影集自然重拉，也省得在主人翻卷册时把列表换掉。 */
    const syncPublicBoard = async () => {
        const token = localStorage.getItem("tokenKey");
        const res = await fetch(`${runtimeBaseURL}/api/public/board`, {
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        const j = (await res.json()) as { data?: unknown };
        const arr = Array.isArray(j?.data)
            ? (j.data as Array<{ talkKey?: unknown; v?: unknown; cat?: unknown; author?: unknown; content?: unknown; createTime?: unknown }>)
            : [];
        const items: Wish[] = arr
            .map((x) => ({
                id: Number(x?.talkKey ?? 0),
                v: [0, 1, 2].includes(Number(x?.v)) ? Number(x.v) : -1,
                cat: CATS.includes(String(x?.cat ?? "")) ? String(x.cat) : catOf(String(x?.content ?? "")),
                author: String(x?.author ?? ""),
                msg: String(x?.content ?? "").trim(),
                time: String(x?.createTime ?? "").slice(5, 16),
                talkKey: Number(x?.talkKey ?? 0),
            }))
            .filter((t) => t.msg);
        // 空池子**什么都不动**：留言板真的清空是极端情况，而"拉回来一份空"更可能是上游
        // 抽风——那时把河面写空（或把灯全换掉）比留一河旧灯坏得多。挂载那次另有演示灯兜底。
        if (items.length === 0) return;
        if (allTalksRef.current.length === 0) batchPtr.current = lanternCountRef.current;
        allTalksRef.current = items;
        if (batchPtr.current > items.length) batchPtr.current = items.length;
        boardCacheRef.current = null;
        const live = new Set(items.map((t) => t.msg));
        setLanterns((prev) => {
            // 绝大多数刷新是"一条都没被撤"：先判一次，没有要改的就**把原数组原样还回去**
            // ——否则每 20 秒白造一个新数组、整组件重渲染一次（河灯的 DOM 虽被 memo 挡住，
            // 但没理由每分钟三次做无用功）
            if (prev.every((p) => p.id >= USER_LANTERN_BASE || live.has(p.msg))) return prev;
            return prev.map((p, i) => {
                if (p.id >= USER_LANTERN_BASE || live.has(p.msg)) return p;
                const it = items[i % items.length];
                const meta = metaRef.current.find((m) => m.id === p.id);
                if (meta && it.v >= 0) meta.v = it.v;
                return {
                    ...p,
                    msg: it.msg,
                    cat: it.cat || catOf(it.msg),
                    v: it.v >= 0 ? it.v : p.v,
                    author: it.author,
                    time: it.time,
                };
            });
        });
    };

    /* 河面跟着服务端走（20 秒兜"别的地方改的"，看板娘收尾事件兜"我刚让它办的"）。
       `skip` 判据是**主人手上有没有没落地的东西**：
         · `wishOpen` —— 放灯流程开着（正在书写/正在放下），这时河面不该在它背后换；
         · `reclaimBusy`/`reclaimArm` —— 收回河灯的两步确认进行中，本地已经按结果改过列表，
           这时重拉会拿一份"还没删掉"的服务端数据把它盖回去。 */
    useLiveRefresh(syncPublicBoard, {
        skip: () => wishOpen || reclaimArm || reclaimBusy,
    });

    /* 灯影集：选中一条留言 → 河灯排到近景列队起始位置 + 亮起气泡 + 打开弹窗详情 */
    const lightFromAlbum = (it: AlbumItem) => {
        const metas = metaRef.current;
        const id = USER_LANTERN_BASE + wishSeq.current++;
        metas.push({
            id,
            v: it.v,
            u: 0.3 + Math.random() * 0.4,
            d: 0.88, // 列队起始位置：眼前近景
            w: 0.03 + Math.random() * 0.04,
            sway: Math.random() * Math.PI * 2,

            oX: 0,
            oY: 0,

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

    useDialogFocus(wishOpen ? `wish-${wishStep}` : noticeOpen ? 'notice' : albumOpen ? 'album' : modal ? 'detail' : '', () => {
        if (wishOpen) { if (!wishBusy) closeWishFlow(); }
        else if (noticeOpen) setNoticeOpen(false);
        else if (albumOpen) setAlbumOpen(false);
        else closeModal();
    });

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
                    aria-label={`阅读${ln.author || "无名"}的河灯：${ln.msg.slice(0, 20)}`}
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
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openWish(ln); }
                    }}
                    onClick={() => {
                        if (Date.now() - lastTouchToggle.current < 500) return;
                        openWish(ln);
                    }}
                >

                    <div
                        className={"rz-sprite" + (ln.v >= 1 ? " rz-oct" : "")}
                        style={ln.v >= 1 ? { width: 130, height: 130, margin: "-65px 0 0 -65px" } : undefined}
                    >
                        <LanternArt variant={ln.v} />

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
        [lanterns, modal]
    );

    return (
        <>
            <div className="rz-root rz-cinematic" data-scene-paused={!!modal || wishOpen || albumOpen || noticeOpen}>
            <img className="rz-landscape" src={riverImage} alt="" aria-hidden loading="eager" decoding="async" />
            <div className="rz-fog rz-fog-far" aria-hidden /><div className="rz-fog rz-fog-near" aria-hidden />
            <div className="rz-scene-shade" aria-hidden />
            <canvas ref={canvasRef} className="rz-canvas" aria-hidden />
            <div ref={layerRef} className="rz-lanterns" role="group" aria-label="河面上的留言，选择一盏灯阅读">
                {lanternNodes}
            </div>
            <div className="rz-ui">
                <div className="rz-masthead"><span className="rz-brand-seal">灯</span><span>河灯寄语<small>THE RIVER OF WISHES</small></span></div>
                <button className="rz-home-btn" type="button" onClick={() => navigate("/")}><span aria-hidden>←</span> 返回博客</button>
                <header className="rz-title"><span className="rz-chapter">夜渡 · 一方留白</span><h1>此心为灯<span>照见远方</span></h1><p>把未说的话，托付给一盏灯。<br />山河会记得，星月会听见。</p><span className="rz-title-rule" /></header>
                <div className="rz-bottom-bar">
                    <div className="rz-invitation"><span className="rz-live-dot" />一盏灯，一段人间<small role="status">{boardStatus === "loading" ? "正在打捞留言 · 示意河灯" : boardStatus === "error" ? <>留言加载失败 · 当前为示意河灯 <button type="button" onClick={() => setBoardReload(n => n + 1)}>重试</button></> : lanterns.length ? "轻触河灯，读一段心事" : "河上尚无人留灯，愿你是第一位"}</small></div>
                    <div className="rz-actions"><button className="rz-album-btn" type="button" onClick={openAlbum}><span aria-hidden>▤</span> 灯影集</button><button className="rz-wish-btn" type="button" onClick={openWishFlow}>点一盏河灯 <span aria-hidden>↗</span></button></div>
                </div>
                <fieldset className="rz-quality"><legend>画面</legend>{([['cinematic', '沉浸'], ['balanced', '节能'], ['still', '静谧']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={quality === value} onClick={() => { setQuality(value); try { localStorage.setItem('river-quality', value); } catch { /* optional preference */ } }}>{label}</button>)}</fieldset>
                <button type="button" className="rz-assistant-btn" onClick={() => setAssistantOpen(true)} disabled={assistantOpen}>{assistantOpen ? '助手已唤起' : '唤起助手'}</button>
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
                                            <LanternArt variant={lv} />
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
                                {wishError && <p className="rz-wish-error" role="alert">{wishError}</p>}
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
                                    <button type="button" className="rz-wish-ghost" disabled={wishBusy} onClick={() => setWishStep(1)}>
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
                                            const id = USER_LANTERN_BASE + wishSeq.current++;
                                            metas.push({
                                                id,
                                                v: w.v,
                                                u: 0.3 + Math.random() * 0.4,
                                                d: 0.88, // 列队起始位置：眼前近景
                                                w: 0.03 + Math.random() * 0.04,
                                                sway: Math.random() * Math.PI * 2,

                                                oX: 0,
                                                oY: 0,

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
            {!ready && <div className="rz-boot">
                <div className="rz-boot-glow" />
                <p>河灯将明 · 稍候</p>
            </div>}
            </div>
            {assistantOpen && <Suspense fallback={null}><Live2dAgent /></Suspense>}
        </>
    );
}
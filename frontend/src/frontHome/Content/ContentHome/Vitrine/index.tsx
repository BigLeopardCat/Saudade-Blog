import {
    Suspense, useCallback, useEffect, useRef, useState,
    type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { EXHIBITS } from './exhibits';
import './index.sass';

/**
 * 首页展示柜：一沓**贴了胶带的手账纸**，住在首屏手账内页（视频）的正下方。
 *
 * 形态（20260930 五轮立起来 → 20261001 六轮"翻日历" → 20261001 七轮"撕纸"）：
 *
 *   胶带压着最上面那张 ── 左下角**翘起一个折角**（纸背朝前）──▶ 捏住它往右上扯
 *                                                                    │
 *                                                     折角跟着长，长到头 ⇩
 *                                          ★ 这一页从**胶带底下**抽走、掉出屏幕底部
 *                                            （克隆纸做抛体 + 翻滚 + 抖飘，见 startFall）
 *                                                                    │
 *                                                            翻页照旧发生 ▼
 *                                                  下一页露出来；单击卡片放大
 *
 * 七轮改了什么（用户第 2 条原话：「手账左下角不是要一个突兀的折角，而是当前页面的左下角
 * 视觉上被折到前面了，然后翻页效果是左下角向右上角扯过去，然后当前页从胶带下面脱落掉到
 * 博客底部消失，掉落的纸张形状和物理动作也要逼真，虽然视觉上被扯下来，但是实际上翻页
 * 依然是页面循环」）：
 *
 * ① **折角是真折角**。六轮那个"缺口 + 一枚撇到卡片外的小三角 + 弧形粗箭头"被换掉：
 *    现在是一枚**规规矩矩的翻折角**——折线是卡片底左角上那条 45° 对角线，翻过来的那片
 *    落在纸**里侧**（顶点指向右上），**一点都不探出纸外**。探出去正是用户说的"突兀"。
 *    尺寸由一个 `--k`（0..1）驱动：`--k` 既是缺口的深度、也是那片纸的缩放。
 *    **`--k = 1` = 折线扫过整张卡的高度 = 折到左上角**（九轮：终点的量就是卡片自身的高，
 *    `rect.height` / `100%` / `height: 100%` 三处写的是同一个量，见 `onPointerMove`）。
 * ② **翻页靠扯**。捏住折角往右上拖 ⇒ `--k` 跟着长（缺口变深、那片纸变大）。拖到头
 *    （`--k = 1`）这一页就脱落。拖过却没到头 ⇒ 松手，折角弹回静止档。
 *    ⚠️ 「**拖过**」与「点一下」必须分开（`moved`）：指针起落都落在同一个按钮上时，
 *    浏览器**一律补发 `click`**（不管中间拖了多远），而 `onCornerClick` 正是"点一下 =
 *    扯一下"的入口 —— 不拦那次 click 的话，"拖一点再松手"会照样把这一页扯掉，
 *    弹回那条路根本走不到（`tests/vitrine-tear.test.py` 第三节就是钉它的）。
 * ③ **脱落是"抽走 + 掉下去"**。这一页**不是原地翻转**（六轮那个绕顶边掀走的动作已删）：
 *    它整个消失、同时在 `document.body` 上放一张**同尺寸的克隆纸**，由 rAF 跑一段抛体
 *    ——初速取自你甩手那一下，重力往下拽，边掉边翻，前 1.2 秒还有纸特有的**抖飘**
 *    （绕竖轴摆动 = `scaleX` 的前缩），掉出视口底部就销毁。克隆纸起步点比卡片顶低
 *    `TAPE_COVER` 那么多 ⇒ 读起来就是**从胶带底下抽出来**的（见常量注释）。
 * ④ **说到底还是翻页**。扯掉之后 `flipped` 照旧取反 ⇒ 循环没变，只是"翻"这个动作
 *    从"掀过去"换成了"撕下来"。两页谁在上面谁就有折角，所以**永远有地方下手**。
 *
 * 八轮（用户第 5 条原话：「手账页的效果基本满意，但是**单击**没有掀起左下角动画直接掉下去了，
 * 而且我感觉动画扯起来的**角的终点**可以更大一些」）只动了两处：
 *
 * ① **点一下 = 一次完整的扯**。原来 `onCornerClick` 直接 `tear(260, -430)` —— 折角从静止档
 *    （0.2）一步跨到"纸已经没了"，中间那段**被掀起来**的过程一帧都看不到（拖拽那条路没这个
 *    毛病：它是跟手一帧帧长起来的）。现在先把 `--k` 推到 1（**不挂** `is-peeling`⇒ `.vit-ear`
 *    那条 0.3s 过渡照常跑，折角肉眼可见地长到头），等它跑完再脱落。拖拽与"减少动效"两条
 *    路都不变（后者不掀，直接扯 —— 页照翻）。
 * ② **终点抬到 160px**（当时 `EAR_MAX` 与 sass 的 `--ear` 两处同改）。
 *
 * 九轮（用户第 1 条原话：「手账撕下来动画过渡不自然，**至少要撕到左侧胶带位置才能掉落吧**。
 * 文章向量空间，个性签名，下翻按钮，键合胶带盖在上面了，关闭按钮太靠右上角了」）三处：
 *
 * ① **折角长到卡片那么高**（八轮那个 160px 是写死的，卡片高 227px ⇒ 折到七成就掉）。
 *    分母换成 `rect.height`、sass 那边竖腿换成 `100%`、那片纸换成 `height: 100%`
 *    ⇒ 折到头正好够到**左上角**，也就是左侧那张胶带住的地方。
 * ② **胶带 / 折角 / 关闭按钮从 `.vitrine` 搬进 `.vit-3d`**：放大态 `.vitrine` 是
 *    `position: fixed; inset: 0`，挂它身上的绝对定位小件全按**视口**算位置 —— 两张胶带
 *    飞到视口左右上角（正好压在标题/签名/下翻按钮上）、关闭按钮落在站点头部右上角。
 *    顺带把那两张胶带往上抬了 5px：它原先啃到内页标题那行字。
 * ③ **手机档 hero 底部留白 56 → 128px**：`.heroBottom`（签名 + 下翻按钮）要 113px，
 *    56px 的留白让卡片下缘压在签名上（那两条 `.heroRight`/`.heroBottom` 的 z-index
 *    也顺势调了个个儿，见 `ContentHome/index.sass`）。
 *
 * 另外两条是五轮就定下、这轮没动的：
 *
 * ① **图谱面在被翻到之前不挂载**（`mounted`）。`exhibits.ts` 那条是 `lazy(...)`，
 *    这是唯一的性能闸：没人翻页就一份图数据都不下载。
 *
 * ② **内联态不给指针事件**。图谱是"拖动旋转 / 滚轮穿云"的交互件，挂在首屏正中间
 *    按老样子吃滚轮，等于访客往下滚页面时被它截住。
 *    分工是：内联态一律 `pointer-events: none`（点卡片 = 放大），放大后才 `auto`。
 *    20261002 之前展示柜还自带一套"锁定态"分担这件事（一个盖住画布的遮罩 + 解锁按钮），
 *    用户说"不需要锁定功能和按钮了"之后整块删除 ⇒ **这条规则现在是唯一一道闸**，
 *    `pointer-events: none` 同时也是滚轮穿透的载体（滚轮是指针事件），别删。
 */
export default function Vitrine() {
    const rootRef = useRef<HTMLElement | null>(null);
    const fallRef = useRef<HTMLSpanElement | null>(null);
    const dragRef = useRef<Drag | null>(null);
    const suppressClick = useRef(false);
    /** 「点一下」那条路正在掀折角时的定时器（非 null = 掀的动作进行中）。
     *  它同时是**重入闸**：掀的这 340ms 里再来一次点按/按下，一律当没看见。 */
    const liftTimer = useRef<number | null>(null);

    const [flipped, setFlipped] = useState(false);
    const [mounted, setMounted] = useState(false);
    const [zoomed, setZoomed] = useState(false);
    const [falling, setFalling] = useState<Fall | null>(null);

    const ex = EXHIBITS[0];
    const Body = ex.Component;
    // 垫在胶带底下的那些纸：一件展品一张，主卡占掉第一件
    const under = EXHIBITS.slice(1);

    /** 折角进度（0..1）。**直接写 DOM**，不走 React state：拖拽每帧都要改它，
     *  而重渲染会一路带着下面那个图谱组件一起跑——落在这个 60fps 的手势里是白扔的。
     *
     *  ⚠️ `null` 是"**交还给 sass 的静止值**"（`--k: 0.2`），不是"折角为 0"。别把这几个
     *  调用点改成传 `0`：那是把纸角摊平，纸面看上去完好无损，而用户要的恰恰是
     *  「左下角**视觉上被折到前面**」——那枚常驻的折角就是下手的把手，摊平了又要"猜从哪翻"。 */
    const setEar = useCallback((k: number | null) => {
        const el = rootRef.current;
        if (!el) return;
        if (k === null) el.style.removeProperty('--k');
        else el.style.setProperty('--k', String(k));
    }, []);

    /** 读回归静止档的折角值。真源是 sass 那条 `--k: 0.2`，这里只负责读出来 ——
     *  不在 TSX 里再立一份常量（本仓"两处同一个数"的约定已经够多了）。
     *  拖拽起点要用它做**相对**基准，见 onPointerMove；整个手势只读这一次。 */
    const readEar = useCallback(() => {
        const el = rootRef.current;
        if (!el) return REST_EAR;
        const v = parseFloat(getComputedStyle(el).getPropertyValue('--k'));
        return Number.isFinite(v) ? v : REST_EAR;
    }, []);

    /** 把当前压在上面的那一页**扯下来**：翻页照旧循环 + 放一张会掉的克隆纸。 */
    const tear = useCallback((vx: number, vy: number) => {
        const root = rootRef.current;
        if (!root) return;
        const rect = root.getBoundingClientRect();
        const coverOnTop = !flipped;
        setMounted(true);
        setFlipped(!flipped);
        // 交还静止档：翻上来那一页也有自己的折角（那正是"永远有地方下手"的保证）
        setEar(null);
        root.classList.remove('is-peeling');
        setFalling({
            key: Date.now(),
            // 克隆纸起步就落在**胶带下缘之下**（`TAPE_COVER` = 胶带压进卡片的那 8px）
            // ⇒ 观感是"从胶带底下抽走"，而不是"从胶带上浮出来"。
            left: rect.left,
            top: rect.top + TAPE_COVER,
            width: rect.width,
            height: rect.height,
            cover: coverOnTop,
            // 甩手那一下决定初速；单击/键盘给一组固定值。横向必须往右、纵向必须先上扬
            // （"往右上扯"），所以是 clamp 而不是原样透传。
            vx: clamp(vx, 160, 900),
            vy: clamp(vy, -760, -140),
            title: ex.title,
            hint: ex.hint,
        });
    }, [flipped, ex, setEar]);

    // 掀折角的定时器要能随组件一起消失：掀到一半被卸载（切路由/放大态关掉）时，
    // 那个 setTimeout 还攥着一个已卸载组件的 `tear`，到点照跑。
    useEffect(() => () => {
        if (liftTimer.current !== null) window.clearTimeout(liftTimer.current);
    }, []);

    // 放大态：Esc 关闭 + 锁住文档滚动（不然滚轮会推着底下的页面走）+ 把整个前台抬到
    // 看板娘面板之上（`body.exhibit-zoomed .frontRoot`，见 App.sass）。
    // 三件事**必须同生共死**：`.frontRoot` 的 `isolation: isolate` 把层内 z-index 关住了，
    // 放大态想压过 body 层的 `#waifu` 只能靠整体抬高；只加不摘，就会出现"已经退出放大态、
    // 整站却还盖在对话面板上"——而那时页面恢复滚动，看起来完全不像层级问题。
    // 同一个 effect、同一对 return，是这里唯一稳妥的写法。
    useEffect(() => {
        if (!zoomed) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoomed(false); };
        window.addEventListener('keydown', onKey);
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        document.body.classList.add('exhibit-zoomed');
        return () => {
            window.removeEventListener('keydown', onKey);
            document.body.style.overflow = prev;
            document.body.classList.remove('exhibit-zoomed');
        };
    }, [zoomed]);

    // 脱落那一页的抛体运动。**全程只写 `transform`**（合成器就能跑完），
    // 且每帧不碰 React state —— 一张纸掉 1 秒多，60 次重渲染足够把图谱那边拖下水。
    useEffect(() => {
        if (!falling) return;
        const el = fallRef.current;
        // 减少动效档：不做抛体，这一页直接消失（**翻页本身照常发生**——
        // 用户要的是"别晃"，不是"别翻"）。
        if (!el || prefersReducedMotion()) { setFalling(null); return; }

        let raf = 0;
        let last = performance.now();
        const s = { x: 0, y: 0, vx: falling.vx, vy: falling.vy, rot: 0, t: 0 };
        // 转起来的快慢跟着横甩走：轻轻一扯是"飘着落"，用力甩是"翻着飞"。
        const spin = 22 + Math.abs(falling.vx) * 0.05;
        // 掉出视口的判据：这一页的**顶边**越过屏幕下缘（`innerHeight - falling.top`），
        // 再多走一整张纸的高度 —— 纸是翻着滚下来的，角会先探出去一截，收尾要留这一档。
        const limit = window.innerHeight - falling.top + falling.height;

        const step = (now: number) => {
            const dt = Math.min((now - last) / 1000, 0.05);
            last = now;
            s.t += dt;
            s.vy += GRAVITY * dt;
            s.x += s.vx * dt;
            s.y += s.vy * dt;
            s.rot += spin * dt;
            // 纸的"抖飘"：绕竖轴来回摆，用 `scaleX` 的前缩表达（这就是纸不是石头的证据）。
            // 幅度按 1.2 秒衰减到 0 —— 起初翻飞、越掉越平，最后干脆地出画。
            const decay = Math.max(0, 1 - s.t / FLUTTER_SECONDS);
            const sx = 1 - FLUTTER_AMP * decay * (0.5 + 0.5 * Math.sin(s.t * FLUTTER_HZ * 6.283185));
            el.style.transform =
                `translate3d(${s.x.toFixed(2)}px, ${s.y.toFixed(2)}px, 0)`
                + ` rotate(${s.rot.toFixed(2)}deg) scaleX(${sx.toFixed(4)})`;
            if (s.y < limit) raf = requestAnimationFrame(step);
            else setFalling(null);
        };
        raf = requestAnimationFrame(step);
        return () => cancelAnimationFrame(raf);
    }, [falling]);

    const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
        if (zoomed) return;
        // 折角住在卡片里：不拦冒泡的话这一下会同时命中卡片的"放大"
        e.stopPropagation();
        // 掀的动作正演着 —— 这一下不接。接了就糟：`readEar()` 会在过渡中途读到 1
        // （`--k` 是自定义属性、不插值，写下去就是新的计算值），于是"刚按下就已经扯到头"，
        // 拖拽那条路会在一个完全假的起点上开跑。掀只有 340ms，等它演完这一页就翻过去了。
        if (liftTimer.current !== null) return;
        const root = rootRef.current;
        if (!root) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const rect = root.getBoundingClientRect();
        // 拖拽按**相对量**走：记下按下那一刻的折角与指针在对角线上的投影，之后只算增量。
        // 不这么做的话，手指从折角上按下去那一下就先把 `--k` 归零（指针在角上 ⇒ 投影≈0），
        // 折角"啪"地摊平再重新长起来——手感上就是纸被按塌了一块。
        dragRef.current = {
            id: e.pointerId,
            rect,
            p0: ((e.clientX - rect.left) + (rect.bottom - e.clientY)) / 2,
            k0: readEar(),
            sx: e.clientX, sy: e.clientY,
            lastX: e.clientX, lastY: e.clientY, lastT: performance.now(),
            vx: 0, vy: 0, torn: false, moved: false,
        };
        // 拖动期间折角与缺口**跟手**（去过渡）；松手弹回去时才由 sass 那条过渡接管。
        // 这里**不碰 `--k`**：折角在按下的一瞬保持原样，从第一次 move 起才跟着走。
        root.classList.add('is-peeling');
        // 新一轮手势开场，先把上一轮可能留下的抑制标记清掉（手势被 pointercancel
        // 掐断时它没机会被那次 click 消费，留着会把**下一次**老老实实的点按吃掉）。
        suppressClick.current = false;
    };

    const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
        const d = dragRef.current;
        if (!d || e.pointerId !== d.id || d.torn) return;
        e.stopPropagation();
        // 「拖过」的判据（4px 抖动容差，见 onPointerUp —— 它决定这次松手是"松手"
        // 还是"点一下"）。一次 move 都没发生过的手势才是纯粹的点按。
        if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4) d.moved = true;
        const now = performance.now();
        const dt = Math.max((now - d.lastT) / 1000, 1 / 120);
        d.vx = (e.clientX - d.lastX) / dt;
        d.vy = (e.clientY - d.lastY) / dt;
        d.lastX = e.clientX; d.lastY = e.clientY; d.lastT = now;
        // 折角长多少 = 指针沿**卡片底左角那条 45° 对角线**往前走了多远（往右上 1px 横向
        // + 1px 纵向 = 1px），起点接在按下那一刻的折角上（`k0`/`p0`，见 onPointerDown）。
        // 分母 = **卡片高度**：`--k` 是与缺口的竖腿（`100%` 卡片高）共用的那个比例，
        // 于是手指走满一个卡高 = 折线扫到左上角 = 扯断。
        const p = ((e.clientX - d.rect.left) + (d.rect.bottom - e.clientY)) / 2;
        const k = clamp(d.k0 + (p - d.p0) / d.rect.height, 0, 1);
        if (k >= 1) {
            // 拖到头 = 该断了。**不再写 `--k`**：tear 会把它交还静止档。
            d.torn = true;
            // 拖拽已经扯掉了，紧随其后的那次 `click` 不能再扯一遍
            suppressClick.current = true;
            tear(d.vx, d.vy);
        } else {
            setEar(k);
        }
    };

    const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
        const d = dragRef.current;
        dragRef.current = null;
        if (!d || e.pointerId !== d.id) return;
        e.stopPropagation();
        if (d.torn) return;
        // ⚠️ 手指真的移动过 ⇒ 这次松手是"**松手**"，不是"点一下"。必须把紧随其后的
        // 那次 `click` 吃掉：指针起落都落在同一个按钮时浏览器一律补发 click（不管中间
        // 拖了多远），不拦的话"拖一点再松手"会照样把这一页扯掉 —— 弹回那条路根本走不到。
        if (d.moved) suppressClick.current = true;
        // 没扯到会断的地方 —— 收手，折角弹回**静止档**（不是摊平，见 setEar）
        rootRef.current?.classList.remove('is-peeling');
        setEar(null);
    };

    const onCornerClick = (e: ReactMouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        if (suppressClick.current) { suppressClick.current = false; return; }
        // 键盘（Tab + Enter）与"点一下不拖"：等价的**一次完整的扯**。
        // 八轮之前这里是直接 `tear(...)`——折角一步跨到消失，用户说的"没有掀起左下角动画
        // 直接掉下去了"就是这一段缺席。现在补上：先把折角掀到头（`setEar(1)`），等过渡
        // 演完再脱落。不挂 `is-peeling`（那是拖拽专用的去过渡开关）⇒ 0.3s 的过渡照跑。
        if (liftTimer.current !== null) return;   // 已经在掀了，重复触发一律忽略
        // 减少动效档：不掀，直接扯 —— 用户要的是"别晃"，不是"别翻"（与掉落那条路同一取向）。
        if (prefersReducedMotion()) { tear(CLICK_VX, CLICK_VY); return; }
        setEar(1);
        liftTimer.current = window.setTimeout(() => {
            liftTimer.current = null;
            tear(CLICK_VX, CLICK_VY);
        }, LIFT_MS);
    };

    const handleCardClick = () => {
        // 封面面上单击不放大——用户的原话是「**翻页后**可以单击展示柜」
        if (!flipped || zoomed) return;
        setZoomed(true);
    };

    return (
        <section
            ref={rootRef}
            className={`vitrine${flipped ? ' is-flipped' : ''}${zoomed ? ' is-zoomed' : ''}`}
            aria-label="展示柜"
            onClick={handleCardClick}
        >
            {/* 垫在下面的纸：**从最深那张开始画**——同一 z-index 下后写的压在上面，
                于是 `under[0]`（最贴主卡的那张）最后落笔。深度走自定义属性 `--d`，
                sass 侧用它算位移/缩放/歪角。 */}
            {[...under].reverse().map((it, i) => (
                <span
                    key={it.key}
                    className="vit-under"
                    style={{ '--d': under.length - i } as CSSProperties}
                    aria-hidden="true"
                />
            ))}

            {/* perspective 只挂在这一层，**不是** `.vitrine` 的祖先链上——`perspective`
                会给 `position: fixed` 后代造包含块，挂到外面去放大态就会被框在卡片原位。 */}
            <div className="vit-3d">
                {/* 两张胶带 + 那片折角 + 关闭按钮都住在**卡片**里（不是 `.vitrine` 上）：
                    放大态 `.vitrine` 会撑成 `position: fixed; inset: 0`，挂它身上这些
                    绝对定位的小件（`top/right` 按视口算）就全飞到视口四角去了 ——
                    用户第 1 条「键合胶带盖在上面了 / 关闭按钮太靠右上角了」都是它。 */}
                <span className="vit-tape vit-tapeL" aria-hidden="true" />
                <span className="vit-tape vit-tapeR" aria-hidden="true" />

                {/* 下一页：躺平在下面等上面那张被扯走 */}
                <div className="vit-face vit-panel">
                    {/* 语义化 header 回来了（20260916）：`pages/Dashboard/index.css` 那条裸标签
                        规则 `header{position:relative;top:20px}` 已收进 `.shell` 作用域，
                        本页的 header 不再被顶下去 20px。改回去之前请先看那条规则还在不在。 */}
                    <header className="vit-bar">
                        <span className="vit-title">{ex.title}</span>
                        <Badge of={ex} />
                        {ex.hint && <span className="vit-hint">{ex.hint}</span>}
                    </header>
                    <div className="vit-body">
                        {mounted && (
                            <Suspense fallback={<div className="vit-loading">加载中…</div>}>
                                <Body />
                            </Suspense>
                        )}
                    </div>
                </div>

                {/* 这一页（封面）：被扯走的那一张。缺口与折角都归 sass 的 `--k` 管。 */}
                <div className="vit-face vit-cover">
                    <CoverFace title={ex.title} hint={ex.hint} />
                </div>

                {/* 折过来的那一片纸。它得跟**卡片**同尺寸（`height: 100%` + 正方形盒），
                    所以住在这一层而不是那枚按钮里 —— 放大态卡片会变宽变高，纸要跟着长；
                    留在按钮（120×120，左下角原位）里的话，放大态它就不动了。 */}
                <span className="vit-ear" aria-hidden="true" />

                {zoomed && (
                    <button
                        className="vit-close"
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setZoomed(false); }}
                        aria-label="关闭"
                    >×</button>
                )}
            </div>

            {/* 左下角那个抓手。它**仍然是 `<button>`**——Tab 可达、有 aria-label、Enter
                能扯（`onClick` 走 tear），只是长得不像按钮：那片折角已经搬进 `.vit-3d`
                了（见上），这里只剩命中区。尺寸 = 静止档折角（≈45px）够抓的框，
                不跟着卡片长高 —— 见 sass `.vit-corner` 的头注。 */}
            <button
                className="vit-corner"
                type="button"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onClick={onCornerClick}
                aria-label={flipped ? '扯下这一页（回到封面）' : '扯下这一页（翻页）'}
                title={flipped ? '扯下这一页（回到封面）' : '扯下这一页（翻页）'}
            />

            {/* 被扯下来的那一页：**克隆到 body 上**才算得出"掉出视口"这件事。
                ⚠️ 不能留在 `.vitrine` 里就地往下掉 —— `.vitrine` 是 `position: relative`，
                绝对定位的后代会把**文档滚动高度**一起撑大：纸一边掉、页面一边长，
                掉完再缩回去，滚动条会当众跳一下。`position: fixed` 不参与滚动溢出，
                这也是它必须走 portal 的原因（`perspective` 会给 fixed 后代造包含块）。 */}
            {falling && createPortal(
                <span
                    key={falling.key}
                    ref={fallRef}
                    className={`vit-fall${falling.cover ? ' is-cover' : ' is-panel'}`}
                    style={{
                        left: falling.left, top: falling.top,
                        width: falling.width, height: falling.height,
                    }}
                    aria-hidden="true"
                >
                    {falling.cover
                        ? <span className="vit-face vit-cover"><CoverFace title={falling.title} hint={falling.hint} /></span>
                        /* 图谱那一页掉下来时是**背面朝前**：一块深玻璃。不克隆画布内容——
                           克隆出来的 canvas 是空白的，反倒像"掉了张白纸"。 */
                        : <span className="vit-face vit-panel" />}
                </span>,
                document.body,
            )}
        </section>
    );
}

/** 封面那一页的内容。真封面与被扯下来的克隆纸**共用这一份**——两处各写一遍的话，
 *  克隆体迟早会跟真身长得不一样（而那正是"扯下来了"这句话的全部说服力）。 */
function CoverFace({ title, hint }: { title: string; hint?: string }) {
    return (
        <>
            <span className="vit-coverStar" aria-hidden="true">✦</span>
            <span className="vit-coverTitle">{title}</span>
            <span className="vit-coverHint">{hint}</span>
        </>
    );
}

/** 角标：文案可能是异步取回的（如产物更新时间戳），读不到就整块不渲染。 */
function Badge({ of }: { of: (typeof EXHIBITS)[number] }) {
    const [text, setText] = useState<string | null>(null);
    useEffect(() => {
        if (!of.badge) return;
        let alive = true;
        Promise.resolve(of.badge()).then((t) => { if (alive) setText(t || null); }).catch(() => { /* 角标是装饰，静默 */ });
        return () => { alive = false; };
    }, [of]);
    if (!text) return null;
    return <em className="vit-badge" title="向量数据库更新时间">{text}</em>;
}

/** 折角的最大边长 —— **就是卡片自己的高度**（不在这边立常量）。
 *  九轮（用户第 1 条：「至少要撕到左侧胶带位置才能掉落吧」）之前它是写死的 160px，
 *  而卡片高 227px ⇒ 折到七成就掉、缺口离左上角还差一大截，读起来就是"没撕到头"。
 *  现在 `--k` 的分母是 `rect.height`，sass 那边缺口的竖腿是 `100%`、那片纸是
 *  `height: 100%` —— **三处同一个量**，而且都不是魔法数。
 *  ⚠️ 别改成"按宽度"：折的是纸角、纵向那一刀扫过的是卡片的**高度**。 */
/** 「点一下」掀折角用的时长（ms）。它必须**不小于** sass 里 `.vit-ear` 那条
 *  `transition: transform 0.3s`：掀的动作整个是 CSS 过渡在演，这里只是等它演完。
 *  多给的这 40ms 是让折角在最大档上停一帧再断（不然"到顶"和"没了"挤在同一帧上）。 */
const LIFT_MS = 340;
/** 「点一下 / 回车」那一次扯的固定初速。横向必须往右、纵向先上扬（"往右上扯"），
 *  与拖拽那条路一样要落在 `tear` 的 clamp 区间里。 */
const CLICK_VX = 260;
const CLICK_VY = -430;
/** 折角的**静止值**。真源是 sass 的 `.vitrine { --k: 0.2 }`，这里只作 `readEar()`
 *  读不出来时的兜底（样式没加载等退化场景）；两处同一个数，改一处要改两处。 */
const REST_EAR = 0.2;
/** 胶带压进卡片的那一段：`.vit-tape` 是 `top: -14px` + 高 22px ⇒ 盖到卡片内 8px。
 *  （九轮把胶带往上抬了 5px —— 它原先啃到 `.vit-bar` 里标题那行字，见 sass 的头注。） */
const TAPE_COVER = 8;
/** 脱落那一页的重力（px/s²）。比真实 9.8 大得多是刻意的——屏幕尺度上按真值掉，
 *  一秒钟还没出画，"掉到博客底部"就成了等。 */
const GRAVITY = 2600;
/** 纸的抖飘：摆幅、频率（Hz）、衰减时长（秒）。 */
const FLUTTER_AMP = 0.22;
const FLUTTER_HZ = 3.2;
const FLUTTER_SECONDS = 1.2;

type Drag = {
    id: number;
    /** 按下那一刻卡片的矩形——拖拽全程用它换算折角，不每帧再取一次（会强制重排）。 */
    rect: DOMRect;
    /** 按下那一刻：指针在 45° 对角线上的投影、折角当时的进度。两个一起构成相对基准。 */
    p0: number; k0: number;
    /** 按下时的指针位置——只用来判"这次手势到底动没动"（见 `moved`）。 */
    sx: number; sy: number;
    lastX: number; lastY: number; lastT: number;
    vx: number; vy: number;
    /** 已经扯断了（后续 move/up 一律不再处理） */
    torn: boolean;
    /** 指针移动超过抖动容差 ⇒ 这次松手算"松手"而不是"点一下" */
    moved: boolean;
};

type Fall = {
    key: number;
    /** 被扯走那一页在**视口**里的矩形（fixed 定位的起点） */
    left: number; top: number; width: number; height: number;
    /** 掉的这一页是封面（浅纸）还是图谱那页（深玻璃） */
    cover: boolean;
    vx: number; vy: number;
    title: string;
    hint?: string;
};

function clamp(v: number, lo: number, hi: number) {
    return Math.min(Math.max(v, lo), hi);
}

function prefersReducedMotion() {
    return typeof window !== 'undefined'
        && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

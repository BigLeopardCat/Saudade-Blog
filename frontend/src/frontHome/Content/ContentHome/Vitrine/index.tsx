import { Suspense, useEffect, useState, type CSSProperties } from 'react';
import { EXHIBITS } from './exhibits';
import './index.sass';

/**
 * 首页展示柜：一沓**贴了胶带的手账纸**，住在首屏手账内页（视频）的正下方。
 *
 * 形态（20260930 五轮立起来，20261001 六轮按用户第 2/3 条改成"翻日历"）：
 *
 *   胶带压着最上面那张 ── 左下角卷角（+ 弧形粗箭头）──▶ 这一页绕**顶边**翻走
 *                                                        露出下面那页（图谱面）
 *                                                               │
 *                                                       单击卡片 ▼
 *                                              居中放大 + 压暗背景 + 正常交互
 *
 * 六轮改了三件事（三条都是用户原话）：
 *
 * ① **翻页像翻日历，不是正反面反转**。五轮是"整块 `.vit-3d` 绕 X 轴转 180°"——
 *    观感是同一张卡片翻面（正反两面同时在场、同时可见）。现在是**两个独立的页**：
 *    `.vit-panel`（下一页）躺平不动，`.vit-cover`（这一页）`transform-origin: 50% 0`
 *    绕顶边向上掀、过 90° 背面朝前被 `backface-visibility` 隐去。这正是翻日历/翻记事本
 *    的动作：下缘朝观者抬起来、越过头顶消失，露出底下的新页。
 *
 * ② **按钮撤掉，改左下角"向外翻折的角" + 日式动漫风弧形粗箭头**（`.vit-corner`）。
 *    它仍是个 `<button>`（键盘可达、有 aria-label），只是不再画成一颗圆角方块：
 *    纸角被掀起一角（`.vit-corner::before` 那个三角，配封面自己的 `clip-path` 缺口）、
 *    一支粗弧箭头从角上甩出去示意"从这儿翻"。
 *
 * ③ **多层叠层**（用户第 2 条："要能看出来胶带下面贴了多张"）。垫在胶带底下的纸
 *    **一件展品一张**（`.vit-under`），越深越往下、越小、越歪一点，只露一条边。
 *    ⚠️ 今天 `EXHIBITS` 只有一件 ⇒ 底下**是空的**，看起来就是一张纸——这是对的：
 *    用户那句括注写的是"如果后期确实增加了多张"。加第二件展品时这里自动多一层，
 *    不必再改代码。
 *
 * 另外两条是五轮就定下、这轮没动的：
 *
 * ① **图谱面在被翻到之前不挂载**（`mounted`）。`exhibits.ts` 那条是 `lazy(...)`，
 *    这是唯一的性能闸：没人翻页就一份图数据都不下载。
 *
 * ② **内联态不给指针事件**。图谱是"拖动旋转 / 滚轮穿云"的交互件，挂在首屏正中间
 *    按老样子吃滚轮，等于访客往下滚页面时被它截住（这正是它出厂自带 `is-locked`
 *    的原因）。分工是：内联态一律 `pointer-events: none`（点卡片 = 放大），放大后
 *    才 `auto`。**内联那份 `wg-lock` 解锁钮因此够不着**，但不删——它是
 *    WordGraphExhibit 自己的出厂形态，放大态里照样显示。
 */
export default function Vitrine() {
    const [flipped, setFlipped] = useState(false);
    const [mounted, setMounted] = useState(false);
    const [zoomed, setZoomed] = useState(false);

    const ex = EXHIBITS[0];
    const Body = ex.Component;
    // 垫在胶带底下的那些纸：一件展品一张，主卡占掉第一件
    const under = EXHIBITS.slice(1);

    // 放大态：Esc 关闭 + 锁住文档滚动（不然滚轮会推着底下的页面走）
    useEffect(() => {
        if (!zoomed) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoomed(false); };
        window.addEventListener('keydown', onKey);
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            window.removeEventListener('keydown', onKey);
            document.body.style.overflow = prev;
        };
    }, [zoomed]);

    const handleFlip = (e: React.MouseEvent) => {
        // 卷角住在卡片里：不拦冒泡的话这一下会同时命中卡片的"放大"
        e.stopPropagation();
        setMounted(true);
        setFlipped((v) => !v);
    };

    const handleCardClick = () => {
        // 封面面上单击不放大——用户的原话是「**翻页后**可以单击展示柜」
        if (!flipped || zoomed) return;
        setZoomed(true);
    };

    return (
        <section
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

            <span className="vit-tape vit-tapeL" aria-hidden="true" />
            <span className="vit-tape vit-tapeR" aria-hidden="true" />

            {/* perspective 只挂在这一层，**不是** `.vitrine` 的祖先链上——`perspective`
                会给 `position: fixed` 后代造包含块，挂到外面去放大态就会被框在卡片原位。 */}
            <div className="vit-3d">
                {/* 下一页：**不翻转**，躺平在下面等上面的纸被翻走 */}
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

                {/* 这一页（封面）：绕顶边向上掀走。`transform-origin` 与 `rotateX(180deg)`
                    都在 sass 的 `.vit-cover` 那一处，别挪回内联——`is-flipped` 是类名驱动。 */}
                <div className="vit-face vit-cover">
                    <span className="vit-coverStar" aria-hidden="true">✦</span>
                    <span className="vit-coverTitle">{ex.title}</span>
                    <Badge of={ex} />
                    {ex.hint && <span className="vit-coverHint">{ex.hint}</span>}
                </div>
            </div>

            {/* 左下角：掀起来的那一小角 + 示意"从这儿翻"的弧形粗箭头。
                仍是个 button（Tab 可达），只是不画成方块了。 */}
            <button
                className="vit-corner"
                type="button"
                onClick={handleFlip}
                aria-label={zoomed ? '翻页' : flipped ? '翻回封面' : '翻页查看'}
                title={flipped ? '翻回封面' : '翻页'}
            >
                <span className="vit-cornerArrow" aria-hidden="true"><FlipArrow /></span>
            </button>

            {zoomed && (
                <button
                    className="vit-close"
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setZoomed(false); }}
                    aria-label="关闭"
                >×</button>
            )}
        </section>
    );
}

/** 日式动漫风那支"弧形粗箭头"：一条甩出去的抛物弧 + 一枚胖箭头（用户第 3 条）。
 *
 *  画布 88×88 与 `.vit-corner` 的盒子**逐像素重合**（`inset: 0` + 宽高 100%），
 *  所以这里的坐标可以直接对着纸角那组几何读：弧的起点 (22,66) 就压在掀起的纸角上，
 *  箭头朝右上甩出去 = "从这儿往上翻"。
 *
 *  粗是刻意的：`stroke-width` 7（占盒子 8%），箭头三角底边 14 —— 用户要的就是
 *  "弧形**粗**箭头"这种漫画分镜里的手势，不是一枚 UI 图标。
 *  stroke/fill 全走 `currentColor`：颜色归 sass 管（亮纸上一套、翻过去压深色图谱面另一套）。 */
function FlipArrow() {
    return (
        <svg viewBox="0 0 88 88" aria-hidden="true" focusable="false">
            <path
                d="M22 66Q58 56 64 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="7"
                strokeLinecap="round"
            />
            {/* 三角沿弧线末端的切线方向摆（末端切向 ≈ (0.24, -0.97)），底边与弧的圆头相接 */}
            <path d="M66.9 12.4 70.3 27.6 56.7 24.2Z" fill="currentColor" />
        </svg>
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

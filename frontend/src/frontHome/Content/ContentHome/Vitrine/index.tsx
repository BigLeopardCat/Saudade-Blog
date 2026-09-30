import { Suspense, useEffect, useState } from 'react';
import { EXHIBITS } from './exhibits';
import './index.sass';

/**
 * 首页展示柜：一张**贴了胶带的图**，住在首屏手账内页（视频）的正下方。
 *
 * 形态（20260930 五轮，用户原话：「把展示柜作为一张粘胶带的图放到视频下面，
 * 给粘胶带的图左下角一个示意上翻的按钮点击可以翻页，要做翻页动效。翻页后可以
 * 单击展示柜，然后展示柜居中变大压暗背景，正常交互。」）：
 *
 *   封面面（标题 + 角标 + 提示）  ──左下角翻页钮──▶  图谱面（真交互）
 *                                                      │
 *                                              单击卡片 ▼
 *                                     居中放大 + 压暗背景 + 正常交互
 *
 * 三件此前没有的事，各有各的理由：
 *
 * ① **不再是"仅夜间挂载"**。原来它 `if (!isDark) return null`，占的是夜里空出来的
 *    右半屏；现在它按用户要求固定住在视频下面，白天也在。夜间档只影响**视频**
 *    （`.frontDark .heroPanel { display: none }`，20260902 的既有要求）——于是夜里
 *    这张卡就单独占着右列，正好是原来那个视觉位置。
 *
 * ② **图谱面在被翻到之前不挂载**（`mounted`）。`exhibits.ts` 那条是 `lazy(...)`，
 *    早退没了以后这是唯一的性能闸：没人翻页就一份图数据都不下载。
 *
 * ③ **内联态不给指针事件**。图谱是"拖动旋转 / 滚轮穿云"的交互件，挂在首屏正中间
 *    按老样子吃滚轮，等于访客往下滚页面时被它截住（这正是它出厂自带 `is-locked`
 *    的原因）。现在的分工是：内联态一律 `pointer-events: none`（点卡片 = 放大），
 *    放大后才 `auto`。**内联那份 `wg-lock` 解锁钮因此够不着**，但不删——它是
 *    WordGraphExhibit 自己的出厂形态，放大态里照样显示。
 */
export default function Vitrine() {
    const [flipped, setFlipped] = useState(false);
    const [mounted, setMounted] = useState(false);
    const [zoomed, setZoomed] = useState(false);

    const ex = EXHIBITS[0];
    const Body = ex.Component;

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
        // 翻页钮住在卡片里：不拦冒泡的话这一下会同时命中卡片的"放大"
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
            <span className="vit-tape vit-tapeL" aria-hidden="true" />
            <span className="vit-tape vit-tapeR" aria-hidden="true" />

            {/* perspective 只挂在这一层，**不是** `.vitrine` 的祖先链上——`perspective`
                会给 `position: fixed` 后代造包含块，挂到外面去放大态就会被框在卡片原位。 */}
            <div className="vit-3d">
                <div className="vit-face vit-cover">
                    <span className="vit-coverStar" aria-hidden="true">✦</span>
                    <span className="vit-coverTitle">{ex.title}</span>
                    <Badge of={ex} />
                    {ex.hint && <span className="vit-coverHint">{ex.hint}</span>}
                </div>

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
            </div>

            {/* 左下角的翻页钮：卷角 + 上翻箭头。收起图里就写着"示意上翻" */}
            <button
                className="vit-flip"
                type="button"
                onClick={handleFlip}
                aria-label={flipped ? '翻回封面' : '翻页查看'}
                title={flipped ? '翻回封面' : '翻页'}
            >
                <FlipIcon flipped={flipped} />
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

/** 卷角 + 上翻箭头。`flipped` 时整体倒过来，暗示"再点一下就翻回去"。 */
function FlipIcon({ flipped }: { flipped: boolean }) {
    return (
        <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            aria-hidden="true"
            style={{ transform: flipped ? 'rotate(180deg)' : 'none' }}
        >
            <path
                d="M6 15V5.6c0-.5.31-.9.78-1.05L19 1.2v14.6L6 15Z"
                fill="currentColor"
                opacity=".9"
            />
            <path
                d="M12 22.4V13m0 0 3.1 3.1M12 13l-3.1 3.1"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
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

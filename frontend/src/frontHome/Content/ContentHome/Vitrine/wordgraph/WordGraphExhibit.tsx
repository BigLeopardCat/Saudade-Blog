import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import UserState from '../../../../../interface/UserState';
import { loadGraph } from './loader';
import { locate } from './locate';
import { WordGraphEngine, cameraFor, wordKey } from './engine';
import type { GraphData, LocateHit } from './types';

/** 展品：文章向量空间知识图谱。
 *  性能前提：画布只在交互时出帧（引擎自己调度），空闲时 rAF 计数为 0；
 *  数据懒加载且模块级缓存。这里只负责 React 侧的壳。 */
export default function WordGraphExhibit() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const engRef = useRef<WordGraphEngine | null>(null);
    const [data, setData] = useState<GraphData | null>(null);
    const [failed, setFailed] = useState(false);
    const [hover, setHover] = useState<number | null>(null);
    const [sel, setSel] = useState<number | null>(null);
    const [chips, setChips] = useState<LocateHit[]>([]);
    const [q, setQ] = useState('');
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);

    const nav = useNavigate();
    const token = useSelector((s: { user: UserState }) => s.user.token) || null;

    useEffect(() => {
        let alive = true;
        loadGraph().then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setFailed(true); });
        return () => { alive = false; };
    }, []);

    useEffect(() => {
        const cv = canvasRef.current;
        if (!data || !cv) return;
        const eng = new WordGraphEngine(cv, data, {
            onHover: setHover,
            onSelect: setSel,
            onActivate: (i) => {
                const art = data.articles[data.nodes[i].a];
                if (art) nav(`/article/${art.id}`);
            },
        });
        engRef.current = eng;
        cv.style.cursor = 'grab';
        setSel(null);        // 引擎重建后旧选中索引不再有意义

        // 中文字体没就绪时 measureText 给的是西文字体的宽度，标签会明显错位
        let alive = true;
        document.fonts?.ready?.then(() => { if (alive) eng.redraw(); }).catch(() => { /* 忽略 */ });

        let ro: ResizeObserver | null = null;
        if (typeof ResizeObserver !== 'undefined') {
            ro = new ResizeObserver(() => eng.resize());
            ro.observe(cv);
        } else {
            const onWin = () => eng.resize();
            window.addEventListener('resize', onWin);
            ro = { disconnect: () => window.removeEventListener('resize', onWin) } as ResizeObserver;
        }
        return () => {
            alive = false;
            ro?.disconnect();
            eng.dispose();
            engRef.current = null;
        };
    }, [data, nav]);

    const focus = useCallback((hits: LocateHit[]) => {
        const eng = engRef.current;
        if (!eng || !data || !hits.length) return;
        eng.setHighlight(hits);
        eng.flyTo(cameraFor(data, hits, eng.getCamera()));
    }, [data]);

    /** 点推荐词：飞过去 + **选中它**——选中态会亮出连线、常驻读数卡片，
     *  卡片上写着"双击跳转这篇文章"。不选中就只有一次飞行动画，用户会以为点了个寂寞
     *  （20260915 用户报「点了 Python/partition 没转跳」，chips 本来只飞不跳）。 */
    const pick = useCallback((h: LocateHit) => {
        focus([h]);
        const eng = engRef.current;
        if (!eng || !data) return;
        // 必须走 wordKey：向量路返回的是小写词（python），产物节点是显示形（Python）。
        // 精确匹配会让 findIndex 返回 −1 → 点了 chip 既不飞也不选中（20260916 用户报的 BUG）。
        const k = wordKey(h.w);
        const i = data.nodes.findIndex((n) => wordKey(n.w) === k);
        if (i >= 0) eng.setSelected(i);
    }, [focus, data]);

    const reset = useCallback(() => {
        setChips([]);
        setNote(null);
        setQ('');
        const eng = engRef.current;
        if (eng) { eng.setSelected(null); eng.home(); }
    }, []);

    const runQuery = useCallback(async () => {
        const text = q.trim();
        if (!text || busy || !data) return;
        setBusy(true);
        setNote(null);
        try {
            const r = await locate(text, data);
            if (!r.hits.length) {
                setChips([]);
                setNote('没找到相关的词，换个说法试试');
                return;
            }
            setChips(r.hits);
            focus(r.hits);
            // 已登录却仍退化到本地 = 服务侧有问题，如实说明（不是"悄悄降级"）
            if (r.source === 'local' && token) setNote('检索服务暂时不可用，已用本地匹配');
        } finally {
            setBusy(false);
        }
    }, [q, busy, data, focus, token]);

    // 读数卡片：悬停优先（临时的），没在悬停时显示选中的那个（持久的）。
    // 卡片上写明"双击"——单击只选中不跳转，不写清楚就会被当成"点了没反应"。
    const shown = hover !== null ? hover : sel;
    const hv = shown !== null && data ? data.nodes[shown] : null;
    const hvArt = hv && data ? data.articles[hv.a] : null;

    return (
        <div className="wg-root">
            <canvas ref={canvasRef} className="wg-canvas" />

            {failed && <div className="wg-veil">图谱数据加载失败</div>}
            {!failed && !data && <div className="wg-veil">正在绘制向量空间…</div>}

            <div className="wg-foot">
                {/* 读数卡片放在 .wg-foot **内部**（绝对定位，不参与流）：它的定位基准是
                    整条 foot（检索框 + 工具行 + chips），用 bottom: calc(100% + 8px) 恒坐在
                    foot 上方。放在 foot 外面按固定像素算过：chips 行占底边上方 81~102.5px，
                    卡片 bottom:92px ⇒ 实测重叠 10.5px（20260916 用户报"标签太靠上、和窗口
                    重叠"）；chips 换行或 note 出现时更深。现在无论 foot 多高都不会撞。 */}
                {hv && (
                    <div className="wg-card">
                        <b>{hv.w}</b>
                        <span className="wg-card-meta">
                            重要度 {Math.round(hv.n * 100)}
                            {hvArt ? ` · ${hvArt.t}` : ''}
                        </span>
                        <span className="wg-card-tip">
                            {hover === null ? '已选中 · 双击跳转这篇文章' : '单击选中 · 双击跳转这篇文章'}
                        </span>
                    </div>
                )}
                {/* 回到默认视角：滚轮可以穿进点云内部再穿出去，走远了要有条明确的路回来。
                    ⚠️ **顺序**：工具行与 note 都必须在 chips **上面**（DOM 顺序 = 视觉顺序）。
                    工具行原来夹在 chips 与检索框之间，于是"检索出来的标签"和"检索框"之间
                    凭空多了 6 + 26 + 6 = 38px 的空档（20260916c 用户："间隙太大，不美观"）；
                    note 同样会插出 6 + 13 + 6 = 25px（降级提示那条路，线上验收实测到过）。
                    两行都挪到 chips 之前以后，**"chips → 检索框"恒为 6px**，与 foot 的
                    `gap: 6px` 一致；没有 chips 时这两行仍依次落在定位按钮正上方。
                    note 摆在自己的标签上方也读得通："这一批标签是降级匹配来的"。 */}
                <div className="wg-tools">
                    <button type="button" className="wg-home" onClick={() => engRef.current?.home()}
                        title="回到默认视角位置" aria-label="回到默认视角位置">
                        <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"
                            aria-hidden="true" focusable="false">
                            <path d="M473 71a8 8 0 0 1 8-8h64a8 8 0 0 1 8 8v77.161C722.848 166.622 857.812 301.289 876.729 471H952a8 8 0 0 1 8 8v64a8 8 0 0 1-8 8h-75.053C858.871 721.652 723.515 857.305 553 875.839V951a8 8 0 0 1-8 8h-64a8 8 0 0 1-8-8v-75.161C302.818 857.341 167.659 722.182 149.161 552H72a8 8 0 0 1-8-8v-64a8 8 0 0 1 8-8h77.161C167.659 301.818 302.818 166.659 473 148.161V71z m326 441c0-157.953-128.047-286-286-286S227 354.047 227 512s128.047 286 286 286 286-128.047 286-286z m-286 60c33.137 0 60-26.863 60-60s-26.863-60-60-60-60 26.863-60 60 26.863 60 60 60z"
                                fill="currentColor" />
                        </svg>
                    </button>
                </div>
                {note && <div className="wg-note">{note}</div>}
                {chips.length > 0 && (
                    <div className="wg-chips">
                        {chips.map((c) => (
                            <button key={c.w} type="button" className="wg-chip"
                                onClick={() => pick(c)}>{c.w}</button>
                        ))}
                        <button type="button" className="wg-chip wg-chip-x" onClick={reset}>×</button>
                    </div>
                )}
                <div className={'wg-queri' + (busy || chips.length ? ' is-on' : '')}>
                    <input
                        className="wg-input"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') runQuery();
                            else if (e.key === 'Escape') reset();
                        }}
                        maxLength={64}
                        disabled={!token || busy || !data}
                        placeholder={token
                            ? '输入内容，定位到最近的向量'
                            : '登录后可用向量检索'}
                        aria-label="在图谱中定位关键词"
                    />
                    <button type="button" className="wg-go"
                        onClick={runQuery} disabled={!token || busy || !data || !q.trim()}>
                        {busy ? '…' : '定位'}
                    </button>
                </div>
            </div>
        </div>
    );
}

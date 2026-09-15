import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import UserState from '../../../../../interface/UserState';
import { loadGraph } from './loader';
import { locate } from './locate';
import { WordGraphEngine, cameraFor } from './engine';
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
            onActivate: (i) => {
                const art = data.articles[data.nodes[i].a];
                if (art) nav(`/article/${art.id}`);
            },
        });
        engRef.current = eng;
        cv.style.cursor = 'grab';

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

    const reset = useCallback(() => {
        setChips([]);
        setNote(null);
        setQ('');
        engRef.current?.home();
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

    // 悬停读数：告诉用户"这是哪个词的邻居、点两下会去哪"
    const hv = hover !== null && data ? data.nodes[hover] : null;
    const hvArt = hv && data ? data.articles[hv.a] : null;

    return (
        <div className="wg-root">
            <canvas ref={canvasRef} className="wg-canvas" />

            {failed && <div className="wg-veil">图谱数据加载失败</div>}
            {!failed && !data && <div className="wg-veil">正在绘制向量空间…</div>}

            {hv && (
                <div className="wg-card">
                    <b>{hv.w}</b>
                    <span className="wg-card-meta">
                        重要度 {Math.round(hv.n * 100)}
                        {hvArt ? ` · ${hvArt.t}` : ''}
                    </span>
                    <span className="wg-card-tip">双击跳转这篇文章</span>
                </div>
            )}

            <div className="wg-foot">
                {chips.length > 0 && (
                    <div className="wg-chips">
                        {chips.map((c) => (
                            <button key={c.w} type="button" className="wg-chip"
                                onClick={() => focus([c])}>{c.w}</button>
                        ))}
                        <button type="button" className="wg-chip wg-chip-x" onClick={reset}>×</button>
                    </div>
                )}
                {note && <div className="wg-note">{note}</div>}
                <div className="wg-queri">
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
                            ? '输入一句话，定位到最近的词（回车）'
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

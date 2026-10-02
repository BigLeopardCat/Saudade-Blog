import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useSelector } from 'react-redux';
import UserState from '../../../../../interface/UserState';
import { loadGraph } from './loader';
import { locate } from './locate';
import { WordGraphEngine, cameraFor, neighborsOf, wordKey } from './engine';
import { WG_PARAM, clearSaved, decideBoot, queryFromUrl, readSaved, writeSaved } from './remember';
import type { GraphData, LocateHit } from './types';
import type { SavedSearch } from './remember';

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
    const [sp, setSp] = useSearchParams();
    const token = useSelector((s: { user: UserState }) => s.user.token) || null;

    /** 恢复载荷：**只在首次渲染算一次**——之后 URL 与缓存都会被我们自己改写，
     *  再算一次就会把用户刚清空的检索又读回来。null / undefined 都表示"不恢复"。 */
    const bootRef = useRef<SavedSearch | null | undefined>(undefined);
    if (bootRef.current === undefined) {
        bootRef.current = decideBoot(queryFromUrl((k) => sp.get(k)), readSaved());
    }
    /** 已经消费过恢复载荷的引擎实例。引擎重建（= `data` 变化）时恢复要能重放一次，
     *  所以这里比对的是实例本身，不是布尔量。 */
    const bootDoneRef = useRef<WordGraphEngine | null>(null);

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
            bootDoneRef.current = null;   // 引擎没了：下次重建要能重新恢复一次
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
        // 选中词也进缓存：回来时把用户走之前选的那个重新选上。**不进 URL**——
        // 分享出去的链接只要"搜了什么"，没必要带"点开了哪个"。
        writeSaved({ q, hits: chips.length ? chips : null, sel: h.w });
    }, [focus, data, q, chips]);

    /** 把检索串写进 URL（见 remember.ts 顶部：URL 是跨页面跳转的真源）。用 `replace`
     *  写——否则连搜三次、从文章页回来要点三次"后退"才离开首页；而被替换的正是
     *  当前这条首页记录，从文章页后退回来照样带着参数。 */
    const writeQ = useCallback((text: string | null) => {
        setSp((prev) => {
            const next = new URLSearchParams(prev);
            if (text) next.set(WG_PARAM, text); else next.delete(WG_PARAM);
            return next;
        }, { replace: true });
    }, [setSp]);

    const reset = useCallback(() => {
        setChips([]);
        setNote(null);
        setQ('');
        writeQ(null);
        clearSaved();
        bootRef.current = null;   // 用户自己清空的：回到首页不该再被恢复出来
        const eng = engRef.current;
        if (eng) { eng.setSelected(null); eng.home(); }
    }, [writeQ]);

    /** 真正的检索。**每一条结果都要落账**（URL + 缓存），恢复那一路也不例外：
     *  恢复时"重新检索"只发生在 URL 与缓存对不上的时候，此时这次结果才是当前这一次
     *  检索的正确答案——不写回去，缓存就停在旧查询上，之后从无参数的首页回来会还原出
     *  上一次的检索（线上验收 D3 抓到的）。 */
    const runQueryText = useCallback(async (text: string) => {
        const t = text.trim();
        if (!t || !data || busy) return;   // busy 期间不重复发请求（用户连按 Enter 的老行为）
        setBusy(true);
        setNote(null);
        try {
            const r = await locate(t, data);
            if (!r.hits.length) {
                setChips([]);
                setNote('没找到相关的词，换个说法试试');
                writeQ(t);
                writeSaved({ q: t, hits: null, sel: null });
                return;
            }
            setChips(r.hits);
            focus(r.hits);
            writeQ(t);
            writeSaved({ q: t, hits: r.hits, sel: null });
            // 已登录却仍退化到本地 = 服务侧有问题，如实说明（不是"悄悄降级"）
            if (r.source === 'local' && token) setNote('检索服务暂时不可用，已用本地匹配');
        } finally {
            setBusy(false);
        }
    }, [data, busy, focus, token, writeQ]);

    const runQuery = useCallback(() => { void runQueryText(q); }, [q, runQueryText]);

    /** 恢复上次的检索。**必须在引擎就绪之后**：高亮 / 相机 / 选中全落在引擎实例上，
     *  而引擎要等 `data` 到了才建（见上面那个 effect）。每个引擎实例只消费一次，
     *  所以用户随后的手动检索不会被它盖回去。 */
    useEffect(() => {
        const eng = engRef.current;
        const boot = bootRef.current;
        if (!data || !eng || !boot || bootDoneRef.current === eng) return;
        bootDoneRef.current = eng;
        setQ(boot.q);
        if (boot.hits && boot.hits.length) {
            setChips(boot.hits);
            focus(boot.hits);                     // 与手动检索走同一条路，画面表现一致
            const k = boot.sel ? wordKey(boot.sel) : '';
            const i = k ? data.nodes.findIndex((n) => wordKey(n.w) === k) : -1;
            if (i >= 0) eng.setSelected(i);
            return;
        }
        void runQueryText(boot.q);                // 只有查询串（缓存里没有对应命中）→ 重新检索
    }, [data, focus, runQueryText]);

    // 读数卡片：悬停优先（临时的），没在悬停时显示选中的那个（持久的）。
    // 卡片上写明"双击"——单击只选中不跳转，不写清楚就会被当成"点了没反应"。
    const shown = hover !== null ? hover : sel;
    const hv = shown !== null && data ? data.nodes[shown] : null;
    const hvArt = hv && data ? data.articles[hv.a] : null;
    /** 这个词的直接邻居（按相似度降序）。20260917 用户要："悬浮时除了自己，也把
     *  与它直接相连的展示出来"——"这个词连着谁"本来就是这张图最主要的信息，
     *  以前只能靠肉眼顺着高亮线去找。悬停与选中共用同一张卡片，所以两者都列。
     *  ⚠️ 只展示不可点：卡片是 pointer-events:none（见 index.sass），开了点击就得
     *  让开画布拖拽/双击那块区域，得不偿失。 */
    const nbWords = useMemo(
        () => (shown !== null && data ? neighborsOf(data, shown) : []),
        [shown, data]);

    // 读不到产物 ⇒ 整块不渲染，**不再**画一张「图谱数据加载失败」的面纱。
    // 与角标那条一个取向：不可用就不显示，而不是给访客看一张坏卡片。展品本身已经过了
    // 语料归属自校验（exhibits.ts）才会挂载到这里，所以走到这一步是真读不到产物。
    if (failed) return null;

    return (
        <div className="wg-root">
            <canvas ref={canvasRef} className="wg-canvas" />

            {!data && <div className="wg-veil">正在绘制向量空间…</div>}

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
                        {nbWords.length > 0 && (
                            <span className="wg-card-nb">
                                相连 {nbWords.slice(0, 6).map((x) => x.w).join(' · ')}
                                {nbWords.length > 6 ? ` …共 ${nbWords.length} 个` : ''}
                            </span>
                        )}
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
                        // 非凭据字段（20260923）：全页只有它是"无 type/无 name/无 autocomplete"的
                        // 裸文本框，同源又存在带 name="account" + autoComplete="username" 的登录框
                        // ⇒ 密码管理器把它当成本页的用户名候选回填。显式声明用途 + 各家忽略标记。
                        name="wordgraph-query"
                        type="text"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        data-form-type="other"
                        data-1p-ignore
                        data-lpignore="true"
                        data-bwignore
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
                        onClick={() => runQuery()} disabled={!token || busy || !data || !q.trim()}>
                        {busy ? '…' : '定位'}
                    </button>
                </div>
            </div>
        </div>
    );
}

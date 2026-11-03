import { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import type UserState from '../../interface/UserState';
import { loadGraph, resetGraphCache, SiteMismatchError } from './loader';
import { locate, type LocateResult } from './locate';
import { cameraFor, WordGraphEngine, wordKey } from './engine';
import type { GraphData, LocateHit } from './types';
import './index.scss';

/** A keyword graph for exploring related articles; 3D distances are not relevance scores. */
export default function ArticleGraph({ query, composing = false }: { query: string; composing?: boolean }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const engine = useRef<WordGraphEngine | null>(null);
    const [data, setData] = useState<GraphData | null>(null);
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);
    const [result, setResult] = useState<LocateResult | null>(null);
    const [busy, setBusy] = useState(false);
    const [selected, setSelected] = useState<number | null>(null);
    const token = useSelector((state: { user: UserState }) => state.user.token);
    const nav = useNavigate();

    useEffect(() => {
        let active = true;
        setError('');
        loadGraph().then(value => { if (active) setData(value); }).catch(reason => {
            if (active) setError(reason instanceof SiteMismatchError
                ? '本站的文章图谱尚未生成，可继续使用内容搜索。'
                : '文章图谱暂不可用，可重试或切回内容搜索。');
        });
        return () => { active = false; };
    }, [attempt]);

    useEffect(() => {
        if (!canvas.current || !data) return;
        const graph = new WordGraphEngine(canvas.current, data, {
            onHover: () => undefined,
            onSelect: setSelected,
            onActivate: index => {
                const article = data.articles[data.nodes[index].a];
                if (article) nav(`/article/${article.id}`);
            },
        });
        engine.current = graph;
        const observer = new ResizeObserver(() => graph.resize());
        observer.observe(canvas.current);
        let active = true;
        document.fonts?.ready.then(() => { if (active) graph.redraw(); });
        return () => {
            active = false;
            observer.disconnect();
            graph.dispose();
            engine.current = null;
        };
    }, [data, nav]);

    useEffect(() => {
        if (!data || composing) return;
        const controller = new AbortController();
        setResult(null);
        setSelected(null);
        engine.current?.setSelected(null);
        engine.current?.setHighlight([]);
        if (!query) {
            engine.current?.home();
            setBusy(false);
            return;
        }
        setBusy(true);
        const timer = setTimeout(() => {
            void locate(query, data, controller.signal).then(found => {
                if (controller.signal.aborted) return;
                setResult(found);
                const graph = engine.current;
                if (graph && found.hits.length) {
                    graph.setHighlight(found.hits);
                    graph.flyTo(cameraFor(data, found.hits, graph.getCamera()));
                }
            }).catch(() => {
                if (!controller.signal.aborted) setError('检索暂不可用，请稍后重试。');
            }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
        }, 300);
        return () => { clearTimeout(timer); controller.abort(); };
    }, [query, composing, data, token, attempt]);

    const pick = (hit: LocateHit) => {
        if (!data || !engine.current) return;
        const index = data.nodes.findIndex(node => wordKey(node.w) === wordKey(hit.w));
        if (index < 0) return;
        engine.current.setSelected(index);
        engine.current.flyTo(cameraFor(data, [hit], engine.current.getCamera()));
    };
    const article = selected === null || !data ? null : data.articles[data.nodes[selected]?.a];
    // Accessible article links accompany the canvas; keyboard users do not need to rotate it.
    const articleIds = new Set<number>();
    const articles = data && result ? result.hits.flatMap(hit => {
        const node = data.nodes.find(item => wordKey(item.w) === wordKey(hit.w));
        if (!node) return [];
        return [node.a, node.a2].flatMap(index => {
            const row = data.articles[index];
            if (!row || articleIds.has(row.id)) return [];
            articleIds.add(row.id);
            return [row];
        });
    }) : [];
    return <section className="articleGraph" aria-label="文章向量图谱">
        <div className="articleGraphHeader">
            <span>拖动旋转 · 滚轮缩放 · 双击节点阅读文章</span>
            <button type="button" onClick={() => engine.current?.home()}>重置视角</button>
        </div>
        <div className="articleGraphViewport">
            <canvas ref={canvas} aria-label="文章关键词关系图" />
            {!data && !error && <p role="status" className="articleGraphPlaceholder">正在加载文章图谱…</p>}
            {error && <div role="alert" className="articleGraphPlaceholder">{error}
                <button type="button" onClick={() => { resetGraphCache(); setAttempt(value => value + 1); }}>重试</button>
            </div>}
            {article && <a className="articleGraphSelection" href={`/article/${article.id}`} onClick={event => {
                event.preventDefault(); nav(`/article/${article.id}`);
            }}>阅读：{article.t}</a>}
        </div>
        <div className="articleGraphStatus" role="status">
            {busy ? '正在定位相关关键词…' : result?.source === 'local'
                ? result.reason === 'login_required' ? '当前使用关键词匹配，登录后可使用语义检索。' : '语义检索暂不可用，当前显示关键词匹配结果。'
                : result ? '已按语义关联定位；图中距离仅供探索参考。' : '输入问题，探索相关关键词和文章。'}
            {result && !result.hits.length && !busy && ' 未找到匹配内容。'}
        </div>
        {!!result?.hits.length && <div className="articleGraphKeywords" aria-label="相关关键词">
            {result.hits.map(hit => <button type="button" key={hit.w} onClick={() => pick(hit)}>{hit.w}</button>)}
        </div>}
        {!!articles.length && <nav className="articleGraphArticles" aria-label="相关文章">
            {articles.map(row => <a key={row.id} href={`/article/${row.id}`} onClick={event => {
                event.preventDefault(); nav(`/article/${row.id}`);
            }}>{row.t}</a>)}
        </nav>}
    </section>;
}

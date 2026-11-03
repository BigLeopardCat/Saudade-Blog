import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Space } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import { useAggregateSearchQueryState, useLazyAggregateSearchQuery } from '../../apis/SearchMethods';
import { allHits, hitsOf, TYPE_LABEL, TYPE_ORDER } from '../../frontHome/Head/aggregate';
import type { AggregateTarget, SearchType } from '../../frontHome/Head/aggregate';
import { highlightParts } from './highlight';
import './index.scss';
const ArticleGraph = lazy(() => import('../ArticleGraph'));

export default function AggregateSearch({ onOpen }: { onOpen: (hit: AggregateTarget) => void }) {
    const openGraphArticle = useCallback((id: number) => onOpen({type: 'note', key: id, noteId: null}), [onOpen]);
    const [keyword, setKeyword] = useState('');
    const [mode, setMode] = useState<'content' | 'graph'>('content');
    const [type, setType] = useState<SearchType | 'all'>('all');
    const [page, setPage] = useState(1);
    const [activeIndex, setActiveIndex] = useState(0);
    const [composing, setComposing] = useState(false);
    const [trigger] = useLazyAggregateSearchQuery();
    const lastQuery = useRef('');
    const request = useRef<ReturnType<typeof trigger> | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const query = keyword.trim();
    const args = { keyword: query, page, pageSize: 20, ...(type !== 'all' ? { type } : {}) };
    const selectedState = useAggregateSearchQueryState(args, { skip: !query || mode !== 'content' });
    const overview = useAggregateSearchQueryState({ keyword: query, page: 1, pageSize: 20 }, { skip: !query || mode !== 'content' });
    const data = selectedState.currentData;
    const preview = page === 1 ? overview.currentData : undefined;
    const info = data || preview;
    const pending = !!query && (composing || selectedState.isFetching || (!data && !selectedState.isError));
    const rows = data ? (type === 'all' ? allHits(data) : hitsOf(data, type)) :
        preview && type !== 'all' ? hitsOf(preview, type) : [];
    const selected = Math.min(activeIndex, rows.length - 1);
    const marks = info?.terms || query.split(/\s+/);
    const highlight = (text: string) => highlightParts(text, marks).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : part.text);

    useEffect(() => {
        if (!query || composing || mode !== 'content') return;
        timer.current = setTimeout(() => {
            timer.current = null;
            lastQuery.current = query;
            request.current = trigger({ keyword: query, page, pageSize: 20, ...(type !== 'all' ? { type } : {}) }, true);
        }, lastQuery.current === query ? 0 : 300);
        return () => {
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = null;
            request.current?.abort();
        };
    }, [query, page, type, composing, trigger, mode]);
    useEffect(() => {
        (mode === 'content' ? document.getElementById(`aggregate-hit-${selected}`) : null)?.scrollIntoView?.({ block: 'nearest' });
    }, [selected, mode]);
    const submit = () => {
        if (!query || composing || mode !== 'content') return;
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = null;
        request.current?.abort();
        lastQuery.current = query;
        request.current = trigger(args, true);
    };
    const changeType = (next: SearchType | 'all') => {
        setType(next);
        setPage(1); setActiveIndex(0);
    };
    const error = selectedState.isError && !pending ? selectedState.error : undefined;
    const errorMessage = error && 'message' in error ? error.message : '搜索失败，请稍后重试';
    return <section className="aggregateSearch" aria-label="站内聚合搜索">
        <div className="aggregateSearchInput">
            <input autoFocus type="text" inputMode="search" role="combobox" aria-label="搜索站内内容"
                aria-autocomplete="list" aria-expanded={mode === 'content' && rows.length > 0} aria-controls="aggregate-search-results"
                aria-activedescendant={mode === 'content' && rows.length ? `aggregate-hit-${selected}` : undefined}
                className="searchModalInput" placeholder={mode === 'graph' ? '描述问题，探索相关文章图谱' : '搜索文章、说说、留言和评论'} maxLength={mode === 'graph' ? 64 : 128} value={keyword}
                onChange={event => { setKeyword(event.target.value); setPage(1); setType('all'); setActiveIndex(0); }}
                onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
                onKeyDown={event => {
                    if (event.nativeEvent.isComposing || composing) return;
                    if (mode === 'graph') { if (event.key === 'Enter') event.preventDefault(); return; }
                    if (event.key === 'ArrowDown' && rows.length) { event.preventDefault(); setActiveIndex((selected + 1) % rows.length); }
                    if (event.key === 'ArrowUp' && rows.length) { event.preventDefault(); setActiveIndex((selected + rows.length - 1) % rows.length); }
                    if (event.key === 'Enter') { event.preventDefault(); if (rows[selected]) onOpen(rows[selected]); else submit(); }
                }} />
            {keyword && <button type="button" className="searchClear" aria-label="清空搜索"
                onClick={() => { setKeyword(''); setPage(1); setType('all'); setActiveIndex(0); }}><CloseOutlined /></button>}
            <button type="button" className="searchMode" aria-label="文章向量图谱检索" aria-pressed={mode === 'graph'}
                onClick={() => { setMode(value => value === 'content' ? 'graph' : 'content'); setActiveIndex(0); }}>
                {mode === 'graph' ? '内容搜索' : '文章图谱'}
            </button>
        </div>
        {mode === 'graph' && <Suspense fallback={<p role="status">正在加载文章图谱…</p>}>
            <ArticleGraph query={query} composing={composing} onOpenArticle={openGraphArticle} />
        </Suspense>}
        {mode === 'content' && query && <Card variant="borderless" className="aggregateSearchCard" title={<div className="searchTitleRow">
            <span className="searchTotal">搜索结果{info ? `（${info.total}）` : ''}</span>
            <span className="searchChips"><button type="button" className={`search-chip${type === 'all' ? ' is-active' : ''}`}
                aria-pressed={type === 'all'} onClick={() => changeType('all')}>全部</button>{TYPE_ORDER.map(kind => <button key={kind} type="button"
                className={`search-chip${type === kind ? ' is-active' : ''}`} aria-pressed={type === kind}
                onClick={() => changeType(kind)}>{TYPE_LABEL[kind]}（{info?.counts?.[kind] ?? '…'}）</button>)}</span>
        </div>}>
            <div className="searchStatus">{pending && <p role="status" className="searchBusy">正在读取结果…</p>}</div>
            {error && <div role="alert" className="searchEmpty">{errorMessage}<Button onClick={submit}>重试</Button></div>}
            <div id="aggregate-search-results" role="listbox" aria-label="搜索结果" aria-busy={pending} className="search-results-list">
                {rows.map((hit, index) => <button key={`${hit.type}-${hit.key}`} type="button" role="option"
                    tabIndex={-1} id={`aggregate-hit-${index}`} aria-selected={index === selected}
                    onMouseEnter={() => setActiveIndex(index)} onClick={() => onOpen(hit)} className="search-item">
                    <span className={`search-badge search-badge-${hit.type}`}>{TYPE_LABEL[hit.type]}</span>
                    <span className="search-item-main">
                        {hit.title && <span className="search-item-title">{highlight(hit.title)}</span>}
                        <span className="search-item-snippet">{highlight(hit.snippet)}</span>
                        <span className="search-item-meta">{[hit.author, hit.createTime].filter(Boolean).join(' · ')}</span>
                    </span>
                </button>)}
            </div>
            {data && rows.length === 0 && <p className="searchEmpty">{data.total === 0 ? '未找到相关内容' : type !== 'all' ? `「${TYPE_LABEL[type]}」里没有命中的内容` : '本页没有更多结果'}</p>}
            {data && <Space className="searchPagination" wrap>
                <span>第 {page} 页，本页 {rows.length} 条，共 {type === 'all' ? data.total : data.counts[type]} 条</span>
                <Button disabled={page <= 1} onClick={() => { setPage(value => value - 1); setActiveIndex(0); }}>上一页</Button>
                <Button disabled={!data.hasMore || page >= 100} onClick={() => { setPage(value => value + 1); setActiveIndex(0); }}>下一页</Button>
            </Space>}
        </Card>}
    </section>;
}

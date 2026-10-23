import { useEffect, useRef, useState } from 'react';
import { Button, Card, Space } from 'antd';
import { useLazyAggregateSearchQuery } from '../../apis/SearchMethods';
import { allHits, hitsOf, TYPE_LABEL, TYPE_ORDER } from '../../frontHome/Head/aggregate';
import type { AggregateHit, SearchType } from '../../frontHome/Head/aggregate';
import { highlightParts } from './highlight';
import './index.scss';

export default function AggregateSearch({ onOpen }: { onOpen: (hit: AggregateHit) => void }) {
    const [keyword, setKeyword] = useState('');
    const [type, setType] = useState<SearchType | 'all'>('all');
    const [page, setPage] = useState(1);
    const [activeIndex, setActiveIndex] = useState(0);
    const [composing, setComposing] = useState(false);
    const [trigger, result] = useLazyAggregateSearchQuery();
    const request = useRef<ReturnType<typeof trigger> | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const query = keyword.trim();
    const args = { keyword: query, page, pageSize: 20, ...(type !== 'all' ? { type } : {}) };
    const current = result.originalArgs?.keyword === query && (result.originalArgs?.page || 1) === page &&
        (result.originalArgs?.type || 'all') === type;
    // Input changes hide stale rows synchronously, including the debounce window.
    const pending = !!query && (!current || result.isFetching || composing);
    const data = current && !pending && !result.isError ? result.data : undefined;
    const rows = data ? (type === 'all' ? allHits(data) : hitsOf(data, type)) : [];
    const selected = Math.min(activeIndex, rows.length - 1);
    const marks = data?.terms || query.split(/\s+/);
    const highlight = (text: string) => highlightParts(text, marks).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : part.text);

    useEffect(() => {
        if (!query || composing) return;
        timer.current = setTimeout(() => {
            timer.current = null;
            request.current = trigger({ keyword: query, page, pageSize: 20, ...(type !== 'all' ? { type } : {}) });
        }, 300);
        return () => {
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = null;
            request.current?.abort();
        };
    }, [query, page, type, composing, trigger]);
    useEffect(() => {
        document.getElementById(`aggregate-hit-${selected}`)?.scrollIntoView?.({ block: 'nearest' });
    }, [selected]);
    const submit = () => {
        if (!query || composing) return;
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = null;
        request.current?.abort();
        request.current = trigger(args);
    };
    const changeType = (next: SearchType) => {
        setType(previous => previous === next ? 'all' : next);
        setPage(1); setActiveIndex(0);
    };
    const error = current && result.isError && !pending ? result.error : undefined;
    const errorMessage = error && 'message' in error ? error.message : '搜索失败，请稍后重试';
    return <section className="aggregateSearch" aria-label="站内聚合搜索">
        <div className="aggregateSearchInput">
            <input autoFocus type="search" role="combobox" aria-label="搜索站内内容"
                aria-autocomplete="list" aria-expanded={rows.length > 0} aria-controls="aggregate-search-results"
                aria-activedescendant={rows.length ? `aggregate-hit-${selected}` : undefined}
                className="searchModalInput" placeholder="搜索文章、说说、留言和评论" maxLength={128} value={keyword}
                onChange={event => { setKeyword(event.target.value); setPage(1); setType('all'); setActiveIndex(0); }}
                onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
                onKeyDown={event => {
                    if (event.nativeEvent.isComposing || composing) return;
                    if (event.key === 'ArrowDown' && rows.length) { event.preventDefault(); setActiveIndex((selected + 1) % rows.length); }
                    if (event.key === 'ArrowUp' && rows.length) { event.preventDefault(); setActiveIndex((selected + rows.length - 1) % rows.length); }
                    if (event.key === 'Enter') { event.preventDefault(); if (rows[selected]) onOpen(rows[selected]); else submit(); }
                }} />
            <Button onClick={submit} disabled={!query || composing}>搜索</Button>
        </div>
        {query && <Card variant="borderless" className="aggregateSearchCard" title={<div className="searchTitleRow">
            <span className="searchTotal">搜索结果{data ? `（${data.total}）` : ''}</span>
            <span className="searchChips">{TYPE_ORDER.map(kind => <button key={kind} type="button"
                className={`search-chip${type === kind ? ' is-active' : ''}`} aria-pressed={type === kind}
                onClick={() => changeType(kind)}>{TYPE_LABEL[kind]}（{data?.counts?.[kind] ?? '…'}）</button>)}</span>
        </div>}>
            {pending && <p role="status" className="searchBusy">搜索中...</p>}
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

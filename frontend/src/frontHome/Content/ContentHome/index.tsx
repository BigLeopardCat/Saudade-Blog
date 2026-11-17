import SeoHelmet from "../../../components/SeoHelmet";

import {SITE_TITLE, SITE_DESCRIPTION} from "../../../utils/siteUrl";
import './index.sass'
// Section styles override the home defaults.
import '../../../scene.css'
import './featured.sass'
import FeaturedArticles from './FeaturedArticles'
import {getPinnedAnnouncements, type AnnouncementItem} from '../../../apis/AnnouncementMethods'
import {ANNOUNCEMENT_PUBLISHED_EVENT} from '../../../components/AnnouncementModal/pending'
import SocialButton from "../../../components/Buttons/SocialButton";
import {useCallback, useEffect, useRef, useState} from "react";
import {hasArticleInvalidation} from "../../../components/UserCenter/agentTurn.ts";
import {useLiveRefresh} from "../../../utils/liveRefresh.ts";
import {useSelector} from "react-redux";
import UserState from "../../../interface/UserState";
import {formatNote, NoteType} from "../../../interface/NoteType";
import {categoryList} from "../../../store/components/categories.tsx";
import Article from "./Article.tsx";
import SectionHeading from '../../../components/SectionHeading';
import {useLocation} from "react-router-dom";
import {SocialType} from "../../../interface/SocialType";
import {getNoteFeed, getTopNotes} from "../../../apis/NoteMethods.tsx";
import { parseNoteTags } from '../../../utils/noteTags';
import heroBg from '../../../assets/hero_bg.mp4';
import heroPoster from '../../../assets/hero_poster.jpg';
import { createArticleFeed, requireArticlePage, requireArticleRows } from './articleFeed';

let cachedOtherArticles: NoteType[] = [];
let cachedTopArticles: NoteType[] = [];
let cachedCurrentPage = 1;
let cachedHasMoreArticles = true;
let cachedNextCursor: string | null = null;
let isCachedOther = false;

let cachedPageSize = 6;

const FALLBACK_PAGE_SIZE = 6;
const MAX_PAGE_SIZE = 48;
const DESKTOP_ROWS = 2;
const NARROW_COLS = 2;
const NARROW_ROWS = 4;

// Measure a full-width probe so empty auto-fit tracks do not depend on loaded rows.
const colsOf = (el: HTMLElement | null): number => {
    if (!el) return 0
    return getComputedStyle(el).gridTemplateColumns
        .split(' ')
        .filter(t => t.endsWith('px') && parseFloat(t) > 0).length
}

const pageSizeFor = (cols: number): number =>
    Number.isFinite(cols) && cols > 0
        ? Math.min(cols * (cols <= NARROW_COLS ? NARROW_ROWS : DESKTOP_ROWS), MAX_PAGE_SIZE)
        : FALLBACK_PAGE_SIZE

const mapRows = (rows: unknown[]): NoteType[] => rows.map(raw => {
    if (!raw || typeof raw !== 'object' || !('noteKey' in raw) || !('noteTitle' in raw)) {
        throw new Error('Invalid article row');
    }
    const item = raw as formatNote;
    return { ...item, key: String(item.noteKey), noteTags: parseNoteTags(item.noteTags) } as unknown as NoteType;
});

const ContentHome = () => {
    const heroRef = useRef<HTMLDivElement>(null);

    const pageSizeRef = useRef(cachedPageSize);

    const topGenerationRef = useRef(0);
    const topPendingRef = useRef<Promise<void> | null>(null);
    const [topError, setTopError] = useState(false);
    const measureRef = useRef<HTMLDivElement>(null);
    const feedBoundaryRef = useRef<HTMLDivElement>(null);
    const location = useLocation();

    const avatar = useSelector((state:{user:UserState}) => state.user.avatar)
    const name = useSelector((state:{user:UserState}) => state.user.name)
    const [feed] = useState(() => {
        if (location.state?.fromDashboard) {
            cachedOtherArticles = [];
            cachedTopArticles = [];
            cachedCurrentPage = 1;
            cachedHasMoreArticles = true;
            cachedNextCursor = null;
            cachedPageSize = FALLBACK_PAGE_SIZE;
            isCachedOther = false;
            pageSizeRef.current = FALLBACK_PAGE_SIZE;
        }
        return createArticleFeed<NoteType>(async (cursor, pageSize) => {
            const response = await getNoteFeed({ limit: pageSize, ...(cursor ? { cursor } : {}) });
            const result = requireArticlePage(response);
            return { items: mapRows(result.items), nextCursor: result.nextCursor };
        }, {
            items: cachedOtherArticles, page: cachedCurrentPage, pageSize: cachedPageSize,
            hasMore: cachedHasMoreArticles, loaded: isCachedOther, nextCursor: cachedNextCursor,
        }, state => {
            cachedOtherArticles = state.items;
            cachedCurrentPage = state.page;
            cachedPageSize = state.pageSize;
            cachedHasMoreArticles = state.hasMore;
            cachedNextCursor = state.nextCursor;
            isCachedOther = true;
        }, item => item.key);
    });
    const [feedState, setFeedState] = useState(feed.snapshot);
    const { items: otherArticles, hasMore: hasMoreArticles, loading } = feedState;
    const [pinnedAnnouncements, setPinnedAnnouncements] = useState<AnnouncementItem[]>([])
    const [pinError, setPinError] = useState(false)
    const pinRequest = useRef<AbortController | null>(null)
    const loadPins = useCallback(async () => {
        pinRequest.current?.abort()
        const controller = new AbortController()
        pinRequest.current = controller
        try {
            const {data} = await getPinnedAnnouncements(controller.signal)
            if (controller.signal.aborted) return
            if (data.code !== 200 || !Array.isArray(data.data)) throw new Error('pin read failed')
            setPinnedAnnouncements(data.data)
            setPinError(false)
        } catch {
            if (!controller.signal.aborted) setPinError(true)
        }
    }, [])
    useEffect(() => {
        void loadPins()
        const refresh = () => { void loadPins() }
        window.addEventListener(ANNOUNCEMENT_PUBLISHED_EVENT, refresh)
        return () => {pinRequest.current?.abort(); window.removeEventListener(ANNOUNCEMENT_PUBLISHED_EVENT, refresh)}
    }, [loadPins])
    useLiveRefresh(loadPins, {poll: false})
    const [topArticles,setTopArticles] = useState<NoteType[]>(cachedTopArticles);
    useEffect(() => {
        const unsubscribe = feed.subscribe(setFeedState);
        return () => {
            unsubscribe();
            feed.invalidate();
            ++topGenerationRef.current;
            topPendingRef.current = null;
        };
    }, [feed]);
    const [enterAnimation] = useState(() => !(isCachedOther && cachedOtherArticles.length > 0))
    const Categories = useSelector((state: { categories: categoryList }) => state.categories.categories);
    const tagList = useSelector((state: {tags: any}) => state.tags.tag)
    const social = useSelector((state:{user:{social: SocialType}}) => state.user.social)

    useEffect(() => {
        const hero = heroRef.current;
        if (!hero) return;
        const video = hero.querySelector('video');
        if (!video) return;
        video.playbackRate = 1;
        let visible = false;
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
        const update = () => {
            if (visible && !document.hidden && !reduced.matches) video.play().catch(() => {});
            else video.pause();
        };
        const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update(); }, {threshold: 0.05});
        observer.observe(hero);
        document.addEventListener('visibilitychange', update);
        reduced.addEventListener('change', update);
        update();
        return () => { observer.disconnect(); video.pause(); document.removeEventListener('visibilitychange', update); reduced.removeEventListener('change', update); };
    }, []);

    const fetchFirst = (ps: number, opts?: { silent?: boolean }) => {
        pageSizeRef.current = ps;
        return feed.first(ps, opts?.silent);
    };

    useEffect(() => {
        if (isCachedOther) return;
        fetchFirst(pageSizeFor(colsOf(measureRef.current)));
    }, []);

    useEffect(() => {
        const el = measureRef.current;
        if (!el) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const ro = new ResizeObserver(() => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                const ps = pageSizeFor(colsOf(el));
                if (ps !== pageSizeRef.current) fetchFirst(ps);
            }, 200);
        });
        ro.observe(el);
        return () => {
            if (timer) clearTimeout(timer);
            ro.disconnect();
        };
    }, []);

    const fetchTop = () => {
        if (topPendingRef.current) return topPendingRef.current;
        const generation = ++topGenerationRef.current;
        setTopError(false);
        const promise = getTopNotes().then(res => {
            const mapped = mapRows(requireArticleRows(res));
            if (generation !== topGenerationRef.current) return;
            setTopArticles(mapped);
            cachedTopArticles = mapped;
        }).catch(() => {
            if (generation === topGenerationRef.current) setTopError(true);
        }).finally(() => {
            if (generation === topGenerationRef.current) topPendingRef.current = null;
        });
        topPendingRef.current = promise;
        return promise;
    };

    useEffect(() => {
        if (cachedTopArticles.length > 0) return;
        fetchTop();
    }, []);

    useLiveRefresh((invalidate) => {
        if (!invalidate && (feed.snapshot().page > 1 || feed.snapshot().pending)) return;
        const generation = topGenerationRef.current;
        const top = topPendingRef.current;
        const refreshTop = top
            ? top.then(() => generation === topGenerationRef.current ? fetchTop() : undefined)
            : fetchTop();
        return Promise.all([refreshTop, invalidate ? feed.refresh() : feed.first(pageSizeRef.current, true)]).then(() => {});
    }, { poll: false, agentEvent: hasArticleInvalidation });
    useEffect(() => {
        if (!feedState.loaded || feedState.pending || feedState.error || !hasMoreArticles) return;
        const target = feedBoundaryRef.current;
        if (!target) return;
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) void feed.more();
        }, { rootMargin: '0px 0px 320px 0px' });
        observer.observe(target);
        return () => observer.disconnect();
    }, [feed, feedState.loaded, feedState.pending, feedState.error, feedState.nextCursor, hasMoreArticles]);

    return <>
        <SeoHelmet title={SITE_TITLE} description={SITE_DESCRIPTION} url="/" suffix={false} />
        <section className="homeFirstScreen" aria-label="首页与置顶内容">
        <div className="SelfDescription" ref={heroRef}>
            <div className="SayWords">
                <h1 className="home-title-h3">Sereno da Saudade</h1>
                <div className="Social">
                    {social?.socialQQ && <SocialButton SocialName='QQ' copyText={social.socialQQ}/>}
                    {social?.socialGithub && <SocialButton SocialName='Github' url={social.socialGithub}/>}
                    {social?.socialBilibili && <SocialButton SocialName='Bilibili' url={social.socialBilibili}/>}
                    {social?.socialEmail && <SocialButton SocialName='Email' copyText={social.socialEmail}/>}
                </div>
            </div>

            <div className="heroRight">
                <figure className="heroPanel">
                    <video
                        className="heroVideo"
                        src={heroBg}
                        poster={heroPoster}
                        muted
                        loop
                        playsInline
                        preload="metadata"
                        disablePictureInPicture
                        aria-hidden="true"
                    />
                </figure>
            </div>
        </div>
        <div className="homePinned">
            {topError && <div role="status" className="homeLoadError">置顶加载失败 <button type="button" onClick={() => { void fetchTop(); }}>重试</button></div>}
            {pinError && <div role="status" className="homeLoadError">置顶公告加载失败 <button type="button" onClick={() => {void loadPins()}}>重试</button></div>}
            {(topArticles.length > 0 || pinnedAnnouncements.length > 0) && <FeaturedArticles announcements={pinnedAnnouncements} items={topArticles} categories={Categories} avatar={avatar} name={name} tags={tagList}/>}
        </div>
        </section>
        <div className="ContentContainer dark-pic" id="home-articles">
            <div className="homeSectionHeading">
                <SectionHeading icon="document">文章</SectionHeading>
            </div>

            <div className="allArticles allArticlesMeasure" aria-hidden="true" ref={measureRef}>
                <div style={{ gridColumn: '1 / -1' }} />
            </div>

            <div className="allArticles">

                {otherArticles.map((item,index) => (
                    <Article item={item} index={index} Categories={Categories} avatar={avatar} name={name} tagList={tagList} enter={enterAnimation} key={item.key}/>
                ))}
            </div>
            {feedState.error && <div role="status" className="homeLoadError">
                {feedState.error} <button type="button" disabled={feedState.pending} onClick={() => { void feed.retry(); }}>重试</button>
            </div>}
            {feedState.loaded && !feedState.error && otherArticles.length === 0 && <p role="status">暂无公开文章</p>}
            <div className="homeFeedBoundary" ref={feedBoundaryRef} role="status" aria-live="polite">
                {loading ? '正在加载文章…' : !feedState.error && feedState.loaded && otherArticles.length > 0
                    ? hasMoreArticles ? '继续向下浏览' : '已经看到全部文章了' : null}
            </div>
        </div>
    </>
}

export default ContentHome
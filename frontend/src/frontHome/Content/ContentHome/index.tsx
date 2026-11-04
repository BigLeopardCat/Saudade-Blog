import SeoHelmet from "../../../components/SeoHelmet";
// 首页的站名与描述走站点身份（构建期变量，默认值是中性占位）——**别在这里写死文案**：
// 仓库是公开的，写死等于把本站的品牌与描述交给每一个 clone 它的人。
import {SITE_TITLE, SITE_DESCRIPTION} from "../../../utils/siteUrl";
import './index.sass'
// 段落带（首页被切成几段、每段什么色）单独一份，见 sections.sass 头注。
// ⚠️ **必须排在 `./index.sass` 之后**：同特异度下后写者赢，挪到前面就等于整份没写。
import './sections.sass'
import SocialButton from "../../../components/Buttons/SocialButton";
import {useEffect, useRef, useState} from "react";
import {useLiveRefresh} from "../../../utils/liveRefresh.ts";
import {useSelector} from "react-redux";
import UserState from "../../../interface/UserState";
import { motion } from 'framer-motion';
import {formatNote, NoteType} from "../../../interface/NoteType";
import {categoryList} from "../../../store/components/categories.tsx";
import Article from "./Article.tsx";
import NoteByline from "../../../components/NoteByline";
import {useNavigate, useLocation} from "react-router-dom";
import {SocialType} from "../../../interface/SocialType";
import {getNotePage, getTopNotes} from "../../../apis/NoteMethods.tsx";
import { resolveApiAssetUrl } from '../../../utils/runtimeApi';
import { carouselCropOf, coverCropStyle } from '../../../utils/coverCrop';
import { parseNoteTags } from '../../../utils/noteTags';
import { renderNoteTags } from '../../../apis/TagMethods.tsx';
import { resetDescScroll } from '../../../utils/descHover';
import heroBg from '../../../assets/hero_bg.mp4';
import heroPoster from '../../../assets/hero_poster.jpg';
import { createArticleFeed, requireArticleRows } from './articleFeed';


// 模块级缓存：只在同一次 SPA 会话内复用，离开 Dashboard 后自动失效
let cachedOtherArticles: NoteType[] = [];
let cachedTopArticles: NoteType[] = [];
let cachedCurrentPage = 1;
let cachedHasMoreArticles = true;
let isCachedOther = false;
// 与 cachedOtherArticles 配套的每页条数：缓存必须连页尺寸一起复用，
// 否则「列数变化后重拉」与「More 续翻」会用到两个不同的 per_page（页偏移错位 → 重复/漏项）
let cachedPageSize = 6;

const FALLBACK_PAGE_SIZE = 6;
/** 每页条数上限（后端 `pageSize` 是 `clamp(1, 1000)`，这个 48 只是前端的自律） */
const MAX_PAGE_SIZE = 48;
/** 桌面档一页几行 */
const DESKTOP_ROWS = 2;
/** 列数 ≤ 这个数就算窄屏（手机档的 `.allArticles` 是 `repeat(2, 1fr)`，见 index.sass 手机档） */
const NARROW_COLS = 2;
const NARROW_ROWS = 4;

/**
 * 栅格真实列数。两个坑：
 *  1) `auto-fit` 的空轨在 computed value 里序列化成 `0px`，必须过滤掉；
 *  2) 更要命的是折叠会让「列数」变成「已渲染条目数」的函数（首屏 0 条 → 0 列）。
 * 所以测量用的是一个空的探针格（.allArticlesMeasure，带一个 `grid-column: 1/-1` 的单格
 * 阻止折叠），拿到的是**容器**的轨道数，与条目数无关。
 */
const colsOf = (el: HTMLElement | null): number => {
    if (!el) return 0
    return getComputedStyle(el).gridTemplateColumns
        .split(' ')
        .filter(t => t.endsWith('px') && parseFloat(t) > 0).length
}

/**
 * 列数 → 每页条数：桌面满两行、窄屏满四行；越界/量不到时回退固定值。
 * ⚠️ 首屏与 MORE 走的是**同一个函数**（`fetchFirst` 与列数变化回调两处各调一次），
 * 拆成两个条数会让"已渲染条数"与"下一页的偏移"错位（重复/漏项，见 `cachedPageSize` 注释）。
 */
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
    const [currentTop,setCurrentTop] = useState(0);
    // slideDir 当前只被赋值、没人读（轮播方向动画没接上）：保留 setter 以免改动渲染时序
    const [, setSlideDir] = useState<'left' | 'right'>('right');
    // 鼠标悬浮轮播图时暂停自动滚动（移开恢复）
    const [hoverPaused, setHoverPaused] = useState(false);
    // 轮播图滚出视口（如停在文章卡片区）时暂停自动滚动，避免离屏动画触发重绘
    const [topInView, setTopInView] = useState(true);
    const topRef = useRef<HTMLDivElement>(null);
    const heroRef = useRef<HTMLDivElement>(null);

    // 每页条数由栅格列数决定（满两行）。不放进 state：没有任何地方渲染它，
    // 用 ref 供 getMore / 测量回调读最新值（放进 state 反而会多一条「已声明未读取」的 tsc 报错）
    const pageSizeRef = useRef(cachedPageSize);
    // 置顶与文章分页独立刷新，迟到的卸载响应不得回填会话缓存。
    const topGenerationRef = useRef(0);
    const topPendingRef = useRef<Promise<void> | null>(null);
    const [topError, setTopError] = useState(false);
    const measureRef = useRef<HTMLDivElement>(null);
    const location = useLocation();

    const avatar = useSelector((state:{user:UserState}) => state.user.avatar)
    const name = useSelector((state:{user:UserState}) => state.user.name)
    const oneSay = useSelector((state:{user:UserState}) => state.user.talk)
    const navigate = useNavigate()
    const [feed] = useState(() => {
        if (location.state?.fromDashboard) {
            cachedOtherArticles = [];
            cachedTopArticles = [];
            cachedCurrentPage = 1;
            cachedHasMoreArticles = true;
            cachedPageSize = FALLBACK_PAGE_SIZE;
            isCachedOther = false;
            pageSizeRef.current = FALLBACK_PAGE_SIZE;
        }
        return createArticleFeed<NoteType>(async (page, pageSize) => {
            const response = await getNotePage({ page, pageSize });
            return mapRows(requireArticleRows(response));
        }, {
            items: cachedOtherArticles, page: cachedCurrentPage, pageSize: cachedPageSize,
            hasMore: cachedHasMoreArticles, loaded: isCachedOther,
        }, state => {
            cachedOtherArticles = state.items;
            cachedCurrentPage = state.page;
            cachedPageSize = state.pageSize;
            cachedHasMoreArticles = state.hasMore;
            isCachedOther = true;
        });
    });
    const [feedState, setFeedState] = useState(feed.snapshot);
    const { items: otherArticles, page: currentPage, hasMore: hasMoreArticles, loading } = feedState;
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
    const author =  useSelector((state: { user: UserState }) => state.user.name);

    useEffect(() => {
        if(topArticles.length <= 1) return;
        if (hoverPaused || !topInView) return; // 悬浮/移出视口暂停：清除定时器，恢复后再重建
        const timer = setInterval(() => {
            setCurrentTop(prevTop => {
            setSlideDir('right');
            return (prevTop + 1) % topArticles.length;
        });
        }, 5000);
        return () => clearInterval(timer);
    }, [topArticles.length, hoverPaused, topInView])

    useEffect(() => {
        const el = topRef.current;
        if (!el) return;
        const observer = new IntersectionObserver(([entry]) => setTopInView(entry.isIntersecting), { threshold: 0.1 });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const hero = heroRef.current;
        if (!hero) return;
        const video = hero.querySelector('video');
        if (!video) return;
        video.playbackRate = 2.25;
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) {
                video.play().catch(() => {});
            } else {
                video.pause();
            }
        }, { threshold: 0.05 });
        observer.observe(hero);
        return () => observer.disconnect();
    }, []);

    /**
     * 拉第一页并整表替换（首屏 / 列数变化时）。ps 必须是「整页尺寸」：
     * 页偏移 = (page-1)*per_page，之后 More 续翻必须沿用同一个 ps，否则会重复/漏项。
     */
    const fetchFirst = (ps: number, opts?: { silent?: boolean }) => {
        pageSizeRef.current = ps;
        return feed.first(ps, opts?.silent);
    };

    // 首屏：**先测列数再请求**（同一个 effect 内同步读探针）——
    // 否则窄屏/桌面首帧抖动会发出两次请求
    useEffect(() => {
        if (isCachedOther) return;
        fetchFirst(pageSizeFor(colsOf(measureRef.current)));
    }, []);

    // 列数变化（resize 跨断点）→ 防抖 200ms → 只有每页条数真变了才整表重拉
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

    /** 顶部轮播那几条（置顶推荐）。抽成函数是为了让背景重拉复用同一条路径。 */
    const fetchTop = () => {
        if (topPendingRef.current) return topPendingRef.current;
        const generation = ++topGenerationRef.current;
        setTopError(false);
        const promise = getTopNotes().then(res => {
            const mapped = mapRows(requireArticleRows(res));
            if (generation !== topGenerationRef.current) return;
            setTopArticles(mapped);
            setCurrentTop(current => Math.min(current, Math.max(0, mapped.length - 1)));
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

    useLiveRefresh(() => {
        return Promise.all([fetchTop(), fetchFirst(pageSizeRef.current, { silent: true })]).then(() => {});
    }, { poll: false, skip: () => currentPage > 1 || feed.snapshot().pending });
    const handleScrollDown = () => {
        window.scrollTo({
            top: window.innerHeight,
            behavior: 'smooth'
        });
    }
    const getMore = () => feed.more();

    return <>
        <SeoHelmet title={SITE_TITLE} description={SITE_DESCRIPTION} url="/" suffix={false} />
        <div className="SelfDescription" ref={heroRef}>
            <div className="collageBg" aria-hidden="true">
                <span className="blob blobA"/>
                <span className="blob blobB"/>
                <span className="blob blobC"/>
            </div>
            <div className="petals" aria-hidden="true">
                {[0, 1, 2, 3, 4, 5, 6].map((i) => <span key={i} className={`petal p${i + 1}`}/>)}
            </div>

            <div className="SayWords">
                <div className="heroTag">
                    <span className="heroTagStar">✦</span>
                    <span>{author} の 记录室</span>
                </div>
                <h1 className="home-title-h3">Sereno da Saudade</h1>
                <div className="heroTerminal" aria-hidden="true">
                    <span className="termUser">saudade@blog</span>
                    <span className="termSep">:</span>
                    <span className="termPath">~</span>
                    <span className="termSep">$</span>
                    <span className="termCmd">cat ./about.md</span>
                    <span className="termCaret"/>
                </div>
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
                        autoPlay
                        playsInline
                        preload="auto"
                        disablePictureInPicture
                        aria-hidden="true"
                    />
                    <span className="heroPanelTape tapeL"/>
                    <span className="heroPanelTape tapeR"/>
                </figure>

            </div>
            <motion.div
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 1 }}
                className="heroBottom"
            >
                <p className="home-one-say">{oneSay}</p>
                <i className="iconfont icon-rcd-angle-double-down upAndDown heroScroll"
                   onClick={handleScrollDown}/>
            </motion.div>
        </div>
        <div className="ContentContainer dark-pic">
            {topError && <div role="status" className="homeLoadError">
                置顶文章加载失败 <button type="button" onClick={() => { void fetchTop(); }}>重试</button>
            </div>}
            {topArticles.length>0&&<div className="TopArticle" style={{ display: 'flex', position: 'relative' }} ref={topRef}
                onMouseEnter={() => setHoverPaused(true)}
                onMouseLeave={() => setHoverPaused(false)}
            >
                <div className="Top"><span className="TopTape"><i className="iconfont icon-sticky1" aria-hidden="true"></i>置顶</span></div>
                <div style={{ width: '100%', height: '100%', borderRadius: '15px', overflow: 'hidden' }}><div style={{ display: 'flex', width: '100%', height: '100%', transition: 'transform 0.8s cubic-bezier(0.25, 1, 0.5, 1)', transform: `translateX(-${currentTop * 100}%)` }}>
                    {topArticles.map((item) => (
                        <div className="TopArticleInner" key={item.key} onClick={() => navigate(`/article/${item.key}`)} style={{ width: '100%', flexShrink: 0, height: '100%' }}>
                            <div className="TopCover">
                                {resolveApiAssetUrl(item.cover) && (
                                    <img
                                        src={resolveApiAssetUrl(item.cover)}
                                        style={{ width: '100%', height: '100%', objectFit: 'cover', ...coverCropStyle(carouselCropOf(item)) }}
                                    />
                                )}
                            </div>
                            <div className="topContent">
                                <h4># {Categories.find(c => c.categoryKey === Number(item.noteCategory))?.categoryTitle}</h4>
                                <h3 className="contentTitle">{item.noteTitle}</h3>
                                <div className="descSlot">
                                    <div className="ArticleDescription" onMouseLeave={resetDescScroll}> {item.description}</div>
                                </div>
                                <div className='tags' style={{ width: '100%', marginTop: '10px' }}>
                                    {renderNoteTags(item.noteTags, tagList, item.noteTagRefs)}
                                </div>
                                <div className="topFooter" style={{ display: 'flex', alignItems: 'center', paddingBottom: '20px' }}>
                                    <NoteByline item={item} siteAvatar={avatar} siteName={name} />
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
                </div>
                
                <div className="topDotsContainer">
                    {topArticles.map((item,index) => <div className={`topDot ${currentTop===index&&'dotCurrent'}`} key={item.key} onMouseEnter={() => {
                        if (index > currentTop) setSlideDir('right');
                        else if (index < currentTop) setSlideDir('left');
                        setCurrentTop(index);
                    }}></div>)}
                </div>
            </div>}


            <div style={{width:'80%', display: 'flex', marginBottom: '20px'}}>
                <div className='allContent'><i className="iconfont icon-wenzhang2" aria-hidden="true"></i>文章</div>
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
            {loading ? (
                <div className="loadingio-spinner-spinner-69tfms83mg9">
                    <div className="ldio-se504dvlmh">
                        <div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div>
                    </div>
                </div>
            ) : (
                <div>
                    {feedState.loaded && !feedState.error && hasMoreArticles ? (
                        <button type="button" className='allContent more' disabled={feedState.pending} onClick={() => { void getMore(); }}>More</button>
                    ) : null}
                </div>
            )}
        </div>
    </>
}

export default ContentHome
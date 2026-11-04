import './index.sass'
import {useEffect, useState, useRef} from "react";
import {useParams} from "react-router-dom";
import {NoteType} from "../../../interface/NoteType";
import { motion } from 'framer-motion';
import {Avatar, Flex, message} from "antd";
import {useSelector} from "react-redux";
import UserState from "../../../interface/UserState";
import dayjs from "dayjs";
import MarkdownNavbarDefault from 'markdown-navbar'
import 'markdown-navbar/dist/navbar.css'
import { cjsDefault } from "../../../utils/cjsDefault";
import Loading from "../../Loading";
import scrollToTop from "../../../utils/scrollToTop.tsx";
import { noteAuthor } from "../../../utils/noteAuthor";
import { coverCropMotionStyle, cropFromRow } from "../../../utils/coverCrop";
import { resolveApiAssetUrl } from "../../../utils/runtimeApi";
import { useIsDarkMode } from "../../../theme";
import readDayVideo from '../../../assets/read_day.mp4';
import readNightVideo from '../../../assets/read_night.mp4';
import {getNoteById} from "../../../apis/NoteMethods.tsx";
import {getNoteStats, likeNote, reportNoteView, unlikeNote} from "../../../apis/NoteStatsMethods.tsx";
import {CommentIcon, EyeIcon, HeartIcon, HeartOutlineIcon, StarIcon, StarOutlineIcon} from "../../../components/NoteStatIcons/index.tsx";
import type {NoteStats} from "../../../interface/NoteStatsType";
import SeoHelmet from "../../../components/SeoHelmet";
import getToken from "../../../apis/getToken.tsx";
import {addFavorite, errMsg, ok, removeFavorite} from "../../../apis/ProfileMethods.tsx";
import { applyLocalFavorite, useFavorites } from "../../../components/UserCenter/favorites.ts";
import {useLiveRefresh} from "../../../utils/liveRefresh.ts";
import CommentSection from "../../../components/CommentSection";
import {createRequestScope} from "../../../utils/requestScope";

// ByteMD imports
import { Viewer } from '@bytemd/react'
import gfm from '@bytemd/plugin-gfm'
import breaks from "@bytemd/plugin-breaks";
import frontmatter from "@bytemd/plugin-frontmatter";
import gemoji from "@bytemd/plugin-gemoji";
import highlight from "@bytemd/plugin-highlight";
import mermaid from '@bytemd/plugin-mermaid'
import { MERMAID_CONFIG } from '../../../utils/mermaidTheme'
import math from "@bytemd/plugin-math";
import { initZoomDelegation } from "./zoomOverlay";
import { decorateCodeBlocks } from "../../../utils/chatMarkdown";
import { bytemdStickers } from "../../../utils/stickers";
import 'bytemd/dist/index.css'
import 'github-markdown-css/github-markdown-light.css'
import 'highlight.js/styles/atom-one-dark.css' // Import Highlight.js styles
import 'katex/dist/katex.css' // KaTeX 公式样式（与编辑器一致，公式在外部展示页正常渲染）

const READ_LOG_KEY = 'saudaReadLog';

const readLog = (): Record<string, string> => {
    try {
        const o = JSON.parse(localStorage.getItem(READ_LOG_KEY) || 'null');
        return o && typeof o === 'object' ? o : {};
    } catch {
        // 脏值（手工改过、别的版本写的）当"没记过"处理，不炸页面
        return {};
    }
};

const todayStr = () => dayjs().format('YYYY-MM-DD');

/** 今天是不是第一次读这篇。**是则当场记账**，调用方负责在请求失败时还回来 */
const claimTodayRead = (noteId: string): boolean => {
    const today = todayStr();
    const log = readLog();
    if (log[noteId] === today) return false;
    log[noteId] = today;
    try {
        localStorage.setItem(READ_LOG_KEY, JSON.stringify(log));
    } catch { /* 隐私模式 / 配额满：退化成"每次都上报"，不影响正文 */ }
    return true;
};

/** 上报失败 ⇒ 把今天的记账还回去（只还今天这一条，别的日期不动），下次还有机会记上 */
const releaseTodayRead = (noteId: string) => {
    const log = readLog();
    if (log[noteId] !== todayStr()) return;
    delete log[noteId];
    try {
        localStorage.setItem(READ_LOG_KEY, JSON.stringify(log));
    } catch { /* 同上：存不进去也无所谓，最坏是这一天不再上报 */ }
};

// markdown-navbar 是 CJS 包，Vite 8 之后默认 import 拿到的可能是名字空间对象而不是组件
// （整个 `Element type is invalid … got: object` 就是这么来的，判据与三种形态见
//  utils/cjsDefault.ts 的头注）。**不要改回 `import MarkdownNavbar from …`。**
const MarkdownNavbar = cjsDefault(MarkdownNavbarDefault)

const plugins = [
    gfm({ singleTilde: false }),
    breaks(),
    frontmatter(),
    gemoji(),
    highlight(),
    // 配色走 utils/mermaidTheme.ts 那一份（看板娘对话框用同一份，见 chatMarkdown.ts）
    mermaid(MERMAID_CONFIG),
    math(),
    bytemdStickers
]

const ArticleResource = ({id}: {id: string}) => {
    const avatar = useSelector((state:{user:UserState}) => state.user.avatar)
    const name = useSelector((state:{user:UserState}) => state.user.name)
    const scope = useRef(createRequestScope()).current
    const likeLock = useRef(false)
    const favoriteLock = useRef(false)
    const [loadError, setLoadError] = useState(false)
    const [isLoading, setLoading] = useState(true)
    const [article, setArticle] = useState<NoteType|null>(null)
    const [notFound, setNotFound] = useState(false)
    const [favBusy, setFavBusy] = useState(false)
    const loggedIn = !!getToken()
    const { has: hasFaved } = useFavorites(loggedIn)
    const faved = loggedIn && hasFaved(id)

    const who = noteAuthor(article, { name, avatar })

    const [views, setViews] = useState<number | null>(null)
    const [likes, setLikes] = useState<number | null>(null)
    const [comments, setComments] = useState<number | null>(null)
    const [liked, setLiked] = useState(false)
    const [likeBusy, setLikeBusy] = useState(false)
    // 本 id 的统计是否已经拿到过。用于区分"今天第一次读"（要上报 +1）与
    // "今天已经记过"（只读回当前值）——后者在 useLiveRefresh 每次聚焦时都会走，
    // 没有这道闸就会变成每次聚焦都发一次 GET。
    const statsLoadedRef = useRef(false)

    /** 一次性吃下统计三件套（stats 与 view 上报返回的是同一个形状） */
    const applyStats = (s: NoteStats) => {
        statsLoadedRef.current = true
        setViews(s.views)
        setLikes(s.likes)
        setComments(s.comments ?? null)
        setLiked(!!s.liked)
    }

    const isDarkMode = useIsDarkMode()
    // 视频开始播放后 poster 层淡出；换源先复位（见下面的 effect）
    const [videoReady, setVideoReady] = useState(false)
    // 素材加载失败 → 永久停用视频层，退回封面图（占位期/未上传素材时不至于空白）
    const [videoFailed, setVideoFailed] = useState(false)
    const coverRef = useRef<HTMLDivElement>(null)
    const coverVideoRef = useRef<HTMLVideoElement>(null)
    // 访客要求减少动效时不放视频（无障碍 / 省电）
    const prefersReducedMotion = typeof window !== 'undefined'
        && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const videoEnabled = !prefersReducedMotion && !videoFailed

    // Lock ref to prevent TOC auto-scroll during manual click
    const isClickingTocRef = useRef(false);

    /** 拉这篇正文。`silent` = 背景重拉（跨端同步）：**不切加载屏**——详情页的
     *  `isLoading` 会把整篇文章换成一个加载页，读者正读着的时候为了一次后台核对闪一下
     *  是最坏的观感（同后台那几页"背景重拉不亮 loading"的纪律）。
     *  404 照常走 `notFound`（两种模式都一样）：文章真被删了就该说它没了——
     *  静默留着旧正文才是撒谎。 */
    const loadArticle = (opts?: { silent?: boolean }) => {
        if (!id) return;
        // 非背景那一次：整篇换成加载页，并抹掉上一次的 404（不抹的话从死链跳到活文章
        // 会先闪一下"文章不存在"——渲染顺序是 notFound 优先于 isLoading）
        if (!opts?.silent) { setLoading(true); setNotFound(false); }
        setLoadError(false);
        return scope.run('body', signal => getNoteById(id, signal), {
            success: (res) => {
                if (!ok(res) || !res.data.data) throw new Error(errMsg(res));
                setArticle({ ...res.data.data });
                setNotFound(false);
                reportReadOnce(id);
            },
            error: (err) => {
                if ((err as {response?: {status?: number}})?.response?.status === 404) {
                    setNotFound(true);
                    setArticle(null);
                } else {
                    setLoadError(true);
                }
            },
            // A foreground load may be superseded by a live refresh: the latest
            // body response owns the spinner regardless of how it was triggered.
            settled: () => setLoading(false),
        });
    };

    /** 今天第一次读这篇 ⇒ 上报 +1；已经记过 ⇒ 只读回当前值（不发 +1）。
     *  上报失败**静默**：它是个副作用，把读者的正文页面换成一句"上报失败"是本末倒置。
     *  `statsLoadedRef` 只挡住同一个 id 上的重复 GET；换 id 时由下面的 effect 复位。 */
    const reportReadOnce = (noteId: string) => {
        // A pending pre-like stats snapshot must never overwrite the like result.
        if (likeLock.current) return;
        if (!claimTodayRead(noteId)) {
            if (statsLoadedRef.current) return;
            const token = scope.begin('stats');
            getNoteStats(noteId, token.signal).then((res) => {
                if (token.current() && ok(res)) applyStats(res.data.data);
            }).catch(() => { /* 读不到就不显示，见上面 views 的注释 */ });
            return;
        }
        const token = scope.begin('stats');
        reportNoteView(noteId).then((res) => {
            if (!ok(res)) releaseTodayRead(noteId);
            else if (token.current()) applyStats(res.data.data);
        }).catch(() => releaseTodayRead(noteId));
    };

    const toggleLike = async () => {
        if (!id || likeLock.current) return
        likeLock.current = true
        const token = scope.begin('like')
        scope.cancel('stats')
        setLikeBusy(true)
        try {
            const res = liked ? await unlikeNote(id) : await likeNote(id)
            if (!token.current()) return
            if (ok(res)) {
                // 后端回的是权威值（计数与状态一起回来）⇒ 照抄，不在前端 ±1
                // （前端自增在"另一处刚点过/被取消"时会算错，且重复请求会漂）
                setLikes(res.data.data.likes)
                setLiked(!!res.data.data.liked)
                statsLoadedRef.current = true
                // The initial stats read was invalidated before this mutation.
                // Recover views/comments from a snapshot requested after the write.
                const statsToken = scope.begin('stats')
                getNoteStats(id, statsToken.signal).then(result => {
                    if (statsToken.current() && ok(result)) applyStats(result.data.data)
                }).catch(() => {})
            } else {
                message.error(errMsg(res))
            }
        } catch {
            if (token.current()) message.error('网络异常，请稍后再试')
        } finally {
            if (token.current()) { likeLock.current = false; setLikeBusy(false) }
        }
    }

    useEffect(() => {
        scope.activate();
        // A keyed resource starts with independent state; StrictMode may replay
        // this effect, so reset its read cache before starting the new request.
        setViews(null)
        setLikes(null)
        setComments(null)
        setLiked(false)
        statsLoadedRef.current = false
        loadArticle();
        scrollToTop();
        return () => scope.dispose();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    useLiveRefresh(() => loadArticle({ silent: true }), { poll: false });
    
    const toggleFavorite = async () => {
        if (!id || favoriteLock.current) return
        if (!getToken()) {
            message.warning('登录后才能收藏')
            return
        }
        const accountToken = getToken()
        favoriteLock.current = true
        const token = scope.begin('favorite')
        setFavBusy(true)
        try {
            const res = faved ? await removeFavorite(Number(id)) : await addFavorite(Number(id))
            if (!token.current() || getToken() !== accountToken) return
            if (ok(res)) {
                // 写入成功 ⇒ 把结果交给共享状态（它顺手拉一次全量对齐：个人中心那份列表
                // 与这里的★立刻是同一个事实）。**不在这里改本地 boolean**——两份状态正是
                // 这轮要修的洞（见 favorites.ts 头注）。
                applyLocalFavorite(Number(id), !faved)
                message.success(faved ? '已取消收藏' : '已收藏（可在「设置 → 收藏的文章」里查看）')
            } else {
                message.error(errMsg(res))
            }
        } catch {
            if (token.current() && getToken() === accountToken) message.error('网络异常，请稍后再试')
        } finally {
            if (token.current()) { favoriteLock.current = false; setFavBusy(false) }
        }
    }

    const content = article?.noteContent || '';

    // 换源（切主题）→ 新 video 还在加载：先让 poster 层回来，等 onPlaying 再淡出
    useEffect(() => {
        setVideoReady(false)
    }, [isDarkMode])

    // 离屏暂停（抄首页 hero 的写法）：详情页一往下滚横幅就出视口，
    // 不停会白烧 CPU/流量（视频解码是持续成本）
    useEffect(() => {
        const cover = coverRef.current
        const video = coverVideoRef.current
        if (!cover || !video) return
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) {
                video.play().catch(() => {})
            } else {
                video.pause()
            }
        }, { threshold: 0.05 })
        observer.observe(cover)
        return () => observer.disconnect()
    }, [videoEnabled, isDarkMode])

    // Effect: mermaid 图 + 正文图片单击放大(委托,兼容 mermaid 异步渲染)
    useEffect(() => {
        if (isLoading) return;
        const content = document.getElementById("content");
        if (!content) return;
        return initZoomDelegation(content);
    }, [isLoading]);

    useEffect(() => {
        if (isLoading) return;
        const content = document.getElementById("content");
        if (!content) return;
        decorateCodeBlocks(content);
        // 只插入了标签栏自身（无删除）的变更 → 忽略,避免自己触发自己
        const onlyOwnHeads = (m: MutationRecord) =>
            m.addedNodes.length > 0 && m.removedNodes.length === 0
            && Array.from(m.addedNodes).every(
                (n) => n instanceof HTMLElement && n.classList.contains('code-block-head'));
        const observer = new MutationObserver((muts) => {
            if (muts.every(onlyOwnHeads)) return;
            decorateCodeBlocks(content);
        });
        observer.observe(content, { childList: true, subtree: true });
        return () => observer.disconnect();
    }, [isLoading, content]);

    // Effect to handle link clicks by delegation (Open in new tab), cleanup duplicate effects
    useEffect(() => {
        const handleGlobalClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            // Check if click happened inside markdown-body
            const markdownContainer = target.closest('.markdown-body');
            if (!markdownContainer) return;

            const link = target.closest('a');
            if (link &&  markdownContainer.contains(link)) {
                const href = link.getAttribute('href');
                if (href && !href.startsWith('#')) {
                    e.preventDefault();
                    window.open(href, '_blank', 'noopener,noreferrer');
                }
            }
        };

        // Bind to document to catch dynamically added content
        document.addEventListener('click', handleGlobalClick);

        return () => {
            document.removeEventListener('click', handleGlobalClick);
        };
    }, []);

    // Effect for TOC auto-scroll
    useEffect(() => {
        if (isLoading) return;
        let rafId = 0;
        let lastHash = window.location.hash;
        const onScroll = () => {
            cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
                const headings = document.querySelectorAll<HTMLElement>(
                    '#content h1, #content h2, #content h3, #content h4, #content h5, #content h6'
                );
                // 最后一个"已滚过 headingTopOffset(100)"的标题 = 当前段落
                let cur: HTMLElement | null = null;
                for (const h of headings) {
                    if (h.getBoundingClientRect().top <= 100) cur = h;
                    else break;
                }
                const text = (cur?.innerText || '').trim();
                const id = text ? text.replace(/[#?&=%/\s]+/g, '-').replace(/-{2,}/g, '-') : '';
                if (id && lastHash !== '#' + id) {
                    lastHash = '#' + id;
                    history.replaceState(null, '', location.pathname + location.search + '#' + id);
                }
            });
        };
        document.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            cancelAnimationFrame(rafId);
            document.removeEventListener('scroll', onScroll);
        };
    }, [isLoading]);

    // Effect for TOC auto-scroll
    useEffect(() => {
        if (isLoading) return;
        
        // Add click listener to TOC container to detect manual interaction
        const handleTocClick = () => {
            isClickingTocRef.current = true;
            // Unlock after animation/scroll finishes (approx 1s safe buffer)
            setTimeout(() => {
                isClickingTocRef.current = false;
            }, 1000);
        };

        let observer: MutationObserver | null = null;
        let navContainerRef: Element | null = null;

        const intervalId = setInterval(() => {
            const navContainer = document.querySelector('.markdown-navigation');
            
            if (navContainer) {
                clearInterval(intervalId);
                navContainerRef = navContainer;
                
                // Add click listener
                navContainer.addEventListener('mousedown', handleTocClick);
                navContainer.addEventListener('click', handleTocClick);

                observer = new MutationObserver((mutations) => {
                    // Specific check: if user is manually clicking TOC, do not auto-scroll sidebar
                    if (isClickingTocRef.current) return;

                    let targetElement: HTMLElement | null = null;

                    for (const mutation of mutations) {
                        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                            const target = mutation.target as HTMLElement;
                            if (target.classList.contains('active')) {
                                targetElement = target;
                                break;
                            }
                        } else if (mutation.type === 'childList') {
                            const active = navContainer.querySelector('.active') as HTMLElement;
                            if (active) {
                                targetElement = active;
                                break;
                            }
                        }
                    }

                    if (targetElement && navContainer) {
                        const containerRect = navContainer.getBoundingClientRect();
                        const elementRect = targetElement.getBoundingClientRect();
                        const relativeTop = elementRect.top - containerRect.top + navContainer.scrollTop;
                        navContainer.scrollTo({
                            top: relativeTop - 20,
                            behavior: 'instant'
                        });
                    }
                });

                observer.observe(navContainer, { 
                    attributes: true, 
                    childList: true, 
                    subtree: true, 
                    attributeFilter: ['class'] 
                });
                
                const initialActive = navContainer.querySelector('.active') as HTMLElement;
                if (initialActive && navContainer) {
                    const containerRect = navContainer.getBoundingClientRect();
                    const elementRect = initialActive.getBoundingClientRect();
                    const relativeTop = elementRect.top - containerRect.top + navContainer.scrollTop;
                    navContainer.scrollTo({
                        top: relativeTop - 20,
                        behavior: 'smooth'
                    });
                }
            }
        }, 200);

        return () => {
            clearInterval(intervalId);
            if (observer) observer.disconnect();
            if (navContainerRef) {
                navContainerRef.removeEventListener('mousedown', handleTocClick);
                navContainerRef.removeEventListener('click', handleTocClick);
            }
        };
    }, [isLoading, content]);

    return (
        <div className='readContainer'>
            <SeoHelmet title={notFound ? '文章不存在' : (article ? article.noteTitle : '文章加载中')} description={article?.description || undefined} image={article?.cover || undefined} url={`/article/${id}`} type="article" />
            {notFound ? (
                <div style={{width:'100vw',height:'100vh',display:'flex',flexDirection:'column',justifyContent:'center',alignItems:'center',gap:16}}>
                    <h1 style={{fontSize:28}}>文章不存在或已删除</h1>
                    <p style={{opacity:0.6}}>你访问的文章 <code>/article/{id}</code> 未找到——可能是链接有误，或文章已下架。</p>
                    <a href="/" style={{color:'#aec8c8'}}>← 返回首页</a>
                </div>
            ) : loadError && !article ? (
                <div role="alert" style={{padding: '25vh 24px', textAlign: 'center'}}>
                    <p>文章加载失败，请稍后重试</p>
                    <button type="button" onClick={() => loadArticle()}>重新加载</button>
                </div>
            ) : isLoading ? (
                <div style={{width:'100vw',height:'100vh',display:'flex',justifyContent:'center',alignItems:'center'}}>
                    <Loading />
                </div>
            ) : (
                <>
                    {loadError && <p role="alert">文章同步失败，当前显示上次加载的内容。<button type="button" onClick={() => loadArticle({silent: true})}>重试</button></p>}
                    <div className="readCover" ref={coverRef}>
                        {article?.cover ? (
                            <motion.img
                                className={`readCoverPoster${videoReady ? ' isHidden' : ''}`}
                                src={resolveApiAssetUrl(article.cover)}
                                style={coverCropMotionStyle(cropFromRow(article))}
                                initial={{ filter: "blur(10px)" }}
                                animate={{ filter: "blur(0px)" }}
                                transition={{ duration: 1 }}
                            />
                        ) : (
                            <div className="readCoverPoster readCoverFallback" aria-hidden="true" />
                        )}
                        {videoEnabled && (
                            <video
                                key={isDarkMode ? 'night' : 'day'}
                                ref={coverVideoRef}
                                className="readCoverVideo"
                                src={isDarkMode ? readNightVideo : readDayVideo}
                                muted
                                loop
                                autoPlay
                                playsInline
                                preload="metadata"
                                disablePictureInPicture
                                aria-hidden="true"
                                onPlaying={() => setVideoReady(true)}
                                onError={() => setVideoFailed(true)}
                            />
                        )}
                        <motion.div
                            initial={{ opacity: 0, x: -30 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ duration: 1 }}
                        >
                            <div className="readInfo">
                                <div className="readAuthor">
                                    <Flex gap={"small"} align={"center"} className="readAuthorRow">
                                        <Avatar src={who.avatar} size={40} className="frontAvatar" />
                                        <span className="readAuthorName">{who.name}</span>
                                    </Flex>
                                    <div className="readTimes">
                                        <span>发布于 {dayjs(article?.createTime).format("YYYY-MM-DD")}</span>
                                        <span>更新于 {dayjs(article?.updateTime).format("YYYY-MM-DD")}</span>
                                    </div>
                                </div>
                                <div className="readMain">
                                    <h1>{article?.noteTitle}</h1>
                                </div>
                                <div className="readStats">
                                    <button
                                        type="button"
                                        className={`readStat readFavBtn${faved ? ' isFaved' : ''}`}
                                        disabled={favBusy}
                                        title={faved ? '取消收藏' : '收藏'}
                                        onClick={toggleFavorite}
                                    >
                                        {faved
                                            ? <StarIcon size={14} />
                                            : <StarOutlineIcon size={14} />}
                                        <span className="readFavLabel">{faved ? '已收藏' : '收藏'}</span>
                                    </button>
                                    {views !== null && (
                                        <span className="readStat readViews" title="累计阅读量">
                                            <EyeIcon size={14} />
                                            <span className="readViewsNum">{views}</span>
                                        </span>
                                    )}
                                    <button
                                        type="button"
                                        className={`readStat readLikeBtn${liked ? ' isLiked' : ''}`}
                                        disabled={likeBusy}
                                        aria-pressed={liked}
                                        title={liked ? '取消点赞' : '点赞'}
                                        onClick={toggleLike}
                                    >
                                        {liked ? <HeartIcon size={14} /> : <HeartOutlineIcon size={14} />}
                                        {likes !== null && <span className="readLikeNum">{likes}</span>}
                                    </button>
                                    {comments !== null && (
                                        <span className="readStat readComments" title="讨论数">
                                            <CommentIcon size={14} />
                                            <span className="readCommentNum">{comments}</span>
                                        </span>
                                    )}
                                </div>
                                <motion.div
                                    initial={{ scaleX: 0 }}
                                    animate={{ scaleX: 1 }}
                                    transition={{ duration: 1, delay: 0.5 }}
                                    style={{
                                        position:'absolute',
                                        bottom: -20,
                                        width: "100%",
                                        height: "2px",
                                        background: "#aec8c8",
                                        marginTop: "10px",
                                        transformOrigin: "left",
                                    }}
                                />
                            </div>
                        </motion.div>
                    </div>
                    <div className='readDescription'>
                        <span style={{color:'rgb(9,10,21)',fontSize:15,fontWeight:600,marginRight:10}}>内容概述:</span>
                        <p>{article?.description}</p>
                    </div>
                    <div className='readContent markdown-body'>
                        <motion.div
                            className='readBody'
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 1 }}
                        >
                            <div id="content" className="markdown-body">
                                <Viewer 
                                    value={content}
                                    plugins={plugins}
                                />
                            </div>
                        </motion.div>
                        <div className="navigation" id='toc'>
                             <MarkdownNavbar
                                source={content}
                                ordered={false}
                                headingTopOffset={100}
                                updateHashAuto={false}
                             />
                        </div>
                    </div>
                    <CommentSection noteId={id} />
                </>
            )}
        </div>
    )
}

// React Router reuses the route element on parameter changes. A keyed resource
// isolates state immediately, including A → B → A before the first A settles.
const ReadArticle = () => {
    const {id = ''} = useParams()
    return <ArticleResource key={id} id={id} />
}

export default ReadArticle

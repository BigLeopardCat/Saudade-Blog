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
        // Corrupt local read state must not block the article.
        return {};
    }
};

const todayStr = () => dayjs().format('YYYY-MM-DD');

/** Claim one daily view; release the claim if reporting fails. */
const claimTodayRead = (noteId: string): boolean => {
    const today = todayStr();
    const log = readLog();
    if (log[noteId] === today) return false;
    log[noteId] = today;
    try {
        localStorage.setItem(READ_LOG_KEY, JSON.stringify(log));
    } catch { /* Local persistence is optional. */ }
    return true;
};

/** Release only today's claim so a failed view report can be retried. */
const releaseTodayRead = (noteId: string) => {
    const log = readLog();
    if (log[noteId] !== todayStr()) return;
    delete log[noteId];
    try {
        localStorage.setItem(READ_LOG_KEY, JSON.stringify(log));
    } catch { /* Local persistence is optional. */ }
};

// Normalize the CJS namespace before rendering it as a React component.
const MarkdownNavbar = cjsDefault(MarkdownNavbarDefault)

const plugins = [
    gfm({ singleTilde: false }),
    breaks(),
    frontmatter(),
    gemoji(),
    highlight(),
    // The article and chat renderer share Mermaid configuration.
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
    // Reuse the current article's stats during background refreshes.
    const statsLoadedRef = useRef(false)

    /** Stats reads and view reports share the same verified snapshot. */
    const applyStats = (s: NoteStats) => {
        statsLoadedRef.current = true
        setViews(s.views)
        setLikes(s.likes)
        setComments(s.comments ?? null)
        setLiked(!!s.liked)
    }

    const coverSource = resolveApiAssetUrl(article?.cover || '')
    const [failedCover, setFailedCover] = useState<string | null>(null)

    // Lock ref to prevent TOC auto-scroll during manual click
    const isClickingTocRef = useRef(false);

    // Background refreshes retain the article; a verified 404 still removes it.
    const loadArticle = (opts?: { silent?: boolean }) => {
        if (!id) return;
        // A foreground request owns the initial loading and not-found state.
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

    // Report each daily view once. Stats failures never hide the article.
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
                // Counts and current-user state come from the same backend receipt.
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
                // Favorites are shared with the personal center, not duplicated locally.
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

    // Delegate links so asynchronously rendered Markdown is covered.
    useEffect(() => {
        const handleGlobalClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
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
            <SeoHelmet title={notFound ? '文章不存在' : (article ? article.noteTitle : '文章加载中')} description={article?.description || undefined} image={article?.cover || undefined} url={`/article/${id}`} type="article" noindex={notFound} />
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
                    <div className="readCover">
                        {coverSource && coverSource !== failedCover ? (
                            <motion.img
                                key={coverSource}
                                className="readCoverPoster"
                                src={coverSource}
                                alt=""
                                aria-hidden="true"
                                onError={() => setFailedCover(coverSource)}
                                style={coverCropMotionStyle(cropFromRow(article))}
                                initial={{ filter: "blur(10px)" }}
                                animate={{ filter: "blur(0px)" }}
                                transition={{ duration: 1 }}
                            />
                        ) : (
                            <div className="readCoverPoster readCoverFallback" aria-hidden="true" />
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

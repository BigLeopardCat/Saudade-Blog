import './index.sass'
import {useEffect, useState, useRef} from "react";
import {useParams} from "react-router-dom";
import {NoteType} from "../../../interface/NoteType";
import { motion } from 'framer-motion';
import {Avatar, Flex, message} from "antd";
import {useSelector} from "react-redux";
import UserState from "../../../interface/UserState";
import dayjs from "dayjs";
import MarkdownNavbar from 'markdown-navbar'
import 'markdown-navbar/dist/navbar.css'
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

// ByteMD imports
import { Viewer } from '@bytemd/react'
import gfm from '@bytemd/plugin-gfm'
import breaks from "@bytemd/plugin-breaks";
import frontmatter from "@bytemd/plugin-frontmatter";
import gemoji from "@bytemd/plugin-gemoji";
import highlight from "@bytemd/plugin-highlight";
import mermaid from '@bytemd/plugin-mermaid'
import math from "@bytemd/plugin-math";
import { initZoomDelegation } from "./zoomOverlay";
import { decorateCodeBlocks } from "../../../utils/chatMarkdown";
import { bytemdStickers } from "../../../utils/stickers";
import 'bytemd/dist/index.css'
import 'github-markdown-css/github-markdown-light.css'
import 'highlight.js/styles/atom-one-dark.css' // Import Highlight.js styles
import 'katex/dist/katex.css' // KaTeX 公式样式（与编辑器一致，公式在外部展示页正常渲染）

/**
 * 阅读上报去重（20260930）：同一访客同一篇**一天只上报一次**。
 *
 * 为什么去重在前端：访客没有 uid，服务端没有身份可辨（因此 `POST .../view` 是
 * 无脑 +1，谁都能刷——它统计的是"页面被打开的次数"，不是"多少个人读过"）。
 *
 * 三处写法都是有意的：
 * · 日期用 `dayjs().format('YYYY-MM-DD')`，**不是 `toISOString().slice(0,10)`**——
 *   后者是 UTC，北京 00:00–08:00 会与后端的 `Local::now().date_naive()` 差一天，
 *   于是同一天被记两次、或跨零点那次被误判成"今天已记"而不记。
 * · 标记**在请求之前同步写**（乐观写，失败由 `releaseTodayRead` 抹回）：StrictMode
 *   双跑 effect / 快速重挂会在"检查—await"这个窗口里发出两次请求。
 * · **一个键装一张 map**，不是 `read_<id>_<date>`——后者每天每篇堆一个键、永久累积。
 *   命名空间前缀与既有的 `tokenKey` / `isDarkMode` 对齐。
 */
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

const plugins = [
    gfm({ singleTilde: false }),
    breaks(),
    frontmatter(),
    gemoji(),
    highlight(),
    mermaid(),
    math(),
    bytemdStickers
]

const ReadArticle = () => {
    const avatar = useSelector((state:{user:UserState}) => state.user.avatar)
    const name = useSelector((state:{user:UserState}) => state.user.name)
    const {id} = useParams()
    const [isLoading, setLoading] = useState(true)
    const [article, setArticle] = useState<NoteType|null>(null)
    // 20260901：文章不存在（404）标记——agent 幻觉链接/死链直达时渲染
    // "文章不存在"提示，不再渲染空壳页（此前 fetch 失败只 console.error，
    // article=null → 空封面+空正文的假页面，用户误以为"能打开"）
    const [notFound, setNotFound] = useState(false)
    // 收藏（20260922 个人中心一期；20260923 三轮改成共享状态）：本站此前没有任何收藏入口。
    // 没有"这篇有没有被收藏"的单篇接口 ⇒ 拿整个收藏列表来比对（收藏是低频动作、列表很短，
    // 不值得为它加端点）。**列表不再存在本组件的 state 里**：个人中心的收藏页签看的是同一份
    // store，谁改了另一处都会跟着变（此前各存一份，两边互不同步，见 favorites.ts 头注）。
    const [favBusy, setFavBusy] = useState(false)
    const loggedIn = !!getToken()
    const { has: hasFaved } = useFavorites(loggedIn)
    const faved = loggedIn && hasFaved(id)

    // 横幅信息卡里的那个头像与名字**属于这篇文章**，不是站点主人的（20261001）。
    // 改造前这里直接渲染 redux 的 `avatar`/`name`（站点级那一份），于是"管理员发的文章
    // 顶着超级管理员的头像"——判据只有一份，见 `utils/noteAuthor.ts`。传进去的
    // `avatar`/`name` 是**兜底**：文章没有作者记录（老文章）时才用它们。
    const who = noteAuthor(article, { name, avatar })

    // 阅读量 / 点赞量（20260930）。三个状态**各自可为空**、互不牵连：
    //   · `views === null` = 还没读到（或读失败）⇒ **整块不显示**，绝不显示 0
    //     （仓内纪律：读不到 ≠ 空，见 components/UserCenter/favorites.ts 头注）；
    //   · `likes === null` 同理，但**点赞按钮照常渲染**——没读到计数不该妨碍点赞，
    //     点下去后端会回一份权威的 {likes, liked}。
    const [views, setViews] = useState<number | null>(null)
    const [likes, setLikes] = useState<number | null>(null)
    // 讨论数（20261003，用户第 5 条里的第四件）。与 `views` 同一档：`null` = 还没读到
    // 或读失败 ⇒ **整格不渲染**，绝不显示 0（"读不到 ≠ 0"）。
    // ⚠️ 它与下面讨论区列表里那个 `items.length` 是**两个来源**：这里走统计接口的
    // `comments` 字段（服务端 `approved = 1 AND is_deleted = 0` 的口径），讨论区那个是
    // 前端当前拉到的列表长度。两者口径刻意相同 ⇒ 正常情况下**数值必然相等**；不等时
    // 是"统计还没回来"或"讨论区刚刷新"，以讨论区为准即可，不需要在这里做同步。
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

    // 顶部横幅的日夜背景视频（20260912）
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
        return getNoteById(id).then((res) => {
            setArticle({ ...res.data.data });
            setNotFound(false);
            // 上报阅读量**只挂在这个成功分支里**：那正是"这篇文章真的存在且可见"的
            // 唯一位置。放在别处（例如进页面就发）会让 `/article/17` 这类幻觉/死链
            // 也在库里留下幽灵行。404 分支因此结构上不可能上报。
            reportReadOnce(id);
        }).catch((err) => {
            console.error('获取失败', err)
            if (err?.response?.status === 404) {
                setNotFound(true)
                setArticle(null)
            }
        }).finally(() => {
            if (!opts?.silent) setLoading(false)
        });
    };

    /** 今天第一次读这篇 ⇒ 上报 +1；已经记过 ⇒ 只读回当前值（不发 +1）。
     *  上报失败**静默**：它是个副作用，把读者的正文页面换成一句"上报失败"是本末倒置。
     *  `statsLoadedRef` 只挡住同一个 id 上的重复 GET；换 id 时由下面的 effect 复位。 */
    const reportReadOnce = (noteId: string) => {
        if (!claimTodayRead(noteId)) {
            if (statsLoadedRef.current) return;
            getNoteStats(noteId).then((res) => {
                if (ok(res)) applyStats(res.data.data);
            }).catch(() => { /* 读不到就不显示，见上面 views 的注释 */ });
            return;
        }
        reportNoteView(noteId).then((res) => {
            if (ok(res)) applyStats(res.data.data);
            else releaseTodayRead(noteId);
        }).catch(() => releaseTodayRead(noteId));
    };

    // 点赞**不再要求登录**（20261001 用户第 2 条）。未登录时由 `utils/visitorKey.ts`
    // 生成的本机标识充当身份，服务端按它去重与判 `liked`；两者都没有才回「未登录」
    // （正常浏览器永远有标识，那条只对直接 curl 的人可见）。
    // 所以这里**刻意没有 `if (!getToken())` 那一道**——加回去就等于把功能关掉了。
    const toggleLike = async () => {
        if (!id) return
        setLikeBusy(true)
        try {
            const res = liked ? await unlikeNote(id) : await likeNote(id)
            if (ok(res)) {
                // 后端回的是权威值（计数与状态一起回来）⇒ 照抄，不在前端 ±1
                // （前端自增在"另一处刚点过/被取消"时会算错，且重复请求会漂）
                setLikes(res.data.data.likes)
                setLiked(!!res.data.data.liked)
                statsLoadedRef.current = true
            } else {
                message.error(errMsg(res))
            }
        } catch (e) {
            message.error('网络异常，请稍后再试')
        } finally {
            setLikeBusy(false)
        }
    }

    useEffect(() => {
        // 换文章（/article/A → /article/B）时本组件不重挂，统计必须跟着归零：
        // 不归零的话 B 会先顶着 A 的阅读量渲染一帧，点赞态也是错的。
        setViews(null)
        setLikes(null)
        setComments(null)
        setLiked(false)
        statsLoadedRef.current = false
        loadArticle();
        scrollToTop();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    /* 跨端同步（20260926，**不轮询**）：看板娘改了这篇（标题/正文/状态）或把它删了，
       读者手上这一页也该跟上——但访客页面不为我自己的编辑加流量，所以只吃"看板娘一轮
       收尾"与"切回可见/重新聚焦"，不挂定时器（同首页/分类页）。 */
    useLiveRefresh(() => loadArticle({ silent: true }), { poll: false });
    
    const toggleFavorite = async () => {
        if (!id) return
        if (!getToken()) {
            message.warning('登录后才能收藏')
            return
        }
        setFavBusy(true)
        try {
            const res = faved ? await removeFavorite(Number(id)) : await addFavorite(Number(id))
            if (ok(res)) {
                // 写入成功 ⇒ 把结果交给共享状态（它顺手拉一次全量对齐：个人中心那份列表
                // 与这里的★立刻是同一个事实）。**不在这里改本地 boolean**——两份状态正是
                // 这轮要修的洞（见 favorites.ts 头注）。
                applyLocalFavorite(Number(id), !faved)
                message.success(faved ? '已取消收藏' : '已收藏（可在「设置 → 收藏的文章」里查看）')
            } else {
                message.error(errMsg(res))
            }
        } catch (e) {
            message.error('网络异常，请稍后再试')
        } finally {
            setFavBusy(false)
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

    // Effect: 代码块标签栏 + 复制按钮（20260914）——bytemd <Viewer> 只渲染 markdown,
    // 没有语言标签栏/复制按钮（工具栏是 Editor 的）,渲染后统一装饰（与对话框共用
    // decorateCodeBlocks）。mermaid 是异步把 pre 换成图、正文也是 React 渲染后才有,
    // 故挂 MutationObserver 兜住后续节点；装饰幂等,只认自己的标签栏插入不触发死循环。
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
        // 20260831：agent 段落感知恢复。markdown-navbar updateHashAuto 已关
        // （其滚动实现是每次 scroll 都 setTimeout+replaceState，触发 Chrome
        // "Throttling navigation" 节流警告），这里自建轻量跟踪替代：
        // rAF 节流 + 仅在跨过标题边界时 replaceState——URL hash 仍随阅读
        // 进度前进（agent 靠请求体 current_url 的 #锚点感知读者所在段落，
        // chat-stream.js 上报 location.href），频率从"每次 scroll"降到
        // "每跨一个标题一次"，无节流警告。
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
                // 20260831：hash 用标题文本而非 heading-N 编号——agent 从 current_url
                // 的 #锚点感知读者段落，heading-N 无法得知是哪个标题；标题文本（含中文）
                // 原样保留，仅 URL 特殊字符（# ? & = % / 空格）替换为 '-'，不污染 fragment
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
                            // 20260831：instant——目录高亮跟随只需要跳到位，平滑动画
                            // 每帧驱动侧栏滚动成本高（MutationObserver 触发频繁），
                            // 与文章页滚动卡顿同源
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
            ) : isLoading ? (
                <div style={{width:'100vw',height:'100vh',display:'flex',justifyContent:'center',alignItems:'center'}}>
                    <Loading />
                </div>
            ) : (
                <>
                    <div className="readCover" ref={coverRef}>
                        {/* poster 层 = 文章封面（沿用卡片那套裁剪参数）。视频播起来之前、
                            素材缺失或访客要求减少动效时，这里就是画面，观感与改造前一致。
                            不用 <video poster>：一整层 <img> 的 object-fit/裁剪控制更稳。

                            ⚠️ **没有封面时绝不能渲染这个 `<img>`**：`resolveApiAssetUrl('')`
                            返回空串 ⇒ `<img src="">` 会解析成**当前文档地址**再发一次请求，
                            必然失败并画成破图图标。实测线上真实访客（monitor.log：
                            `type=resource_error … msg=img 资源加载失败`，url 是文章页本身）
                            就是撞在这一条上——手机档尤其显眼，因为视频在移动网络下要么
                            还没起来、要么被"减少动效"整个关掉，poster 就是唯一画面。
                            改成一个纯 CSS 兜底层：宽高与定位和 poster 逐字相同，
                            只是不再发那次必然失败的请求。 */}
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
                        {/* 背景视频（20260912）：横幅图片比例随视口在 2:1~4:1 间漂移、没法适配，
                            改成循环视频；日夜各一段，key 换源即重新 autoplay。
                            离屏暂停见下面的 IntersectionObserver：详情页一往下滚它立刻出视口。 */}
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
                                {/* 左区：头像 + 作者名一行，发布日期/更新时间**两行**在下面
                                    （20261003 用户第 2 条：「左侧头像作者，下面是发布时间
                                    更新时间」）。原来的日期挂在中区标题下面，与标题同宽
                                    同折行——用户要的是把两个时间归到"作者"这一栏。

                                    结构上是 `.readAuthor` 这一列 + 两个子块：上块是 antd Flex
                                    横排（头像 + 名字），下块 `.readTimes` 竖排两行。名字那一层
                                    必须有 `span.readAuthorName` 才截得住——格子的轨道是定宽
                                    180px，长昵称若不截断就会画出轨道之外（见 sass 里那段）。 */}
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
                                {/* 中区：只剩标题，且**居中**（20261003 用户第 2 条：「中间是
                                    居中标题显示区域」）。20261001 之前这里是三个行内平级的 flex
                                    项、`space-between` 均分余量，标题一长日期就往左漂；今天居中
                                    靠的是**两侧轨道等宽**这一条结构不变量，不再靠"标题多长"。
                                    推导与那两个旋钮写在 sass 的 `.readInfo` 那段。 */}
                                <div className="readMain">
                                    <h1>{article?.noteTitle}</h1>
                                </div>
                                {/* 右区：四件读数**同一个簇**（20261001，用户第 1 条「详情页三图标
                                    样式和布局太丑了，大小不一，排列奇怪」）。

                                    之前是三个 wrapper、三套几何：收藏一件竖排胶囊（32×62），
                                    浏览与点赞各自一件，高度 24 / 30 不一 —— 排在一行里怎么摆
                                    都对不齐。现在四件挂同一个 `.readStat` 拿共用几何（同高 30px、
                                    同内边距、同字号、同描边），只有两个按钮多挂一层
                                    `.readFavBtn` / `.readLikeBtn` 拿交互态。
                                    几何全在 `.readStat` 里，别在这里的内联或新类上再写一份
                                    （"三处各写一遍"正是这一条被报上来的由来）。

                                    **排列由 sass 定成 2×2**（20261003 用户第 2 条：「右侧是四个
                                    数据组件 2*2 排布」；上一版第 5 条要的是竖排一列，本版把
                                    那一列的宽度给了左区——见 sass 的 `.readInfo` 那段）。
                                    所以这里只管顺序，别在 JSX 上加任何 `flexDirection`/内联宽度：
                                    DOM 顺序是 收藏 → 浏览 → 点赞 → 讨论，格子里的位置由
                                    `.readStats` 的 `grid-template-columns` 决定。 */}
                                <div className="readStats">
                                    <button
                                        type="button"
                                        className={`readStat readFavBtn${faved ? ' isFaved' : ''}`}
                                        disabled={favBusy}
                                        title={faved ? '取消收藏' : '收藏'}
                                        onClick={toggleFavorite}
                                    >
                                        {/* 图标与「浏览」那只眼睛同源同尺寸（`NoteStatIcons`）：
                                            20261001 之前这里是文本字形 `★/☆`，与同一排的
                                            svg 眼睛字重、基线都对不齐（用户第 4 条）。
                                            开关语义不变——未选中描边、选中实心。 */}
                                        {faved
                                            ? <StarIcon size={14} />
                                            : <StarOutlineIcon size={14} />}
                                        {/* 文案随状态变（收藏是布尔量，不该让用户自己猜现在是哪种），
                                            定宽在 .readFavLabel 里 —— 「收藏」→「已收藏」多一个字，
                                            三件同排时会把后面两件整排推移 */}
                                        <span className="readFavLabel">{faved ? '已收藏' : '收藏'}</span>
                                    </button>
                                    {views !== null && (
                                        <span className="readStat readViews" title="累计阅读量">
                                            {/* 图标在 `components/NoteStatIcons` 里（卡片那一排同源，
                                                别在这里再写一份路径——字形对不齐是两处各写一遍的老毛病） */}
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
                                    {/* 第四件：讨论数（20261003 用户第 5 条）。**不是按钮**——
                                        它没有任何可点的动作（讨论区就在本页下方），所以与
                                        `.readViews` 一样只是个读数；想要"点它滚到讨论区"是另一个
                                        需求，真要做时应当整簇统一（浏览也没有可点目标）。
                                        口径与讨论区列表一致（服务端 `approved = 1 AND
                                        is_deleted = 0`，见 `stats.comments` 的注释）。 */}
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
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 1 }}
                        >
                            {/* The markdown-body class is crucial for github-markdown-css */}
                            {/* We re-add it here on the wrapper */}
                            <div id="content" className="markdown-body">
                                <Viewer 
                                    value={content}
                                    plugins={plugins}
                                />
                            </div>
                        </motion.div>
                        <div className="navigation" id='toc'>
                             {/* updateHashAuto=false（20260831）：markdown-navbar 默认在滚动时
                                 每次 scroll 事件都 setTimeout+replaceState 改 URL hash——
                                 未节流的 document 级 scroll 监听在滚动期间高频触发定时器
                                 内导航，Chrome 报 "Throttling navigation" 节流警告，且与
                                 滚动卡顿同源（每帧遍历全页标题 + setState 高亮）；关闭后
                                 滚动不再改地址栏 hash，目录高亮与点击跳转不受影响 */}
                             <MarkdownNavbar
                                source={content}
                                ordered={false}
                                headingTopOffset={100}
                                updateHashAuto={false}
                             />
                        </div>
                    </div>
                    {/* 讨论区（20261002）：正文之后。XSS 防线在渲染侧的 markdown 管线
                        （CommentSection 里的 renderBlogMarkdown，与文章页 Viewer 同一条），
                        服务端只校验形状、不转义存储——见组件头注 ① */}
                    <CommentSection noteId={id} />
                </>
            )}
        </div>
    )
}

export default ReadArticle

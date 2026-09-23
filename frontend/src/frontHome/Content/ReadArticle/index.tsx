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
import { coverCropMotionStyle, cropFromRow } from "../../../utils/coverCrop";
import { resolveApiAssetUrl } from "../../../utils/runtimeApi";
import { useIsDarkMode } from "../../../theme";
import readDayVideo from '../../../assets/read_day.mp4';
import readNightVideo from '../../../assets/read_night.mp4';
import {getNoteById} from "../../../apis/NoteMethods.tsx";
import SeoHelmet from "../../../components/SeoHelmet";
import getToken from "../../../apis/getToken.tsx";
import {addFavorite, errMsg, ok, removeFavorite} from "../../../apis/ProfileMethods.tsx";
import { applyLocalFavorite, useFavorites } from "../../../components/UserCenter/favorites.ts";

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

    useEffect(() => {
        if (id) {
            setLoading(true)
            setNotFound(false)
            getNoteById(id).then((res) => {
                setArticle({ ...res.data.data });
            }).catch((err) => {
                console.error('获取失败', err)
                if (err?.response?.status === 404) {
                    setNotFound(true)
                    setArticle(null)
                }
            }).finally(() => {
                setLoading(false)
            });
        }
        scrollToTop();
    }, [id]);
    
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
                            不用 <video poster>：一整层 <img> 的 object-fit/裁剪控制更稳。 */}
                        <motion.img
                            className={`readCoverPoster${videoReady ? ' isHidden' : ''}`}
                            src={resolveApiAssetUrl(article?.cover)}
                            style={coverCropMotionStyle(cropFromRow(article))}
                            initial={{ filter: "blur(10px)" }}
                            animate={{ filter: "blur(0px)" }}
                            transition={{ duration: 1 }}
                        />
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
                                <Flex gap={"small"} justify={"center"} align={"center"}>
                                    <Avatar src={avatar} size={40} className="frontAvatar" />
                                    {name}
                                </Flex>
                                <h1>{article?.noteTitle}</h1>
                                <h3>{dayjs(article?.updateTime).format("YYYY-MM-DD")}</h3>
                                {/* 收藏按钮（20260922）：横幅信息卡里，与日期同排。
                                    文案随状态变——收藏是布尔量，不该让用户自己猜现在是哪种状态 */}
                                <div className="readFavWrap">
                                    <button
                                        type="button"
                                        className={`readFavBtn${faved ? ' isFaved' : ''}`}
                                        disabled={favBusy}
                                        onClick={toggleFavorite}
                                    >
                                        <span aria-hidden="true">{faved ? '★' : '☆'}</span>
                                        {faved ? '已收藏' : '收藏'}
                                    </button>
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
                </>
            )}
        </div>
    )
}

export default ReadArticle

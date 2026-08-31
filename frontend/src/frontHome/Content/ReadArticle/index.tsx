import './index.sass'
import {useEffect, useState, useRef} from "react";
import {useParams} from "react-router-dom";
import {NoteType} from "../../../interface/NoteType";
import { motion } from 'framer-motion';
import {Avatar, Flex} from "antd";
import {useSelector} from "react-redux";
import UserState from "../../../interface/UserState";
import dayjs from "dayjs";
import MarkdownNavbar from 'markdown-navbar'
import 'markdown-navbar/dist/navbar.css'
import Loading from "../../Loading";
import scrollToTop from "../../../utils/scrollToTop.tsx";
import {getNoteById} from "../../../apis/NoteMethods.tsx";
import SeoHelmet from "../../../components/SeoHelmet";

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
    math()
]

const ReadArticle = () => {
    const avatar = useSelector((state:{user:UserState}) => state.user.avatar)
    const name = useSelector((state:{user:UserState}) => state.user.name)
    const {id} = useParams()
    const [isLoading, setLoading] = useState(true)
    const [article, setArticle] = useState<NoteType|null>(null)
    
    // Lock ref to prevent TOC auto-scroll during manual click
    const isClickingTocRef = useRef(false);

    useEffect(() => {
        if (id) {
            setLoading(true)
            getNoteById(id).then((res) => {
                setArticle({ ...res.data.data });
            }).catch((err) => {
                console.error('获取失败', err)
            }).finally(() => {
                setLoading(false)
            });
        }
        scrollToTop();
    }, [id]);
    
    const content = article?.noteContent || '';

    // Effect: mermaid 图 + 正文图片单击放大(委托,兼容 mermaid 异步渲染)
    useEffect(() => {
        if (isLoading) return;
        const content = document.getElementById("content");
        if (!content) return;
        return initZoomDelegation(content);
    }, [isLoading]);

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
                            behavior: 'smooth'
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
            <SeoHelmet title={article ? article.noteTitle : '文章加载中'} description={article?.description || undefined} image={article?.cover || undefined} url={`/article/${id}`} type="article" />
            {isLoading ? (
                <div style={{width:'100vw',height:'100vh',display:'flex',justifyContent:'center',alignItems:'center'}}>
                    <Loading />
                </div>
            ) : (
                <>
                    <div className="readCover">
                        <motion.img
                            src={article?.cover}
                            initial={{ filter: "blur(10px)" }}
                            animate={{ filter: "blur(0px)" }}
                            transition={{ duration: 1 }}
                        />
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

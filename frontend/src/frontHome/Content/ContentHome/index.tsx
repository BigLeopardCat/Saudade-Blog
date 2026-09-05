import SeoHelmet from "../../../components/SeoHelmet";
import AnnouncementModal from "../../../components/AnnouncementModal";
import './index.sass'
import {Avatar, Tag} from "antd";
import SocialButton from "../../../components/Buttons/SocialButton";
import {useEffect, useRef, useState} from "react";
import {useSelector} from "react-redux";
import UserState from "../../../interface/UserState";
import { motion } from 'framer-motion';
import {formatNote, NoteType} from "../../../interface/NoteType";
import {categoryList} from "../../../store/components/categories.tsx";
import Article from "./Article.tsx";
import {useNavigate, useLocation} from "react-router-dom";
import {SocialType} from "../../../interface/SocialType";
import {getNotePage, getTopNotes} from "../../../apis/NoteMethods.tsx";
import dayjs from "dayjs";
import { resolveApiAssetUrl } from '../../../utils/runtimeApi';
import heroBg from '../../../assets/hero_bg.mp4';
import heroPoster from '../../../assets/hero_poster.jpg';


// 模块级缓存：只在同一次 SPA 会话内复用，离开 Dashboard 后自动失效
let cachedOtherArticles: NoteType[] = [];
let cachedTopArticles: NoteType[] = [];
let cachedCurrentPage = 1;
let cachedHasMoreArticles = true;
let isCachedOther = false;

const ContentHome = () => {
    const [currentTop,setCurrentTop] = useState(0);
    const [slideDir, setSlideDir] = useState<'left' | 'right'>('right');
    // 鼠标悬浮轮播图时暂停自动滚动（移开恢复）
    const [hoverPaused, setHoverPaused] = useState(false);
    // 轮播图滚出视口（如停在文章卡片区）时暂停自动滚动，避免离屏动画触发重绘
    const [topInView, setTopInView] = useState(true);
    const topRef = useRef<HTMLDivElement>(null);
    const heroRef = useRef<HTMLDivElement>(null);
    const [currentPage,setCurrentPage] = useState(cachedCurrentPage)
    const [hasMoreArticles, setHasMoreArticles] = useState(cachedHasMoreArticles);
    const [loading, setLoading] = useState(false);
    const location = useLocation();
    
    // 从 Dashboard 返回时清除缓存，确保数据最新
    if (location.state?.fromDashboard) {
        cachedOtherArticles = [];
        cachedTopArticles = [];
        cachedCurrentPage = 1;
        cachedHasMoreArticles = true;
        isCachedOther = false;
    }
    
    const avatar = useSelector((state:{user:UserState}) => state.user.avatar)
    const name = useSelector((state:{user:UserState}) => state.user.name)
    const oneSay = useSelector((state:{user:UserState}) => state.user.talk)
    const navigate = useNavigate()
    const [otherArticles,setOtherArticles] = useState<NoteType[]>(cachedOtherArticles)
    const [topArticles,setTopArticles] = useState<NoteType[]>(cachedTopArticles)
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

    // 顶部背景视频无缝循环（20260902 四修）：素材已裁为花瓣运动的 1s 周期循环
    // （25fps 下取末秒 26 帧 [t=4.96s, 5.96s]，首尾帧为同一相位，接缝帧差
    // ≈0.22 mean / >30 阈值 0.0000%——比素材自身逐帧步进（0.1~0.5）还小，
    // 重播即续播，无"回到第 0 帧"的内容复位）。此前三版均靠 JS 掩盖 6s 素材的
    // 接缝内容跳变，各有副作用：单视频淡化=蒙灰；双视频交叉淡化=闪+灰+重播感；
    // ping-pong 倒带 playbackRate=-1 在 Chrome 抛 NotSupportedError 直接全站
    // 崩溃（React Error Boundary）。现素材自对齐 + 原生 loop 属性，零 JS 干预。
    // hero 滚出视口即暂停（视频解码是持续 GPU 成本，离屏不再浪费），回视口恢复
    useEffect(() => {
        const hero = heroRef.current;
        if (!hero) return;
        const video = hero.querySelector('video');
        if (!video) return;
        // 20260902: 花瓣运动 2.25 倍速（正值 playbackRate，无负速崩溃风险）
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

    useEffect(() => {
        if (isCachedOther) return;
        setLoading(true);
        getNotePage({
            page: 1,
            pageSize: 6
        }).then(res => {
             const notePage = Array.isArray(res?.data?.data) ? res.data.data : [];
             const mapped = notePage.map((item: formatNote) => {
                return {
                    ...item,
                    key: item.noteKey,
                    noteTags: item.noteTags ? item.noteTags.split(',').map(tag => parseInt(tag, 10)) : [],
                }
            });
            setOtherArticles(mapped);
            cachedOtherArticles = mapped;
            isCachedOther = true;
        }).finally(() => {
            setLoading(false);
        })
    }, []);

    useEffect(() => {
        if (cachedTopArticles.length > 0) return;
        getTopNotes().then(res => {
             const topNotes = Array.isArray(res?.data?.data) ? res.data.data : [];
             const mapped = topNotes.map((item: formatNote) => {
                return {
                    ...item,
                    key: item.noteKey,
                    noteTags: item.noteTags ? item.noteTags.split(',').map(tag => parseInt(tag, 10)) : [],
                }
            });
            setTopArticles(mapped);
            cachedTopArticles = mapped;
        })
    }, []);
    const handleScrollDown = () => {
        window.scrollTo({
            top: window.innerHeight,
            behavior: 'smooth'
        });
    }
    const getMore = () => {
        setLoading(true)
        getNotePage({
            page: currentPage + 1,
            pageSize: 6
        }).then(res => {
            const nextPage = Array.isArray(res?.data?.data) ? res.data.data : [];
            if (nextPage.length === 0) {
                setHasMoreArticles(false);
                cachedHasMoreArticles = false;
            } else {
                setCurrentPage(currentPage + 1);
                cachedCurrentPage = currentPage + 1;
                setOtherArticles(prevArticles => {
                    const newArts = [
                        ...prevArticles,
                        ...nextPage.map((item: formatNote) => ({
                            ...item,
                            key: item.noteKey,
                            noteTags: item.noteTags ? item.noteTags.split(',').map(tag => parseInt(tag, 10)) : [],
                        }))
                    ];
                    cachedOtherArticles = newArts;
                    return newArts;
                });
                if(nextPage.length < 6) { setHasMoreArticles(false); cachedHasMoreArticles = false; }
            }
        }).finally(() => {
            setLoading(false);
        });
    };

    return <>
        <SeoHelmet title="Saudade Blog" description="个人技术博客 · Rust、React、IoT 开发经验与项目实践" url="/" suffix={false} />
        <div className="SelfDescription" ref={heroRef}>
            {/* 顶部背景视频：muted+playsInline 是自动播放的前提；poster 为加载期兜底；
                离屏暂停由上面的 IntersectionObserver 处理。heroOverlay 保证文字可读性 */}
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
            <div className="heroOverlay" />
            <AnnouncementModal />

            <div className="SayWords">
               <div>
                   <h2>Hi!👋</h2>
                   <h2>I'm <span style={{color: '#7880d1'}}>{author}</span></h2>
               </div>
                <h3 className="home-title-h3">Sereno da Saudade</h3>
                <div className="Social">
                    <SocialButton SocialName='QQ' img='/QQ.png'/>
                    <SocialButton SocialName='Github' url={social?.socialGithub}/>
                    <SocialButton SocialName='Bilibili' url='https://space.bilibili.com/442724375'/>
                    <SocialButton SocialName='Email' img='/QQ-Email.png' copyText='sora.saudade@qq.com'/>
                </div>
            </div>
            {/* 20260902 暂时注释掉大圆头像窗口 */}
            {/* <Avatar src={avatar} size={320} className='frontAvatar'/> */}
            <motion.div
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 1 }}
                style={{display:'flex',width:'200px',justifyContent:'center',bottom:'0',left:'8%',position:"absolute"}}
            >
            <p className="home-one-say" style={{position:'absolute',bottom:"20px", whiteSpace: "nowrap", font: '600 12px ""'}}>{oneSay}</p>
                <i className="iconfont icon-rcd-angle-double-down upAndDown" style={{fontSize: 50,position:"absolute",bottom: 20,color:'skyblue'}} onClick={handleScrollDown}/></motion.div>
        </div>
        <div className="ContentContainer dark-pic">
            {topArticles.length>0&&<div className="TopArticle" style={{ display: 'flex', position: 'relative' }} ref={topRef}
                onMouseEnter={() => setHoverPaused(true)}
                onMouseLeave={() => setHoverPaused(false)}
            >
                <div className="Top" style={{transform: 'translateY(-40%)', zIndex: 10}}><i className="iconfont icon-sticky1" style={{fontSize: 20,verticalAlign:'middle',marginRight:5}}></i>置顶</div>
                <div style={{ width: '100%', height: '100%', borderRadius: '15px', overflow: 'hidden' }}><div style={{ display: 'flex', width: '100%', height: '100%', transition: 'transform 0.8s cubic-bezier(0.25, 1, 0.5, 1)', transform: `translateX(-${currentTop * 100}%)` }}>
                    {topArticles.map((item, index) => (
                        <div className="TopArticleInner" key={item.key} onClick={() => navigate(`/article/${item.key}`)} style={{ width: '100%', flexShrink: 0, height: '100%' }}>
                            <div className="TopCover">
                                <img
                                    src={resolveApiAssetUrl(item.cover)}
                                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                />
                            </div>
                            <div className="topContent">
                                <h4># {Categories.find(c => c.categoryKey === item.noteCategory)?.categoryTitle}</h4>
                                <h3 className="contentTitle">{item.noteTitle}</h3>
                                <div className="ArticleDescription" style={{marginBottom: 20}}> {item.description}</div>
                                <div className='tags' style={{ width: '100%', marginTop: '10px' }}>
                                    {(Array.isArray(item.noteTags) ? item.noteTags : []).map(noteTag => {
                                        let color;
                                        let name;
                                        tagList.forEach((tag: { tagKey: number; color: string; title: string; children: any[]; }) => {
                                            if (tag.tagKey === noteTag) {
                                                color = tag.color;
                                                name = tag.title;
                                            } else if (tag.children && tag.children.some(child => child.tagKey === noteTag)) {
                                                color = tag.color;
                                                name = tag.children.find(child => child.tagKey === noteTag).title;
                                            }
                                        });

                                        return (
                                            <Tag color={color} key={noteTag} style={{ margin: 5 }}>
                                                {name}
                                            </Tag>
                                        );
                                    })}
                                </div>
                                <div className="topFooter" style={{ display: 'flex', alignItems: 'center', paddingBottom: '20px' }}>
                                    <Avatar src={avatar} size={40} style={{ marginRight: 10 }} />
                                    <span style={{ fontWeight: 'bold', marginRight: 10, lineHeight: '22px', fontSize: '14px' }}>{name}</span>
                                    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
                                         <span style={{ fontSize: 12, color: '#7f7e7e', lineHeight: '22px' }} className='post-date'>
                                            <i className="iconfont icon-naozhong icon" style={{ fontSize: 14, display: 'inline', marginRight: '4px' }}></i>
                                            发布于 {dayjs(item.createTime).format('YYYY-MM-DD')}
                                         </span>
                                         <span style={{ position: 'absolute', top: '100%', marginTop: '6px', left: 0, fontSize: 12, color: '#7f7e7e', lineHeight: '22px', whiteSpace: 'nowrap' }} className='post-date'>
                                            <i className="iconfont icon-naozhong icon" style={{ fontSize: 14, display: 'inline', marginRight: '4px' }}></i>
                                            更新于 {dayjs(item.updateTime).format('YYYY-MM-DD')}
                                         </span>
                                    </div>
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


        {/*  其他文章  */}
            <div style={{width:'80%', display: 'flex', marginBottom: '20px'}}>
                <div className='allContent'><i className="iconfont icon-wenzhang2" style={{fontSize: 25,verticalAlign:'sub',marginRight:5,color:'#7f7e7e'}}></i>文章</div>
            </div>

            <div className="allArticles">

                {otherArticles.map((item,index) => (
                    <Article item={item} index={index} Categories={Categories} avatar={avatar} name={name} tagList={tagList} key={index}/>
                ))}
            </div>
            {loading ? (
                <div className="loadingio-spinner-spinner-69tfms83mg9">
                    <div className="ldio-se504dvlmh">
                        <div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div>
                    </div>
                </div>
            ) : (
                <div>
                    {hasMoreArticles ? (
                        <div className='allContent more' style={{ padding: '20px 50px 20px 50px', borderRadius: 20, fontSize: 20 }} onClick={getMore}>More</div>
                    ) : null}
                </div>
            )}
        </div>
    </>
}

export default ContentHome
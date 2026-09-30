import SeoHelmet from "../../../components/SeoHelmet";
import './index.sass'
import {Avatar} from "antd";
import SocialButton from "../../../components/Buttons/SocialButton";
import {useEffect, useRef, useState} from "react";
import type {CSSProperties} from "react";
import {useLiveRefresh} from "../../../utils/liveRefresh.ts";
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
import { carouselCropOf, coverCropStyle } from '../../../utils/coverCrop';
import { parseNoteTags } from '../../../utils/noteTags';
import { resetDescScroll } from '../../../utils/descHover';
import heroBg from '../../../assets/hero_bg.mp4';
import heroPoster from '../../../assets/hero_poster.jpg';
import Vitrine from './Vitrine';


// 模块级缓存：只在同一次 SPA 会话内复用，离开 Dashboard 后自动失效
let cachedOtherArticles: NoteType[] = [];
let cachedTopArticles: NoteType[] = [];
let cachedCurrentPage = 1;
let cachedHasMoreArticles = true;
let isCachedOther = false;
// 与 cachedOtherArticles 配套的每页条数：缓存必须连页尺寸一起复用，
// 否则「列数变化后重拉」与「More 续翻」会用到两个不同的 per_page（页偏移错位 → 重复/漏项）
let cachedPageSize = 6;

/** 每页条数 = 栅格列数 × 2（需求：默认显示满两行）。量不到列数时回退 6 = 改造前的固定值 */
const FALLBACK_PAGE_SIZE = 6;
const MAX_PAGE_SIZE = 48;

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

/** 列数 → 每页条数（满两行）；越界/量不到时回退固定值 */
const pageSizeFor = (cols: number): number =>
    Number.isFinite(cols) && cols > 0 ? Math.min(cols * 2, MAX_PAGE_SIZE) : FALLBACK_PAGE_SIZE

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
    const [currentPage,setCurrentPage] = useState(cachedCurrentPage)
    const [hasMoreArticles, setHasMoreArticles] = useState(cachedHasMoreArticles);
    const [loading, setLoading] = useState(false);
    // 每页条数由栅格列数决定（满两行）。不放进 state：没有任何地方渲染它，
    // 用 ref 供 getMore / 测量回调读最新值（放进 state 反而会多一条「已声明未读取」的 tsc 报错）
    const pageSizeRef = useRef(cachedPageSize);
    // 列表世代号：整表替换（首屏/列数变化）时 +1，用于丢弃迟到的旧响应——
    // 只靠 loading state 挡不住跨 tick 的竞态
    const genRef = useRef(0);
    const measureRef = useRef<HTMLDivElement>(null);
    const location = useLocation();

    // 从 Dashboard 返回时清除缓存，确保数据最新
    if (location.state?.fromDashboard) {
        cachedOtherArticles = [];
        cachedTopArticles = [];
        cachedCurrentPage = 1;
        cachedHasMoreArticles = true;
        cachedPageSize = FALLBACK_PAGE_SIZE;
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

    /**
     * 拉第一页并整表替换（首屏 / 列数变化时）。ps 必须是「整页尺寸」：
     * 页偏移 = (page-1)*per_page，之后 More 续翻必须沿用同一个 ps，否则会重复/漏项。
     */
    const fetchFirst = (ps: number, opts?: { silent?: boolean }) => {
        // 立刻同步登记 ps：ResizeObserver 的首次回调（防抖 200ms 后）会拿它比对，
        // 若等响应回来再写，慢网络下会被误判成「列数变了」而多发一次请求
        pageSizeRef.current = ps;
        const g = ++genRef.current;
        // `silent` = 背景重拉（跨端同步）：**不把 More 那颗按钮换成转圈**——首屏那一大片
        // 转圈是"页还没好"的信号，后台核对一次不该借用它（同后台几页"背景重拉不亮 loading"）。
        if (!opts?.silent) setLoading(true);
        getNotePage({
            page: 1,
            pageSize: ps
        }).then(res => {
            if (g !== genRef.current) return; // 迟到的旧世代响应：已被更新的整表替换取代
            const notePage = Array.isArray(res?.data?.data) ? res.data.data : [];
            const mapped = notePage.map((item: formatNote) => {
                return {
                    ...item,
                    key: item.noteKey,
                    noteTags: parseNoteTags(item.noteTags),
                }
            });
            setOtherArticles(mapped);
            cachedOtherArticles = mapped;
            isCachedOther = true;
            setCurrentPage(1);
            cachedCurrentPage = 1;
            cachedPageSize = ps;
            // 首屏也要更新 More 的可见性（此前只有 getMore 会更新，More 会一直在）
            const more = mapped.length === ps;
            setHasMoreArticles(more);
            cachedHasMoreArticles = more;
        }).finally(() => {
            if (g === genRef.current && !opts?.silent) setLoading(false);
        })
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
    const fetchTop = () => getTopNotes().then(res => {
         const topNotes = Array.isArray(res?.data?.data) ? res.data.data : [];
         const mapped = topNotes.map((item: formatNote) => {
            return {
                ...item,
                key: item.noteKey,
                noteTags: parseNoteTags(item.noteTags),
            }
        });
        setTopArticles(mapped);
        cachedTopArticles = mapped;
    });

    useEffect(() => {
        if (cachedTopArticles.length > 0) return;
        fetchTop();
    }, []);

    /* 跨端同步（20260926，**不轮询**）：看板娘刚改了站内文章（新建/删除/改状态/改置顶）
       时访客手上这一页也该跟上——但访客页面**不为我自己的编辑加流量**：只吃"看板娘一轮
       收尾"与"切回可见/重新聚焦"，不挂定时器（同分类页/详情页；成本关在后台那几页）。
       `skip`（已经点过 More 就不动）：`fetchFirst` 是**整表替换**且把页号打回第 1 页——
       主人翻了五页正看着，后台核对一次就把卷轴收回到开头，那是比"旧一点"坏得多的体验。
       还在第一页时没有任何可丢的东西，那时才换；翻过页之后要让内容变新，走的是既有的
       「从后台返回即清缓存」（见上面 `location.state.fromDashboard` 那一段）。 */
    useLiveRefresh(() => {
        fetchTop();
        fetchFirst(pageSizeRef.current, { silent: true });
    }, { poll: false, skip: () => currentPage > 1 });
    const handleScrollDown = () => {
        window.scrollTo({
            top: window.innerHeight,
            behavior: 'smooth'
        });
    }
    const getMore = () => {
        // 续翻必须沿用当前整表的 per_page（页偏移 = (page-1)*per_page）；
        // 世代号快照用于丢弃「列数变化已整表重拉」之后才到达的迟到响应
        const ps = pageSizeRef.current;
        const g = genRef.current;
        const nextPageNum = currentPage + 1;
        setLoading(true)
        getNotePage({
            page: nextPageNum,
            pageSize: ps
        }).then(res => {
            if (g !== genRef.current) return;
            const nextPage = Array.isArray(res?.data?.data) ? res.data.data : [];
            if (nextPage.length === 0) {
                setHasMoreArticles(false);
                cachedHasMoreArticles = false;
            } else {
                setCurrentPage(nextPageNum);
                cachedCurrentPage = nextPageNum;
                setOtherArticles(prevArticles => {
                    const newArts = [
                        ...prevArticles,
                        ...nextPage.map((item: formatNote) => ({
                            ...item,
                            key: item.noteKey,
                            noteTags: parseNoteTags(item.noteTags),
                        }))
                    ];
                    cachedOtherArticles = newArts;
                    return newArts;
                });
                if(nextPage.length < ps) { setHasMoreArticles(false); cachedHasMoreArticles = false; }
            }
        }).finally(() => {
            if (g === genRef.current) setLoading(false);
        });
    };

    return <>
        <SeoHelmet title="Saudade Blog" description="个人技术博客 · Rust、React、IoT 开发经验与项目实践" url="/" suffix={false} />
        <div className="SelfDescription" ref={heroRef}>
            {/* 拼贴底（20260930 四轮，用户：「主页也想要这种图片的风格」——参考图是
                粉紫淡彩的日系手账封面）。三层柔和色块 + 一层方格纸 + 撒几片樱花，
                **全部是静态渐变与 transform 动画**：不用 `filter: blur()` 做柔化
                （大面积模糊 + 视频解码会把 GPU 压住，后台那次事故的放大器就是它）。
                纯装饰，`aria-hidden`。 */}
            <div className="collageBg" aria-hidden="true">
                <span className="blob blobA"/>
                <span className="blob blobB"/>
                <span className="blob blobC"/>
            </div>
            <div className="petals" aria-hidden="true">
                {[0, 1, 2, 3, 4, 5, 6].map((i) => <span key={i} className={`petal p${i + 1}`}/>)}
            </div>

            <div className="SayWords">
                {/* 窗贴式小标签：参考图上那张手账的封面标签 */}
                <div className="heroTag">
                    <span className="heroTagStar">✦</span>
                    <span>{author} の 记录室</span>
                </div>
                <h1 className="home-title-h3">Sereno da Saudade</h1>
                {/* 命令条：纯装饰（`aria-hidden`，别让读屏软件念一句假的 shell 提示）。
                    文字是死的、只有光标在闪——不做打字机：那要动宽度，小盒子的布局动画
                    一样会引发布局回流，收益只有一个"动"。 */}
                <div className="heroTerminal" aria-hidden="true">
                    <span className="termUser">saudade@blog</span>
                    <span className="termSep">:</span>
                    <span className="termPath">~</span>
                    <span className="termSep">$</span>
                    <span className="termCmd">cat ./about.md</span>
                    <span className="termCaret"/>
                </div>
                {/* 四个按钮**全部**读站点设置（20260930）。此前只有 Github 读了，
                    B 站 UID 与邮箱写死、QQ 用仓库里带的加好友二维码 —— 那几张图含真名与真号，
                    仓库一公开就是泄漏。**没填的按钮整个不渲染**（传 undefined 会渲染一个点不动的死按钮）。 */}
                <div className="Social">
                    {social?.socialQQ && <SocialButton SocialName='QQ' copyText={social.socialQQ}/>}
                    {social?.socialGithub && <SocialButton SocialName='Github' url={social.socialGithub}/>}
                    {social?.socialBilibili && <SocialButton SocialName='Bilibili' url={social.socialBilibili}/>}
                    {social?.socialEmail && <SocialButton SocialName='Email' copyText={social.socialEmail}/>}
                </div>
            </div>

            {/* 右列 = 手账内页（视频）+ 它下面的展示柜（20260930 五轮）。
                两个原来各自绝对定位/各自占位的东西，现在是一列里的两张胶带贴图。
                ⚠️ 夜间档 `.frontDark` 仍然把 `.heroPanel` 整块 `display: none`（视频仅白天
                显示是 20260902 的用户要求；只藏 video 会留一张空白的白卡片）——于是夜里这
                一列只剩展示柜那张卡，位置正好还是原来那个视觉落点。 */}
            <div className="heroRight">
                {/* 背景视频（20260902 起，20260930 四轮搬家）：从满屏底变成拼贴里的一张
                    "手账内页"——白边 + 两角胶带 + 歪 1.2 度。muted+playsInline 是自动播放的
                    前提；poster 兜加载期；离屏暂停由上面的 IO 处理（它取的是 hero 里第一个
                    video，选择器照旧命中）。 */}
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

                <Vitrine/>
            </div>
            {/* 20260902 暂时注释掉大圆头像窗口 */}
            {/* <Avatar src={avatar} size={320} className='frontAvatar'/> */}
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
            {topArticles.length>0&&<div className="TopArticle" style={{ display: 'flex', position: 'relative' }} ref={topRef}
                onMouseEnter={() => setHoverPaused(true)}
                onMouseLeave={() => setHoverPaused(false)}
            >
                <div className="Top" style={{transform: 'translateY(-40%)', zIndex: 10}}><i className="iconfont icon-sticky1" style={{fontSize: 20,verticalAlign:'middle',marginRight:5}}></i>置顶</div>
                <div style={{ width: '100%', height: '100%', borderRadius: '15px', overflow: 'hidden' }}><div style={{ display: 'flex', width: '100%', height: '100%', transition: 'transform 0.8s cubic-bezier(0.25, 1, 0.5, 1)', transform: `translateX(-${currentTop * 100}%)` }}>
                    {topArticles.map((item) => (
                        <div className="TopArticleInner" key={item.key} onClick={() => navigate(`/article/${item.key}`)} style={{ width: '100%', flexShrink: 0, height: '100%' }}>
                            <div className="TopCover">
                                <img
                                    src={resolveApiAssetUrl(item.cover)}
                                    style={{ width: '100%', height: '100%', objectFit: 'cover', ...coverCropStyle(carouselCropOf(item)) }}
                                />
                            </div>
                            <div className="topContent">
                                <h4># {Categories.find(c => c.categoryKey === item.noteCategory)?.categoryTitle}</h4>
                                <h3 className="contentTitle">{item.noteTitle}</h3>
                                {/* 简介的展开/收回在 `.TopArticle .topContent .ArticleDescription`
                                    里（定高槽 + 槽内绝对定位 ⇒ 它长高不参与布局）。
                                    这一列是 `justify-content: center`，任何占位变化都会让
                                    整列重新居中 ⇒ 槽是"悬浮期间这一列一个像素都不动"的唯一
                                    保证。这里只负责离开时把滚位抹回顶部。
                                    ⚠️ 间距（原来写成行内 `marginBottom: 20`）现在归**槽**管，
                                    所以**不要**再往简介上写行内 margin——内联样式特异性最高，
                                    会跟槽的定位打架。 */}
                                <div className="descSlot">
                                    <div className="ArticleDescription" onMouseLeave={resetDescScroll}> {item.description}</div>
                                </div>
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

                                        // 标签 id 查不到名字就整条不渲染。旧版是 `<Tag>{undefined}</Tag>`
                                        // ——antd 会老老实实吐一个**空药丸**；手账 chip 带一个色点，
                                        // 空 chip 看着像个坏掉的控件（同 apis/TagMethods.tsx:162 的处置）。
                                        if (!name) return null;

                                        // 不用 antd `<Tag color=…>`：那个 `color` 会落成**内联**的
                                        // background/border/color，而内联特异性最高 —— 想换成手账 chip
                                        // 就只能 `!important` 硬压。改成一个纯 span，把标签自己的色相
                                        // 从 CSS 变量 `--tg` 递进去（`style` 里只有变量，没有颜色），
                                        // 配色一律由 sass 说了算。
                                        return (
                                            <span
                                                className="tagChip"
                                                key={noteTag}
                                                style={{ '--tg': color || 'var(--washi-lav, #b9a7f5)' } as CSSProperties}
                                            >
                                                <i className="tagChipDot" aria-hidden="true" />
                                                {name}
                                            </span>
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

            {/* 列数探针：量容器的真实轨道数决定「满两行」的每页条数。
                不能直接量 .allArticles —— auto-fit 折叠空轨会让列数变成「已渲染条目数」的函数
                （首屏 0 条 → 0 列），且它的空轨在 computed 值里序列化成 0px。 */}
            <div className="allArticles allArticlesMeasure" aria-hidden="true" ref={measureRef}>
                <div style={{ gridColumn: '1 / -1' }} />
            </div>

            <div className="allArticles">

                {otherArticles.map((item,index) => (
                    <Article item={item} index={index} Categories={Categories} avatar={avatar} name={name} tagList={tagList} key={item.key}/>
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
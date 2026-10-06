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

/** 量不到列数时回退的每页条数 = 改造前的固定值（真正的公式在下面 `pageSizeFor`） */
const FALLBACK_PAGE_SIZE = 6;
/** 每页条数上限（后端 `pageSize` 是 `clamp(1, 1000)`，这个 48 只是前端的自律） */
const MAX_PAGE_SIZE = 48;
/** 桌面档一页几行 */
const DESKTOP_ROWS = 2;
/** 列数 ≤ 这个数就算窄屏（手机档的 `.allArticles` 是 `repeat(2, 1fr)`，见 index.sass 手机档） */
const NARROW_COLS = 2;
/**
 * 窄屏一页几行（20261006 用户第 5 条）：「在移动端点 MORE 按钮文章卡片只多加载两行，
 * 让人很容易失去耐心，一次加载卡片数量太少」⇒ 手机档从两行提到**四行**（2 列 × 4 = 8 张）。
 * 桌面各档不受影响（仍是两行）—— 一屏能看几张跟屏宽是同一件事，桌面上两行就填满了。
 */
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
    /**
     * 卡片要不要放入场动画（20261004 用户第十一报：「每次回到首页都有卡片一张张出来的
     * 动画，明明已经加载缓存好了吧，那过渡动画纯纯耗时影响体验」）。
     *
     * 判据就是**这一屏的文章是不是现拉的**：`isCachedOther` 为真（本会话已经拉过一次）
     * 且缓存里真有条目 ⇒ 数据是同步拿到的，动画除了拖时间什么都不做 ⇒ 关掉。
     * 上面那段 `fromDashboard` 清缓存的代码在这行**之前**跑，所以从后台回来时
     * 缓存已经空了、这里自然算出 true —— 那一趟确实要等网络，动画是它的进度反馈。
     *
     * ⚠️ 用 `useState(初始化函数)` 在**挂载时冻结**，不要写成每次渲染都算的表达式：
     * framer-motion 的 `initial` 只在挂载那一次读，值中途翻转的话已渲染的卡片会换掉
     * 动画语义（一半有 initial 一半没有），而且 `Article` 里那份 `isVisible` 初值也跟着错。
     */
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
        <SeoHelmet title={SITE_TITLE} description={SITE_DESCRIPTION} url="/" suffix={false} />
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
                {/* 置顶贴纸（20261001 六轮）：`.Top` 只管定位、`.TopTape` 才是那张胶带。
                    原来这里内联了 `transform: translateY(-40%)` 与 `zIndex: 10` —— 前者是
                    **常驻动效写不进去**的根因（内联特异性最高），已删；位置改由 sass 的
                    `top` 说了算（顺带从"悬在卡片上方"挪到"骑在卡片顶边上"），
                    `zIndex` 也挪进了 `.Top` 规则。字与图标的大小/颜色一并交给 sass。 */}
                <div className="Top"><span className="TopTape"><i className="iconfont icon-sticky1" aria-hidden="true"></i>置顶</span></div>
                <div style={{ width: '100%', height: '100%', borderRadius: '15px', overflow: 'hidden' }}><div style={{ display: 'flex', width: '100%', height: '100%', transition: 'transform 0.8s cubic-bezier(0.25, 1, 0.5, 1)', transform: `translateX(-${currentTop * 100}%)` }}>
                    {topArticles.map((item) => (
                        <div className="TopArticleInner" key={item.key} onClick={() => navigate(`/article/${item.key}`)} style={{ width: '100%', flexShrink: 0, height: '100%' }}>
                            <div className="TopCover">
                                {/* 没封面就不渲染 <img>：空 `src` 会按当前文档地址解析，
                                    每个无封面条目都朝首页本身再发一次必然失败的请求并画成
                                    破图（与 `LazyImage` 同一族，见那边的注释）。 */}
                                {resolveApiAssetUrl(item.cover) && (
                                    <img
                                        src={resolveApiAssetUrl(item.cover)}
                                        style={{ width: '100%', height: '100%', objectFit: 'cover', ...coverCropStyle(carouselCropOf(item)) }}
                                    />
                                )}
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
                                {/* 20261001：这一排原来自己手搓了一遍"按 id 找标签名"（一级/二级两分支
                                    各查一次），与 `apis/TagMethods.tsx::renderNoteTags` 是同一件事的
                                    第二份实现 —— 两份实现必然分叉（这轮的由头正是"普通卡改了样式、
                                    置顶卡没跟上"）。现在统一走那一份。
                                    ⚠️ 子标签**找父色**那条旧行为一并消失：标签自己的颜色由
                                    `flattenTagOptions` 给（二级标签早就有自己的色了，管理页也是这么显示的）。 */}
                                <div className='tags' style={{ width: '100%', marginTop: '10px' }}>
                                    {renderNoteTags(item.noteTags, tagList)}
                                </div>
                                <div className="topFooter" style={{ display: 'flex', alignItems: 'center', paddingBottom: '20px' }}>
                                    {/* 头像 + 署名 + 两个日期（20261001）：与文章卡片那份逐字相同，
                                        已抽到 `components/NoteByline`。传进去的 `avatar`/`name`
                                        是**站点级兜底**，文章自己有作者记录时用文章那份。 */}
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


        {/*  其他文章  */}
            <div style={{width:'80%', display: 'flex', marginBottom: '20px'}}>
                {/* 「文章」段落签：图标的大小/颜色原本内联写死（25px 灰 `#7f7e7e`），
                    现在归 `ContentHome/index.sass` 的 `.allContent .iconfont` 管。 */}
                <div className='allContent'><i className="iconfont icon-wenzhang2" aria-hidden="true"></i>文章</div>
            </div>

            {/* 列数探针：量容器的真实轨道数决定「满两行」的每页条数。
                不能直接量 .allArticles —— auto-fit 折叠空轨会让列数变成「已渲染条目数」的函数
                （首屏 0 条 → 0 列），且它的空轨在 computed 值里序列化成 0px。 */}
            <div className="allArticles allArticlesMeasure" aria-hidden="true" ref={measureRef}>
                <div style={{ gridColumn: '1 / -1' }} />
            </div>

            <div className="allArticles">

                {otherArticles.map((item,index) => (
                    <Article item={item} index={index} Categories={Categories} avatar={avatar} name={name} tagList={tagList} enter={enterAnimation} key={item.key}/>
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
                    {/* 「More」按钮：尺寸原本是行内样式（`padding: 20px 50px` + `borderRadius: 20`
                        + `fontSize: 20`），与 `.allContent` 的 `width: 80px` 一起把内容盒挤成 0
                        （全站 `* { box-sizing: border-box }`，实测元素被内边距撑成 100×40）。
                        现在身材与手感都归 sass 的 `.more`。 */}
                    {hasMoreArticles ? (
                        <div className='allContent more' onClick={getMore}>More</div>
                    ) : null}
                </div>
            )}
        </div>
    </>
}

export default ContentHome
import {Avatar, Card, ConfigProvider, Modal} from 'antd'
import './index.sass'
import {Key, ReactElement, ReactNode, ReactPortal, useEffect, useRef, useState} from "react";
import {useLocation, useNavigate} from "react-router-dom";
import {debounce} from 'lodash';
import Switch from "../../components/Switch";
import SearchButton2 from "../../components/Buttons/SearchButton2";
import TopMao from "../../components/TopMao";
import {fetchCategories} from "../../store/components/categories.tsx";
import {useDispatch, useSelector} from "react-redux";
import {fetchTags} from "../../store/components/tags.tsx";
import {fetchSocial, fetchUserInfo} from "../../store/components/user.tsx";
import {fetchNoteList} from "../../store/components/note.tsx";
import { searchAll } from "../../apis/SearchMethods.tsx";
import {
    AggregateHit,
    AggregateResult,
    SearchType,
    TYPE_LABEL,
    TYPE_ORDER,
    allHits,
    hitsOf,
    hitTarget,
} from "./aggregate";
import '../main.css'
import MoonToSun from "../MoonToSun";
import { recordUserChoice } from "../../theme";
import UserCenter from "../../components/UserCenter";
import { useUnread } from "../../components/UserCenter/unread";
import { useViewerAvatar } from "../../components/UserCenter/identity";
import getToken from "../../apis/getToken.tsx";
import { isAdminToken } from "../../utils/auth.ts";

/* 留言板（河灯）导航图标：古风信箱 */
const GuestbookIcon = (
    <svg className="hb-icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden focusable="false">
        <path d="M608.256 681.984l-61.44 24.576-8.192-65.536z" fill="#FFCC7C"/>
        <path d="M987.136 202.752l-22.528-14.336 14.336-24.576c6.144-10.24 2.048-22.528-8.192-28.672 8.192-12.288 12.288-26.624 12.288-40.96 0-28.672-14.336-55.296-40.96-71.68-18.432-10.24-40.96-14.336-61.44-8.192-20.48 6.144-38.912 18.432-49.152 38.912-4.096-2.048-10.24-4.096-16.384-2.048-4.096 2.048-10.24 4.096-12.288 10.24l-131.072 225.28H40.96c-10.24 0-20.48 10.24-20.48 20.48v534.528c0 12.288 10.24 20.48 20.48 20.48h268.288V962.56c0 8.192 4.096 14.336 10.24 18.432 4.096 2.048 6.144 2.048 10.24 2.048s8.192-2.048 12.288-4.096l174.08-116.736H819.2c10.24 0 20.48-8.192 20.48-20.48V403.456l104.448-180.224 22.528 12.288s2.048 2.048 0 6.144c0 8.192-6.144 28.672-49.152 63.488-38.912 30.72-57.344 57.344-57.344 81.92 0 14.336 4.096 26.624 16.384 36.864 4.096 4.096 8.192 6.144 14.336 6.144 6.144 0 10.24-2.048 14.336-6.144 8.192-8.192 8.192-20.48 0-28.672-4.096-2.048-4.096-4.096-4.096-4.096 0-4.096 4.096-20.48 43.008-51.2 57.344-45.056 65.536-79.872 65.536-102.4-2.048-14.336-10.24-28.672-22.528-34.816z" fill="#1C2754"/>
        <path d="M798.72 475.136v346.112H501.76l-4.096 4.096-145.408 100.352v-81.92c0-12.288-10.24-20.48-20.48-20.48H61.44V327.68h585.728l-153.6 266.24c-2.048 2.048-2.048 6.144-2.048 10.24v4.096l12.288 88.064H163.84c-10.24 0-20.48 10.24-20.48 20.48s10.24 20.48 20.48 20.48h346.112c0 6.144 4.096 12.288 10.24 14.336 4.096 2.048 6.144 2.048 10.24 2.048 2.048 0 4.096 0 8.192-2.048l120.832-49.152h2.048c2.048 0 2.048-2.048 4.096-2.048h2.048l2.048-2.048c2.048-2.048 2.048-2.048 2.048-4.096L798.72 475.136z" fill="#FFCC7C"/>
        <path d="M897.67936 139.89888l-84.992 147.21024-23.552 40.79616-178.176 308.61312-70.94272-40.96 154.624-267.81696 23.552-40.79616 108.544-188.0064z" fill="#B2C8FF"/>
        <path d="M933.15072 160.37888l-93.184 161.3824-40.96 70.9632-152.576 264.27392-35.47136-20.48 178.176-308.61312 23.552-40.79616 84.992-147.21024z" fill="#B2C8FF"/>
        <path d="M935.89504 114.66752l-70.94272-40.96c5.12-8.86784 13.78304-15.68768 24.9856-18.67776 2.78528-0.75776 7.3728-0.49152 10.15808-1.2288 7.3728-0.47104 13.7216 0.8192 20.80768 4.9152 19.49696 11.264 26.25536 36.4544 14.99136 55.95136z" fill="#789EFF"/>
        <path d="M606.43328 681.20576l-59.2896 24.8832-8.11008-63.7952z" fill="#C1CDEB"/>
        <path d="M490.94656 602.70592s-1.024 1.76128 0.75776 2.78528l0.73728 2.80576-1.49504-5.59104z" fill="#1C2754"/>
        <path d="M163.84 450.56h225.28c12.288 0 20.48 8.192 20.48 20.48s-8.192 20.48-20.48 20.48H163.84c-12.288 0-20.48-8.192-20.48-20.48s8.192-20.48 20.48-20.48z" fill="#1C2754"/>
        <path d="M163.84 573.44h225.28c12.288 0 20.48 8.192 20.48 20.48s-8.192 20.48-20.48 20.48H163.84c-12.288 0-20.48-8.192-20.48-20.48s8.192-20.48 20.48-20.48z" fill="#1C2754"/>
    </svg>
);

interface HeadProps {
    setDark: (value: (((prevState: boolean) => boolean) | boolean)) => void,
    isDark: boolean,
    scrollHeight: number
}

const Head = ({ setDark, isDark, scrollHeight }: HeadProps) => {
    const [showStatus, setShowStatus] = useState(false);
    const [phoneBarShow, setPhoneBarShow] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const [isLogin, setLogin] = useState(0)
    // 个人中心（20260922）：点「设置」打开的大窗口 + 头像右上角的未读红点
    const [centerOpen, setCenterOpen] = useState(false)
    const { counts: unreadCounts } = useUnread(isLogin === 1)
    const [showMobileCategory, setShowMobileCategory] = useState(false);
    const dispatch = useDispatch()
    const navigate = useNavigate();
    /* 头顶压着一块**深色**横幅的页面（20261001，用户第 3 条「文章详情页的顶部栏字体看不清」）。
     *
     * 透明态的导航字吃 `--washi-ink`：白天档是深墨紫 `#4a3550`，压在淡彩首屏上约 7:1 ——
     * 那正是它当初被选成令牌值的原因。但文章详情页的首屏不是淡彩纸，是 `.readCover`
     * 那张封面（视频/大图 + 顶缘那条 `rgba(0,0,0,.5)` 渐变）：实测背景 ≈ `#3e3e3f`，
     * 深墨紫压上去是 **1.0:1**，字与底完全分不开。夜间档本来就吃浅色令牌，只有白天中招。
     *
     * 判据用**路由**而不是"测量底下是不是深色"：站点只有这一处横幅是深底，
     * 它是既定的页面形态、不是运行期运气（同族教训见 memory「判据的前提住在别人手里」——
     * 判据依赖运行期取值时，换一篇文章、换一帧视频就会换一个结果）。
     * 与 `.is-stuck`（滚动）/`:hover` 共用同一套浅字 + 投影，见 index.sass。 */
    const overDarkBanner = useLocation().pathname.startsWith('/article/');
    const [animation,setAnimation] = useState('');
    const categoryList = useSelector((state: any) => state.categories.categories)
    // 头部头像 = **当前访客**的头像（20260922 用户要求的三态：正常登录 / 退出登录但本机挂着
    // 账号 / 从没有过账号记录），不再是站点主人那张 `state.user.avatar`——那张图现在只用在
    // 文章页的作者署名处。三态的选择与缓存见 components/UserCenter/identity.ts。
    const viewerAvatar = useViewerAvatar()
    const blogTitle = useSelector((state:{user:{blogTitle: string}}) => state.user.blogTitle)

    // Search Logic
    const [searchKeyword, setSearchKeyword] = useState('');
    /* 聚合搜索（20261006）：一次搜文章 / 说说 / 留言 / 评论。
     * `null` = 还没搜过——与"搜了但一条都没命中"（total 为 0 的对象）是**两回事**，
     * 前者不该显示"未找到相关内容"。 */
    const [agg, setAgg] = useState<AggregateResult | null>(null);
    /** 单选筛选：`'all'` = 四类都显示；点某一枚计数只看那一类（**再点它一次回到全部**）。 */
    const [activeType, setActiveType] = useState<SearchType | 'all'>('all');
    /* 读失败与"确实没命中"必须分开（同 Talk 页 20261005 那条纪律）。
     * 接口故障时渲染成"未找到相关内容"，等于替站内声明"没有这条内容"——而事实是没读到。 */
    const [searchFailed, setSearchFailed] = useState(false);
    const [isSearching, setIsSearching] = useState(false);

    useEffect(() => {
        dispatch<any>(fetchCategories())
        dispatch<any>(fetchTags())
        dispatch<any>(fetchUserInfo())
        dispatch<any>(fetchNoteList())
        dispatch<any>(fetchSocial())
        const status = localStorage.getItem('tokenKey')
        if (status !== null) {
            setLogin(1)
        }

        // 登录/退出都会派发 auth-change（登录成功 → Login 页派发；退出 → 下面那个按钮派发）
        // 20260922：头部是常驻组件、路由切换不重挂载，只靠挂载时读一次 localStorage 会出现
        // "刚登录完，头像菜单里还是「登录」、红点不出现"，得刷新才正常。
        const onAuthChange = () => {
            const loggedIn = !!getToken()
            setLogin(loggedIn ? 1 : 0)
            // 退出时把「设置」窗口一起关掉（窗口里全是需要登录的数据）
            if (!loggedIn) setCenterOpen(false)
        }
        window.addEventListener('auth-change', onAuthChange)

        // 看板娘 agent 的 DARKMODE: 命令切换夜间模式时，触发与手动点击相同的日月过渡动画
        // （boot.js applyDarkMode 在状态实际变化时派发 moon-sun-animation）
        const handleMoonSun = (e: Event) => {
            const s = (e as CustomEvent).detail;
            if (s === 'sun' || s === 'moon') setAnimation(s);
        };
        window.addEventListener('moon-sun-animation', handleMoonSun);
        return () => {
            window.removeEventListener('moon-sun-animation', handleMoonSun);
            window.removeEventListener('auth-change', onAuthChange);
        };
    }, []);

    // 抽屉菜单打开时锁定页面滚动：背景不随手指滑动，仅抽屉内部可滚动
    useEffect(() => {
        if (!phoneBarShow) return;
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const onTouchMove = (e: TouchEvent) => {
            const t = e.target as HTMLElement | null;
            if (t && t.closest('.phoneSide')) return; // 抽屉内部放行（自身可滚动）
            e.preventDefault(); // 其余区域禁止滚动（兼容 iOS 橡皮筋）
        };
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        return () => {
            document.body.style.overflow = prevOverflow;
            document.removeEventListener('touchmove', onTouchMove);
        };
    }, [phoneBarShow]);

    // 关闭抽屉菜单（同时收起分类子菜单），所有导航入口共用
    const closePhoneBar = () => { setPhoneBarShow(false); setShowMobileCategory(false); };

    // 定义防抖函数，设置延迟时间为 300 毫秒
    const startAnimationDebounced = debounce(() => {
        setShowStatus(true);
    }, 300);

    // 悬浮宽限期：鼠标短暂离开头像（如滑向按钮、跨过间隙）不立即收回菜单，
    // 避免"刚移出一点按钮就消失"。重新进入时取消宽限计时。
    const hoverLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleMouseEnter = () => {
        if (hoverLeaveTimer.current) {
            clearTimeout(hoverLeaveTimer.current);
            hoverLeaveTimer.current = null;
        }
        startAnimationDebounced();
        setIsHovered(true);
    };

    const handleMouseLeave = () => {
        if (hoverLeaveTimer.current) clearTimeout(hoverLeaveTimer.current);
        hoverLeaveTimer.current = setTimeout(() => {
            setShowStatus(false);
            setIsHovered(false);
        }, 200);
    };

    const [isModalOpen, setIsModalOpen] = useState(false);

    const showModal = () => {
        setIsModalOpen(true);
    };


    const handleCancel = () => {
        setIsModalOpen(false);
    };

    const handleModeSwitch = () => {
        setDark(!isDark)
        setAnimation(isDark === true ? "sun" : "moon");
        localStorage.setItem("isDarkMode", JSON.stringify(!isDark));
        // 20260902：手动切换 = 访客意愿，写入 darkModeUserChoice 让 App.tsx 的
        // 自动夜间（23:00-6:00 分针检查）不再覆盖。此前只写 isDarkMode——夜间手动
        // 切浅色后 1 分钟内被自动逻辑顶回深色（用户报"突然变成夜间模式"）。
        // 20260908：choice 带主题日（06:00 为界）——让位跨日自动失效，防一次手动永久失去自动。
        // 20260914：只在夜间窗口内的切换才记意愿（见 theme.recordUserChoice）——白天切浅色
        // 不再否掉当晚自动夜间；白天切换会顺手清掉残留标记
        recordUserChoice(!isDark ? 'dark' : 'light');
        // 同步看板娘 agent 的全局状态：boot.js 监听 darkmode-change 更新 __darkMode，
        // 否则页面内手动切换后 current_darkmode 上报陈旧值，agent 感知只能靠对话记忆
        try { window.dispatchEvent(new CustomEvent('darkmode-change', { detail: !isDark })); } catch (e) {/* ignore */}
    };

    // Debounced search function
    const performSearch = async (keyword: string) => {
        if(!keyword.trim()) {
            setAgg(null);
            setSearchFailed(false);
            setActiveType('all');
            return;
        }
        setSearchFailed(false);
        setIsSearching(true);
        try {
            const res = await searchAll({ keyword: keyword });
            // **两层都要判**：HTTP 200 不代表业务成功（本站的信封是 `code`）。
            // 只看 `res.status === 200` 的话，`code: 500` 时会把 `data`（可能是空数组）
            // 当成结果——那正是 Talk 页 20261005 修过的那类"读不到被渲染成没有"。
            if(res.status === 200 && res.data?.code === 200) {
                setAgg(res.data.data);
                // 换了一次查询 ⇒ 筛选回到"全部"。否则上一次点的"只看说说"会留在原地，
                // 而用户看到的是"搜索框里换了词却什么都没有"。
                setActiveType('all');
            } else {
                setSearchFailed(true);
            }
        } catch(err) {
            setSearchFailed(true);
        } finally {
            setIsSearching(false);
        }
    };

    // Create a memoized debounced version
    const debouncedSearch = debounce(performSearch, 500);

    const onSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setSearchKeyword(val);
        // Clean results if empty
        if (!val.trim()) {
            setAgg(null);
            setSearchFailed(false);
            setActiveType('all');
            return;
        }
        debouncedSearch(val);
    };

    const handleSearch = async (e: any) => {
         if (e.key === 'Enter') {
             debouncedSearch.cancel(); // cancel pending
             performSearch(searchKeyword);
         }
    }

    /** 点一枚计数：选中它只看这一类；**再点已选中的那枚回到全部**（单选，用户拍板）。 */
    const toggleType = (t: SearchType) => {
        setActiveType((cur) => (cur === t ? 'all' : t));
    };

    /** 点一条结果：关掉弹窗，跳到那一条自己（四类的目标见 `aggregate.ts::hitTarget`）。 */
    const openHit = (item: AggregateHit) => {
        setIsModalOpen(false);
        // ⚠️ 绝对路径。原来这里是 `navigate('article/' + id)`（相对），而搜索框在**每一页**
        // 都有：在 `/article/3` 上再搜再点会拼成 `/article/article/5`。
        navigate(hitTarget(item));
    }

    /** 头像菜单里的「设置」= 打开那个大窗口（20260922）——**所有登录用户同一入口**。
     *  此前这个钮叫「心境」且一律 navigate('dashboard')，而 /dashboard 被 AuthRouter
     *  收成管理员专属：普通用户点它只会被弹回首页 + 一句"无权限访问后台"。
     *  20260922 第一轮改名「个人中心」（原名看不懂），第二轮用户要求改成**「设置」**
     *  （原话「右上角头像按钮个人中心文本改成设置」）——窗口标题仍是「个人中心」，
     *  因为它装的是收藏/留言/通知/信箱，不只是设置。 */
    const openUserCenter = () => {
        closePhoneBar();
        setCenterOpen(true);
    }

    /** 管理员的「后台」入口 = **双击头像**（20260923 用户要求：不要显式按钮）。
     *  上一版是头部一枚常驻「后台」钮 + 窄屏抽屉里一枚（20260922），用户改口要双击头像，
     *  两枚都撤了。入口藏起来不影响可达性：头像卡里的「设置」→ 窗口标题栏的「后台管理」还在。
     *  角色取自 JWT 自带的 role（`isAdminToken`，本地解码不请求后端）——它只决定"双击有没有反应"，
     *  真正的权限判定在 AuthRouter 与后端，前端不挂这个 handler 从来不是权限本身。 */
    const admin = isAdminToken(getToken());

    /** 双击头像进后台（非管理员不挂这个 handler，前台看不出任何差别） */
    const openDashboard = () => {
        closePhoneBar();
        navigate('/dashboard');
    }

    /** 头像右上角的未读红点（未读通知 + 未读站内信；数据见 components/UserCenter/unread.ts） */
    const unreadTotal = unreadCounts.total;
    const avatarWithDot = (node: ReactNode, size: number) => (
        <span className="avatarDotWrap" style={{width: size, height: size}}>
            {node}
            {isLogin === 1 && unreadTotal > 0 && (
                <span className="avatarDot" aria-label={`有 ${unreadTotal} 条未读`} />
            )}
        </span>
    )

    /* 结果列表：`'all'` 时四类按 `TYPE_ORDER` 拼成一条（同类相邻、组内仍是后端的相关度序）；
     * 选了某一类就只剩那一组。**筛选在渲染处做、不重新请求**——四类是一次搜回来的，
     * 点一枚计数再打一次网络，除了慢还会让"计数"与"列表"有机会对不上。 */
    const visibleHits: AggregateHit[] = agg
        ? (activeType === 'all' ? allHits(agg) : hitsOf(agg, activeType))
        : [];

    return (
        <>
            {phoneBarShow && <div className="phoneSideOverlay" onClick={() => setPhoneBarShow(false)} />}
        <header style={{display: 'flex', flexDirection: 'row', position: 'sticky', width: '100%', top: 0, zIndex: '999'}} className={isDark ? 'frontDark' : ''} onClick={() => { if (phoneBarShow) setPhoneBarShow(false); }}>
            <div className={`${phoneBarShow ? 'openBar' : ''} phoneSide`} onClick={(e) => e.stopPropagation()}>
                <div className="phoneBarContainer">
                    <div className="barLogo" onDoubleClick={admin ? openDashboard : undefined}>
                        {avatarWithDot(<Avatar src={viewerAvatar} size={100} />, 100)}
                         <div style={{ marginTop: "5px", display: "flex", justifyContent: "center", gap: "10px" }}>
                            {isLogin ? (
                                <>
                                <div className="theme-btn" onClick={openUserCenter}>设置</div>
                                <div className="theme-btn logout-btn" onClick={() => { closePhoneBar(); localStorage.removeItem('tokenKey'); setLogin(0); navigate('/'); window.dispatchEvent(new CustomEvent('auth-change')); }}>退出</div>
                                </>
                            ) : (
                                <div className="theme-btn" onClick={() => { closePhoneBar(); navigate("login"); }}>登录</div>
                            )}
                        </div>
                    </div>
                    <input className="mSearchInput" type="search" placeholder="搜索..." onClick={() => { closePhoneBar(); showModal(); }} readOnly />
                    <div className="barContent">
                        <ul className='oneBar'>
                            <li onClick={() => { closePhoneBar(); navigate('/'); }}><i className="iconfont icon-shouye4"
                                                                style={{fontSize: 30}}></i>首页
                            </li>
                            <li onClick={() => { closePhoneBar(); navigate('times'); }}><i className="iconfont icon-guidang3"
                                                                     style={{fontSize: 25}}></i>归档
                            </li>
                            <li onClick={() => setShowMobileCategory(!showMobileCategory)}>
                                <div style={{height: 30}}><i className="iconfont icon-fenlei"
                                         style={{fontSize: 30}}></i>分类</div>
                            </li>
                            {showMobileCategory && <ul className='twoBar'>
                                {categoryList.map((item: { categoryKey: Key | null | undefined; pathName: any; icon: any; categoryTitle: string | number | boolean | ReactElement | Iterable<ReactNode> | ReactPortal | null | undefined; }) => (
                                    <li key={item.categoryKey} onClick={() => { closePhoneBar(); navigate(`category/${item.pathName}`); }} style={{fontSize: 15}}><i className={`fa ${item.icon}`} aria-hidden="true" style={{verticalAlign: 'middle'}}></i>{item.categoryTitle}</li>
                                ))}
                            </ul>}
                            <li onClick={() => { closePhoneBar(); navigate('talk'); }}><i className="iconfont icon-riji"
                                                                    style={{fontSize: 30}}></i>说说
                            </li>
                            <li onClick={() => { closePhoneBar(); navigate('guestbook'); }}>{GuestbookIcon}留言板
                            </li>
                            <li onClick={() => { closePhoneBar(); navigate('about'); }}><i className="iconfont icon-leaf-01"
                                                                     style={{fontSize: 30}}></i>关于我
                            </li>
                        </ul>
                    </div>
                </div>
            </div>
            {/* 滚动态从**内联 style** 搬进了 sass 的 `.is-stuck`（20260930 五轮，
                `d85311e`）——20261001 六轮按主人第 6 条**做回原来的显示逻辑**：
                默认完全透明，悬停 / 已滚动两态才落 `rgba(0,0,0,0.66)` 深底
                （见 index.sass 里 `.headContainer` 之上那段说明）。

                「首屏未滚动时导航字压在淡彩纸上读不出来」这个老问题改从**字色**
                解决（透明态吃 `--washi-ink`，白天深墨紫、夜间浅色；落深底再统一
                换回浅色），不再靠一层常驻底色遮。

                原来的内联 `backdropFilter: blur(10px)` 不恢复：大面积模糊是
                GPU 成本，而首屏正是看板娘所在的那一屏（见 memory「后台 GPU 高于
                首页」）。深底用 0.66 的实色，观感等价、代价为零。

                第三条态 `.over-dark`（20261001，用户第 3 条）：文章详情页的横幅本身
                就是深的，透明态也读不出字 ⇒ 由路由判定，**永远**用深底那套浅字
                （只换字色，不加底色——底下的封面渐变已经把这一带压暗了）。 */}
            <div className={`headContainer${scrollHeight ? ' is-stuck' : ''}${overDarkBanner ? ' over-dark' : ''}`}>
                <div className="phoneBar">
                    {phoneBarShow ? <i className="iconfont icon-guanbi2" style={{
                            fontSize: 35,
                            marginLeft: 260,
                            cursor: 'pointer',
                            transition: '0.5s',
                            color: 'rgba(255,0,0,0.7)'
                        }} onClick={() => setPhoneBarShow(false)}></i> :
                        <i className="iconfont icon-bars"
                           style={{fontSize: 35, marginLeft: 10, cursor: 'pointer', transition: '0.5s'}}
                           onClick={() => setPhoneBarShow(true)}></i>}
                </div>
                <div className="webTitle" onClick={()=>navigate('/')}>
                    <h2><span className="firstTitle">{blogTitle}</span>Blog</h2>
                </div>
                <div className="headBar">
                    <ul>
                        <li onClick={() => navigate('/')}><i className="iconfont icon-shouye4"
                                                             style={{fontSize: 30}}></i>首页
                        </li>
                        <li onClick={() => navigate('times')}><i className="iconfont icon-guidang3"
                                                                 style={{fontSize: 25}}></i>归档
                        </li>
                        <li style={{position: 'relative'}} className='Category'><i
                            className="iconfont icon-fenlei" style={{fontSize: 30}}></i>分类
                            <div className='CategoryList'>
                                <i className="iconfont icon-Rrl_s_045" style={{
                                    fontSize: 40,
                                    position: 'absolute',
                                    left: 25,
                                    top: -29,
                                    color: 'rgba(0, 0, 0, 0.83)'
                                }}></i>
                                <ul>
                                    {categoryList.map((item: { categoryKey: Key | null | undefined; pathName: any; icon: any; categoryTitle: string | number | boolean | ReactElement | Iterable<ReactNode> | ReactPortal | null | undefined; }) => (
                                        <li key={item.categoryKey} onClick={() => navigate(`category/${item.pathName}`)}><i className={`iconfont ${item.icon}`} style={{fontSize: 20}}></i>{item.categoryTitle}</li>
                                    ))}
                                </ul>
                            </div>
                        </li>
                        <li onClick={()=>navigate('talk')}><i className="iconfont icon-liaotian1" style={{fontSize: 30}}></i>说说</li>
                        <li onClick={()=>navigate('guestbook')}>{GuestbookIcon}留言板</li>
                        <li onClick={()=>navigate('about')}><i className="iconfont icon-leaf-01" style={{fontSize: 30}}></i>关于我</li>
                    </ul>
                </div>

                <div className="homeRight">
                    <div onClick={showModal}><SearchButton2 /></div>
                    <div className={'homeSwitch'}><Switch handleModeSwitch={handleModeSwitch} isDarkMode={isDark}/></div>
                    <div className={`homeLogo ${isHovered&&'BigAvatar'}`} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}
                        onDoubleClick={admin ? openDashboard : undefined}>
                        {avatarWithDot(<Avatar src={viewerAvatar} size={40} />, 40)}
                        <div className="loginCard" style={{
                            display: (showStatus && isHovered) ? 'flex' : 'none',
                            flexDirection: 'column',
                            gap: '5px'
                        }}>
                            {isLogin ? (
                                <>
                                <div className="theme-btn" onClick={openUserCenter}>设置</div>
                                <div className="theme-btn logout-btn" onClick={() => { localStorage.removeItem('tokenKey'); setLogin(0); navigate('/'); window.dispatchEvent(new CustomEvent('auth-change')); }}>退出</div>
                                </>
                            ) : (
                                <div className="theme-btn" onClick={() => navigate("login")}>登录</div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            <ConfigProvider
                theme={{
                    token: {
                        boxShadow: 'none'
                    },
                    components: {
                        Modal: {
                            contentBg: 'transparent'
                        },
                    },
                }}
            >
                {/* `rootClassName` 是**必须的**：Modal 是 portal 到 body 的浮层，
                    不继承页面上的 `.frontDark` —— 结果行/计数栏这些新写的样式走
                    `var(--washi-*)`，夜间档只有挂上 `.washiDark` 才拿得到（见 index.css
                    里那三个类的注释）。不加的话夜间会白纸压白字。

                    ⚠️ 只加 `.washiDark`，**没有** `.washiModal`（本仓别处的浮层是
                    `washiModal washiDark` 两个一起加）。`.washiModal` 不是"主题开关"，
                    它是**公告弹窗那套皮**：不透明和纸底 + 顶上探出半截的胶带
                    （见 `AnnouncementModal/index.sass`）。这个搜索弹窗是刻意要透明的
                    （输入框直接压在遮罩的模糊图上，`ConfigProvider` 里也把
                    `Modal.contentBg` 设成了 transparent），套上那层皮等于换了个弹窗。 */}
                <Modal open={isModalOpen} onCancel={handleCancel} footer={null} width={'100vh'}
                       rootClassName={isDark ? 'washiDark' : undefined} >
                    <div style={{height:'80vh'}} className='searchModal'>
                        <div style={{
                                position: 'relative', 
                                width: '80%', 
                                margin: '0 auto',
                                display: 'flex',
                                alignItems: 'center'
                            }}>
                            <input 
                                type="search" 
                                className='searchModalInput' 
                                placeholder={'输入内容自动搜索...'}
                                value={searchKeyword}
                                onChange={onSearchChange}
                                onKeyDown={handleSearch}
                                style={{
                                    width: '100%',
                                    paddingRight: '40px',
                                    flex: 1
                                }}
                            />
                            <i className="iconfont icon-sousuo1" 
                               style={{
                                   position: 'absolute',
                                   right: '15px',
                                   
                                   top: '40%', transform: 'translateY(-50%)', marginBottom: '2px',
                                   fontSize: '25px',
                                   color: '#999',
                                   cursor: 'pointer',
                                   lineHeight: '1',
                                   display: 'flex',
                                   alignItems: 'center'
                               }}
                               onClick={() => performSearch(searchKeyword)}
                            ></i>
                        </div>
                        
                        <Card
                            style={{
                                width:'80%',
                                margin: '20px auto 0',
                                height: '85%',
                                overflowY:'auto',
                                background: 'transparent',
                                display: searchKeyword ? 'block' : 'none'
                            }}
                            title={
                                <div className='searchTitleRow'>
                                    {/* 用户原话里的写法：`搜索结果（命中数量）` 后面跟四类计数。
                                        括号用**全角**（与计数那几枚一致）。 */}
                                    <span className='searchTotal'>搜索结果（{agg?.total ?? 0}）</span>
                                    <span className='searchChips'>
                                        {TYPE_ORDER.map((t) => (
                                            <button
                                                key={t}
                                                type='button'
                                                className={'search-chip' + (activeType === t ? ' is-active' : '')}
                                                onClick={() => toggleType(t)}
                                            >
                                                {TYPE_LABEL[t]}（{agg?.counts?.[t] ?? 0}）
                                            </button>
                                        ))}
                                    </span>
                                    {isSearching && <span className='searchBusy'>搜索中...</span>}
                                </div>
                            }
                            bordered={false}
                        >
                             <div className="search-results-list">
                                {visibleHits.map((item: AggregateHit) => (
                                    <div
                                        // 四类混排，key 必须带上类型：文章 5 与评论 5 是两条东西
                                        key={`${item.type}-${item.key}`}
                                        onClick={() => openHit(item)}
                                        className="search-item"
                                    >
                                        <span className={'search-badge search-badge-' + item.type}>
                                            {TYPE_LABEL[item.type]}
                                        </span>
                                        <div className='search-item-main'>
                                            {/* 留言那一条**没有标题**（它那一列的 title 是印章，
                                                后端给的是空串）——空就别占一行 */}
                                            {item.title && <div className='search-item-title'>{item.title}</div>}
                                            <div className='search-item-snippet'>{item.snippet}</div>
                                            <div className='search-item-meta'>
                                                {[item.author, item.createTime].filter(Boolean).join(' · ')}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                                {/* 空态。三条互斥的说法，**别合并**：
                                    · 读失败 ≠ 没命中（故障不能说成"站内没有"）；
                                    · 选了某一类而那一类 0 命中，与"四类全空"也不是一回事。 */}
                                {!isSearching && searchFailed && (
                                    <div className='searchEmpty'>搜索失败，请稍后再试</div>
                                )}
                                {!isSearching && !searchFailed && agg && visibleHits.length === 0 && (
                                    <div className='searchEmpty'>
                                        {agg.total === 0
                                            ? '未找到相关内容'
                                            : `「${TYPE_LABEL[activeType as SearchType]}」里没有命中的内容`}
                                    </div>
                                )}
                             </div>
                        </Card>
                    </div>
                </Modal>
            </ConfigProvider>
            {animation !== '' && <MoonToSun status={animation} />}
            {/* 个人中心（20260922）：点「个人中心」打开的大窗口。挂在 header 里但门是 Modal
                portal 到 body 的，不受 header 的 sticky/transform 影响 */}
            <UserCenter open={centerOpen} onClose={() => setCenterOpen(false)} />
        </header>
        {/* 猫必须渲染在 header 之外(frontRoot 内、header 的兄弟节点):
            transform 动画在 sticky header 内时每帧迫使 header 图层子树重新栅格化(GPU 30%+);
            移到 header 外后为独立合成层,摆动成本趋近于零(实测 60fps 满帧)。
            且 frontRoot(isolation: isolate)上下文内 z-index 500 介于内容(≤100)与 header(999)之间,
            不再遮挡导航栏登录按钮。见 components/TopMao/index.sass 注释。 */}
        <TopMao currentScrollHeight={scrollHeight}/>
        </>
    );
};

export default Head;

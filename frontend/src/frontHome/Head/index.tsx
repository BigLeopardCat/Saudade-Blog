import {Avatar, Button, Card, ConfigProvider, Modal, message} from 'antd'
import './index.sass'
import {Key, ReactElement, ReactNode, ReactPortal, useEffect, useRef, useState} from "react";
import {useNavigate} from "react-router-dom";
import {debounce} from 'lodash';
import Switch from "../../components/Switch";
import SearchButton2 from "../../components/Buttons/SearchButton2";
import TopMao from "../../components/TopMao";
import {fetchCategories} from "../../store/components/categories.tsx";
import {useDispatch, useSelector} from "react-redux";
import {fetchTags} from "../../store/components/tags.tsx";
import {fetchSocial, fetchUserInfo} from "../../store/components/user.tsx";
import {fetchNoteList} from "../../store/components/note.tsx";
import { searchNotes } from "../../apis/NoteMethods.tsx";
import '../main.css'
import MoonToSun from "../MoonToSun";
import deleteToken from "../../apis/deleteToken.tsx";
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
    const [animation,setAnimation] = useState('');
    const categoryList = useSelector((state: any) => state.categories.categories)
    // 头部头像 = **当前访客**的头像（20260922 用户要求的三态：正常登录 / 退出登录但本机挂着
    // 账号 / 从没有过账号记录），不再是站点主人那张 `state.user.avatar`——那张图现在只用在
    // 文章页的作者署名处。三态的选择与缓存见 components/UserCenter/identity.ts。
    const viewerAvatar = useViewerAvatar()
    const blogTitle = useSelector((state:{user:{blogTitle: string}}) => state.user.blogTitle)

    // Search Logic
    const [searchKeyword, setSearchKeyword] = useState('');
    const [searchResults, setSearchResults] = useState<any[]>([]);
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
        // （autoload.js applyDarkMode 在状态实际变化时派发 moon-sun-animation）
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
        // 同步看板娘 agent 的全局状态：autoload.js 监听 darkmode-change 更新 __darkMode，
        // 否则页面内手动切换后 current_darkmode 上报陈旧值，agent 感知只能靠对话记忆
        try { window.dispatchEvent(new CustomEvent('darkmode-change', { detail: !isDark })); } catch (e) {/* ignore */}
    };

    // Debounced search function
    const performSearch = async (keyword: string) => {
        if(!keyword.trim()) {
            setSearchResults([]);
            return;
        }
        setIsSearching(true);
        try {
            const res = await searchNotes({ keyword: keyword });
            if(res.status === 200) {
                setSearchResults(res.data.data);
            }
        } catch(err) {
            // silent error or message
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
            setSearchResults([]);
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

    const toArticle = (id: number) => {
        setIsModalOpen(false);
        navigate(`article/${id}`);
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

    /** 管理员的独立「后台」入口（20260922 用户要求）。
     *  此前去后台的唯一路径是：头像卡 →「设置」→ 窗口标题栏里的「后台管理」——白点两次。
     *  用户原话「管理员一般不需要去个人中心而是后台，每次都要多点一次」⇒ 头部常驻一个直达钮
     *  （窄屏在抽屉里，因为 .homeRight 在 1200px 以下整块 display:none）。
     *  角色取自 JWT 自带的 role（`isAdminToken`，本地解码不请求后端）——它只决定"这个入口
     *  显不显示"，真正的权限判定在 AuthRouter 与后端，前端藏一个按钮从来不是权限本身。 */
    const admin = isAdminToken(getToken());

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

    return (
        <>
            {phoneBarShow && <div className="phoneSideOverlay" onClick={() => setPhoneBarShow(false)} />}
        <header style={{display: 'flex', flexDirection: 'row', position: 'sticky', width: '100%', top: 0, zIndex: '999'}} className={isDark ? 'frontDark' : ''} onClick={() => { if (phoneBarShow) setPhoneBarShow(false); }}>
            <div className={`${phoneBarShow ? 'openBar' : ''} phoneSide`} onClick={(e) => e.stopPropagation()}>
                <div className="phoneBarContainer">
                    <div className="barLogo">
                        {avatarWithDot(<Avatar src={viewerAvatar} size={100} />, 100)}
                         <div style={{ marginTop: "5px", display: "flex", justifyContent: "center", gap: "10px" }}>
                            {isLogin ? (
                                <>
                                <div className="theme-btn" onClick={openUserCenter}>设置</div>
                                {admin && <div className="theme-btn admin-btn" onClick={() => { closePhoneBar(); navigate('/dashboard'); }}>后台</div>}
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
            <div className="headContainer" style={{
                margin: scrollHeight ? 0 : '',
                borderRadius: scrollHeight ? 0 : '',
                background: scrollHeight ? 'rgba(0,0,0,0.66)' : '',
                width: scrollHeight ? '100%' : '',
                backdropFilter: scrollHeight ? 'blur(10px)' : ''
            }}>
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
                    {admin && (
                        <div className="theme-btn admin-btn homeAdminBtn" onClick={() => navigate('/dashboard')}>后台</div>
                    )}
                    <div className={`homeLogo ${isHovered&&'BigAvatar'}`} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
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
                <Modal open={isModalOpen} onCancel={handleCancel} footer={null} width={'100vh'} >
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
                                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: isDark ? '#fff' : '#333'}}>
                                    <span style={{
                                        background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.7)',
                                        padding: '4px 8px',
                                        borderRadius: '4px',
                                        fontSize: '14px',
                                        backdropFilter: 'blur(4px)'
                                    }}>
                                        搜索结果 ({searchResults.length})
                                    </span>
                                    {isSearching && <span style={{fontSize: '12px', opacity: 0.7}}>搜索中...</span>}
                                </div>
                            } 
                            bordered={false}
                        >
                             <div className="search-results-list">
                                {searchResults.map((item: any) => (
                                    <div 
                                        key={item.key || item.id} 
                                        onClick={() => toArticle(item.key || item.id)}
                                        className="search-item"
                                        style={{
                                            padding: '12px',
                                            marginBottom: '8px',
                                            borderRadius: '6px',
                                            cursor: 'pointer',
                                            background: isDark ? '#333' : '#f5f5f5',
                                            color: isDark ? '#fff' : '#333',
                                            transition: 'all 0.3s',
                                            border: isDark ? '1px solid #444' : 'none'
                                        }}
                                    >
                                        <div style={{fontWeight: 'bold', fontSize: '16px', marginBottom: '4px'}}>
                                            {item.noteTitle || item.title}
                                        </div>
                                        <div style={{fontSize: '13px', opacity: 0.8, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden'}}>
                                            {item.description || item.content?.substring(0, 100)}
                                        </div>
                                    </div>
                                ))}
                                {searchResults.length === 0 && !isSearching && (
                                    <div style={{textAlign: 'center', color: isDark ? '#888' : '#999', padding: '20px'}}>
                                        未找到相关文章
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

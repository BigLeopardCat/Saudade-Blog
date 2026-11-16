import {Avatar, ConfigProvider, Modal, theme as antTheme} from 'antd'
import './index.sass'
import {Key, ReactElement, ReactNode, ReactPortal, useEffect, useRef, useState} from "react";
import {useLocation, useNavigate} from "react-router-dom";
import {debounce} from 'lodash';
import ScenePicker from "../../components/ScenePicker";
import SceneIcon from "../../components/SceneIcon";

import TopMao from "../../components/TopMao";
import {fetchCategories} from "../../store/components/categories.tsx";
import {useDispatch, useSelector} from "react-redux";
import {fetchTags} from "../../store/components/tags.tsx";
import {fetchSocial, fetchUserInfo} from "../../store/components/user.tsx";
import AggregateSearch from '../../components/AggregateSearch';
import { hitTarget } from './aggregate';
import type { AggregateTarget } from './aggregate';
import '../main.css'
import MoonToSun from "../MoonToSun";
import { recordUserChoice } from "../../theme";
import UserCenter from "../../components/UserCenter";
import { useUnread } from "../../components/UserCenter/unread";
import { useViewerAvatar } from "../../components/UserCenter/identity";
import getToken from "../../apis/getToken.tsx";
import { isAdminToken } from "../../utils/auth.ts";

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
    const [centerOpen, setCenterOpen] = useState(false)
    const { counts: unreadCounts } = useUnread(isLogin === 1)
    const [showMobileCategory, setShowMobileCategory] = useState(false);
    const dispatch = useDispatch()
    const navigate = useNavigate();
    const overDarkBanner = useLocation().pathname.startsWith('/article/');
    const [animation,setAnimation] = useState('');
    useEffect(() => {
        if (!animation) return;
        const timer = setTimeout(() => setAnimation(''), 1100);
        return () => clearTimeout(timer);
    }, [animation]);
    const categoryList = useSelector((state: any) => state.categories.categories)
    const viewerAvatar = useViewerAvatar()
    const blogTitle = useSelector((state:{user:{blogTitle: string}}) => state.user.blogTitle)

    useEffect(() => {
        dispatch<any>(fetchCategories())
        dispatch<any>(fetchTags())
        dispatch<any>(fetchUserInfo())
        dispatch<any>(fetchSocial())
        const status = localStorage.getItem('tokenKey')
        if (status !== null) {
            setLogin(1)
        }

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

    // A drawer opened on mobile must not leave its overlay/scroll lock on desktop.
    useEffect(() => {
        const narrow = window.matchMedia('(max-width: 1200px)');
        const closeOnDesktop = () => {
            if (!narrow.matches) { setPhoneBarShow(false); setShowMobileCategory(false); }
        };
        narrow.addEventListener('change', closeOnDesktop);
        return () => narrow.removeEventListener('change', closeOnDesktop);
    }, []);

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
        recordUserChoice(!isDark ? 'dark' : 'light');
        // 同步看板娘 agent 的全局状态：boot.js 监听 darkmode-change 更新 __darkMode，
        // 否则页面内手动切换后 current_darkmode 上报陈旧值，agent 感知只能靠对话记忆
        try { window.dispatchEvent(new CustomEvent('darkmode-change', { detail: !isDark })); } catch {/* ignore */}
    };

    const openHit = (item: AggregateTarget) => {
        setIsModalOpen(false);
        navigate(hitTarget(item));
    };

    const openUserCenter = () => {
        closePhoneBar();
        setCenterOpen(true);
    }

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

    return (
        <>
            {phoneBarShow && <div className="phoneSideOverlay" onClick={() => setPhoneBarShow(false)} />}
        <header style={{display: 'flex', flexDirection: 'row', position: 'sticky', width: '100%', top: 0, zIndex: '999'}} className={isDark ? 'frontDark' : ''} onClick={() => { if (phoneBarShow) setPhoneBarShow(false); }}>
            <div id="public-navigation-drawer" aria-hidden={!phoneBarShow} className={`${phoneBarShow ? 'openBar' : ''} phoneSide`} onClick={(e) => e.stopPropagation()}>
                <div className="phoneBarContainer">
                    {phoneBarShow && <button type="button" className="sceneTool drawerClose" aria-label="关闭导航菜单" onClick={closePhoneBar}><SceneIcon name="close"/></button>}
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
                            <li onClick={() => { closePhoneBar(); navigate('/'); }}><SceneIcon name="home"/>首页
                            </li>
                            <li onClick={() => { closePhoneBar(); navigate('times'); }}><SceneIcon name="archive"/>归档
                            </li>
                            <li onClick={() => setShowMobileCategory(!showMobileCategory)}>
                                <div style={{height: 30}}><SceneIcon name="category"/>分类</div>
                            </li>
                            {showMobileCategory && <ul className='twoBar'>
                                {categoryList.map((item: { categoryKey: Key | null | undefined; pathName: any; icon: any; categoryTitle: string | number | boolean | ReactElement | Iterable<ReactNode> | ReactPortal | null | undefined; }) => (
                                    <li key={item.categoryKey} onClick={() => { closePhoneBar(); navigate(`category/${item.pathName}`); }} style={{fontSize: 15}}><i className={`fa ${item.icon}`} aria-hidden="true" style={{verticalAlign: 'middle'}}></i>{item.categoryTitle}</li>
                                ))}
                            </ul>}
                            <li onClick={() => { closePhoneBar(); navigate('talk'); }}><SceneIcon name="message"/>说说
                            </li>
                            <li onClick={() => { closePhoneBar(); navigate('guestbook'); }}><SceneIcon name="book"/>留言板
                            </li>
                            <li onClick={() => { closePhoneBar(); navigate('about'); }}><SceneIcon name="leaf"/>关于我
                            </li>
                        </ul>
                    </div>
                </div>
            </div>
            <div className={`headContainer${scrollHeight ? ' is-stuck' : ''}${overDarkBanner ? ' over-dark' : ''}`}>
                <div className="phoneBar">
                    <button type="button" aria-label="打开导航菜单" aria-expanded={phoneBarShow} aria-controls="public-navigation-drawer" className="sceneTool" onClick={() => setPhoneBarShow(value => !value)}><SceneIcon name={phoneBarShow ? 'close' : 'menu'}/></button>
                </div>
                <div className="webTitle" onClick={()=>navigate('/')}>
                    <h2><span className="firstTitle">{blogTitle}</span>Blog</h2>
                </div>
                <div className="headBar">
                    <ul>
                        <li onClick={() => navigate('/')}><SceneIcon name="home"/>首页
                        </li>
                        <li onClick={() => navigate('times')}><SceneIcon name="archive"/>归档
                        </li>
                        <li style={{position: 'relative'}} className='Category'><SceneIcon name="category"/>分类
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
                        <li onClick={()=>navigate('talk')}><SceneIcon name="message"/>说说</li>
                        <li onClick={()=>navigate('guestbook')}><SceneIcon name="book"/>留言板</li>
                        <li onClick={()=>navigate('about')}><SceneIcon name="leaf"/>关于我</li>
                    </ul>
                </div>

                <div className="homeRight">
                    <button type="button" className="sceneTool" aria-label="搜索" title="搜索" onClick={showModal}><SceneIcon name="search"/></button>
                    <ScenePicker dark={isDark}/>
                    <button type="button" className="sceneTool homeSwitch" aria-label={isDark ? "切换日间模式" : "切换夜间模式"} title={isDark ? "切换日间模式" : "切换夜间模式"} aria-pressed={isDark} onClick={handleModeSwitch}><SceneIcon name={isDark ? "sun" : "moon"}/></button>
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
                    algorithm: isDark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
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
                <Modal open={isModalOpen} onCancel={handleCancel} footer={null} width={'100vh'}
                       rootClassName={isDark ? 'aggregateSearchModal washiDark' : 'aggregateSearchModal'}
                       classNames={{ mask: 'search-mask' }} >
                    <div style={{height:'80vh'}} className='searchModal'>
                        {isModalOpen && <AggregateSearch onOpen={openHit} />}
                    </div>
                </Modal>
            </ConfigProvider>
            {animation !== '' && <MoonToSun status={animation} />}
            <UserCenter open={centerOpen} onClose={() => setCenterOpen(false)} />
        </header>
        <TopMao currentScrollHeight={scrollHeight}/>
        </>
    );
};

export default Head;

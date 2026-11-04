import {Avatar, ConfigProvider, Modal, theme as antTheme} from 'antd'
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
    const [centerOpen, setCenterOpen] = useState(false)
    const { counts: unreadCounts } = useUnread(isLogin === 1)
    const [showMobileCategory, setShowMobileCategory] = useState(false);
    const dispatch = useDispatch()
    const navigate = useNavigate();
    const overDarkBanner = useLocation().pathname.startsWith('/article/');
    const [animation,setAnimation] = useState('');
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
            <div className={`headContainer${scrollHeight ? ' is-stuck' : ''}${overDarkBanner ? ' over-dark' : ''}`}>
                <div className="phoneBar">
                    {phoneBarShow ? <button type="button" aria-label="关闭导航菜单" aria-expanded="true" aria-controls="public-navigation-drawer" className="iconfont icon-guanbi2" style={{
                            background: 'transparent', border: 0, padding: 0, minWidth: 36, minHeight: 44,
                            fontSize: 35,
                            marginLeft: 260,
                            cursor: 'pointer',
                            transition: '0.5s',
                            color: 'rgba(255,0,0,0.7)'
                        }} onClick={() => setPhoneBarShow(false)} /> :
                        <button type="button" aria-label="打开导航菜单" aria-expanded="false" aria-controls="public-navigation-drawer" className="iconfont icon-bars"
                           style={{background: 'transparent', border: 0, padding: 0, minWidth: 36, minHeight: 44, fontSize: 35, marginLeft: 10, cursor: 'pointer', transition: '0.5s'}}
                           onClick={() => setPhoneBarShow(true)} />}
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

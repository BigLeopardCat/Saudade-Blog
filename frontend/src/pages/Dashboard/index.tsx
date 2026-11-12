import SeoHelmet from '../../components/SeoHelmet';
import {useEffect, useRef, useState, type ReactNode} from 'react';
import './index.css';
import {Outlet, useLocation, useNavigate} from "react-router-dom";
import {Card, Spin, Avatar, ConfigProvider, message, theme as antdTheme} from "antd";
import MainContext from "../../components/conText.tsx";
import Switch from "../../components/Switch";
import SettingButton from "../../components/Buttons/SettingButton";
import {useDispatch, useSelector} from "react-redux";
import {fetchUserInfo, fetchSocial} from "../../store/components/user.tsx";
import UserState from "../../interface/UserState";
import {fetchCategories} from "../../store/components/categories.tsx";
import {fetchTags} from "../../store/components/tags.tsx";
import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import { readDarkMode, recordUserChoice } from "../../theme";
import Live2dAgent from "../../components/Live2dAgent";
import { useViewerProfile } from "../../components/UserCenter/identity";
import AnnouncementModal from "../../components/AnnouncementModal";

const NAV_FILL_SVG: Record<string, { viewBox: string; body: ReactNode }> = {
    'svg-announcement': {
        viewBox: '0 0 1024 1024',
        body: (
            <path d="M61.139079 310.392465q0-26.58137 18.913667-44.983856t45.495036-18.402487l64.408703 0 0 287.283263-64.408703 0q-26.58137 0-45.495036-18.402487t-18.913667-44.983856l0-160.510577zM776.791335 46.623491q43.961496-41.916775 79.744109-46.006216t63.386343 18.913667 47.028577 67.475784 31.693171 99.168955 18.402487 114.504361 6.134162 113.993181-7.667703 108.370199-22.491928 101.724856-34.760252 83.32237-44.472676 53.162739-52.651559 12.268324-58.785721-39.872054q-29.648451-34.760252-80.255289-57.763361t-110.414919-38.849694-121.149703-25.559009-112.45964-17.380126-85.367091-14.824225-38.338514-17.380126l0-319.998794q4.089441-14.313045 32.204352-23.514288t71.565226-17.380126 98.146595-17.891306 111.43728-26.58137 110.9261-42.939135 98.146595-66.964604zM408.741603 673.330395q5.111802 12.268324 12.268324 26.58137 6.134162 13.290685 16.357766 30.670811t24.536649 37.827334q17.380126 24.536649 35.271433 51.629198t27.09255 49.073298 5.622982 36.293793-29.13727 14.313045l-58.274541 0q-20.447207 0-37.827334-7.667703t-33.226712-23.514288-32.715532-40.383234-36.293793-58.274541q-23.514288-38.849694-32.715532-67.986964t-12.268324-48.562117q-4.089441-22.491928 0-38.849694 8.178883 1.02236 19.424847 4.089441 9.201243 2.044721 22.491928 5.111802t30.670811 6.134162q17.380126 4.089441 31.181991 7.667703t25.047829 7.667703q12.268324 4.089441 22.491928 8.178883z" />
        ),
    },
    'svg-user-list': {
        viewBox: '0 0 1024 1024',
        body: (
            <path d="M144 192c26.24 0 48 21.76 48 48s-21.76 48-48 48H48C21.76 288 0 266.24 0 240S21.76 192 48 192h96z m452.48 64c-30.08 0-16.64 10.88-30.08 12.16-12.16 0-38.4 3.2-49.28 8.96-53.12 28.16-61.44 69.76-60.16 125.44 0 10.24-10.88 5.12-10.88 21.12 0 15.36 5.76 46.72 21.76 67.84 16.64 20.48 21.76 25.6 32.64 41.6 11.52 15.36 16.64 32.64 16.64 46.72 0 52.48-92.16 56.32-145.28 88.96l-5.76 3.84A53.696 53.696 0 0 0 400 768h365.44a53.76 53.76 0 0 0 28.16-99.2l-8.32-4.48c-53.76-28.8-136.96-34.56-136.96-84.48 0-14.08 5.76-31.36 16.64-46.72s16.64-21.12 33.28-42.24 21.76-51.84 21.76-67.84c0-15.36-10.88-10.24-10.88-21.12 0-10.24-1.92-53.76-21.76-93.44-19.2-39.68-60.8-52.48-90.88-52.48z m-452.48 448c26.24 0 48 21.76 48 48s-21.76 48-48 48H48c-26.24 0-48-21.76-48-48S21.76 704 48 704h96zM896 0c70.4 0 128 57.6 128 128v768c0 70.4-57.6 128-128 128H256c-70.4 0-128-57.6-128-128v-32h16c62.08 0 112-49.92 112-112S206.08 640 144 640H128V352h16C206.08 352 256 302.08 256 240S206.08 128 144 128H128c0-70.4 57.6-128 128-128h640z" />
        ),
    },
};

const WASHI_THEME = {
    light: {
        colorPrimary: '#d94f9a',                            // --washi-pink-deep
        colorBgContainer: '#fffdfa',                        // --washi-paper
        colorBgElevated: '#fffdfa',                         // --washi-paper（浮层：Modal/下拉/气泡）
        colorText: '#4a3550',                               // --washi-ink
        colorTextSecondary: '#7c6584',                      // --washi-ink-2
        colorTextTertiary: '#a08ba8',                       // --washi-ink-3
        colorBorder: 'rgba(198, 152, 192, 0.42)',           // --washi-line
        colorBorderSecondary: 'rgba(198, 152, 192, 0.22)',  // --washi-line-2
    },
    dark: {
        colorPrimary: '#ff8ec7',                            // --washi-pink-deep（夜间档）
        colorBgContainer: '#2a2338',                        // --washi-paper-2（夜间档）
        colorBgElevated: '#2a2338',
        colorText: '#f3e8f6',                               // --washi-ink（夜间档）
        colorTextSecondary: '#c9b8d3',                      // --washi-ink-2（夜间档）
        colorTextTertiary: '#9a8aa5',                       // --washi-ink-3（夜间档）
        colorBorder: 'rgba(255, 255, 255, 0.16)',           // --washi-line（夜间档）
        colorBorderSecondary: 'rgba(255, 255, 255, 0.08)',  // --washi-line-2（夜间档）
        /* 夜间亮粉按钮使用深色文字，保持可读对比度。 */
        colorTextLightSolid: '#3a2340',
    },
    common: {
        borderRadius: 8,
        /* Ant Design 的 lg、外壳 CSS 和 matchMedia 使用相同的 1024px 断点。 */
        screenLG: 1024,
    },
};

const Dashboard = () => {
    const navigate = useNavigate();
    const { pathname } = useLocation();
    const [tier, setTier] = useState<0 | 1 | 2>(1);
    const [isDarkMode, setDarkMode] = useState(false);
    const [loading, setLoading] = useState(false);
    const [searchVal, setSearchVal] = useState('');
    const [navOpen, setNavOpen] = useState(false);
    const dispatch = useDispatch();
    const siteName = useSelector((state: { user: UserState }) => state.user.name);
    const viewer = useViewerProfile();
    useEffect(() => {
        dispatch<any>(fetchUserInfo())
        dispatch<any>(fetchSocial())
        dispatch<any>(fetchCategories())
        dispatch<any>(fetchTags())
        setLoading(true);
        setDarkMode(readDarkMode());
        const onDarkModeChange = (e: Event) => setDarkMode(!!(e as CustomEvent).detail);
        window.addEventListener('darkmode-change', onDarkModeChange);
        return () => window.removeEventListener('darkmode-change', onDarkModeChange);
    },[])

    /* ① 跨断点一律关抽屉：进也关、出也关（否则拖动窗口变宽后，`nav-open` 会留在台面上，
          而那个类名在桌面档没有样式——状态与画面长期不一致，下次变窄会突兀地弹开）。 */
    useEffect(() => {
        const mq = window.matchMedia('(max-width:1024px)');
        const onChange = () => setNavOpen(false);
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, []);

    /* ② 路由一变就关抽屉（覆盖图库页「R2 配置」那种不经侧栏的程序化跳转）。
          ⚠️ 它**盖不住「点已选中的那一项」**——pathname 没变、effect 不重跑，
          所以每个 li 的 onClick 里另有一句 setNavOpen(false)，两条缺一不可。 */
    useEffect(() => { setNavOpen(false); }, [pathname]);

    /* ③ Esc 关抽屉。只在开着的时候挂监听，关着时不占键盘。 */
    useEffect(() => {
        if (!navOpen) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [navOpen]);

    useEffect(() => {
        document.body.classList.add('dash-skin');
        return () => {
            document.body.classList.remove('dash-skin', 'washiDark');
        };
    }, []);

    useEffect(() => {
        document.body.classList.toggle('washiDark', isDarkMode);
    }, [isDarkMode]);

    /* 那颗 `.toggle`（圆钮里的箭头）：展开态显 ◀、其余显 ▶，所以它的动作是
       「88 ⇄ 250」，而极简档（0）按一下先回到 88 —— 与箭头指的方向一致。 */
    const handleToggleClick = () => {
        setTier(t => (t === 1 ? 2 : 1));
    };

    /* 第二颗圆钮（只在 88 档出现）：◀ = 再收一档到极简。 */
    const handleCollapseClick = () => {
        setTier(0);
    };

    /* 点搜索框要能打字 ⇒ 把它所在的侧栏展开（对应 `setShellClosed(false)` 的语义：
       是"展开到 250"，不是"收起"）。 */
    const handleSearchClick = () => {
        setTier(2);
    };

    /* 点侧栏里的任一项就关抽屉（窄屏）。桌面下 `navOpen` 恒假 ⇒ 这只是一句无副作用的
       setState。**注意它必须挂在 li 上而不是靠 `[pathname]` 那条 effect**：点"当前已在
       的那一项"时 pathname 不变，effect 不重跑，抽屉会赖着不走。 */
    const closeNav = () => setNavOpen(false);

    const handleModeSwitch = () => {
        setDarkMode(!isDarkMode);
        localStorage.setItem("isDarkMode", JSON.stringify(!isDarkMode));
        recordUserChoice(!isDarkMode ? 'dark' : 'light');
        try { window.dispatchEvent(new CustomEvent('darkmode-change', { detail: !isDarkMode })); } catch { /* ignore */ }
    };
    const sidebar = [
        {
            index: 1,
            name: '主页',
            icon: 'icon-shouyefill',
            to: '',
            active: false
        },
        {
            index: 2,
            name: '笔记',
            icon: 'icon-bianji2',
            to: 'notes',
            active: false,
            children: [
                {
                    index: 201,
                    name: '全部文章',
                    to: 'allnotes',
                },
                {
                    index: 202,
                    name: '编辑文章',
                    to: 'newnote',
                },{
                    index: 203,
                    name: '全部分类',
                    to: 'allcategorize',
                },{
                    index: 204,
                    name: '全部标签',
                    to: 'alltags',
                },
            ]
        },
        {
            index: 3,
            name: '说说',
            icon: 'icon-pinglun2',
            to: 'comments',
            active: false
        },
        {
            index: 4,
            name: '图库',
            icon: 'icon-xiangce',
            to: 'albums',
            active: false
        },
        {
            index: 5,
            name: '公告',
            icon: 'svg-announcement',
            to: 'announcement',
            active: false
        },
        {
            index: 6,
            name: '用户管理',
            icon: 'svg-user-list',
            to: 'users',
            active: false
        },
        {
            index: 7,
            name: '数据板',
            icon: 'icon-zhexiantu',
            to: 'analytics',
            active: false
        }
    ]

    const seg = pathname.replace(/^\/dashboard\/?/, '').split('/')[0];
    const activeIndex = seg === 'usercontrol' ? 8 : (sidebar.find(i => i.to === seg)?.index ?? 1);
    const fullScreenRef = useRef<HTMLDivElement>(null);
    const toggleFullScreen = async () => {
        try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else await fullScreenRef.current?.requestFullscreen();
        } catch {
            message.warning('当前浏览器未能切换全屏');
        }
    };

    return (
        /* 后台是独立顶层路由，主题由此壳提供；页内 ConfigProvider 与父配置合并。 */
        <ConfigProvider modal={{centered:true, classNames:{
            content:"dashboard-dialog-content", body:"dashboard-dialog-body",
            header:"dashboard-dialog-header", footer:"dashboard-dialog-footer",
        }}} theme={{
            algorithm: isDarkMode ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
            token: {
                ...(isDarkMode ? WASHI_THEME.dark : WASHI_THEME.light),
                ...WASHI_THEME.common,
            },
        }}>
        <SeoHelmet title="后台管理" noindex />
        <div className={`contain dashboardShell ${isDarkMode ? 'dark' : ''}`}>
            {!loading ? (
                <div className="loading-overlay">
                    <Spin tip="Loading..." className="loading">
                    </Spin>
                </div>
            ) : (
                <>

                    <div className={`content ${isDarkMode ? 'contentDark' : ''}`} ref={fullScreenRef}>
                        <button type="button" className="pad-menu-btn" aria-label="打开导航"
                                aria-expanded={navOpen} onClick={() => setNavOpen(true)}>
                            <i className="iconfont icon-bars" aria-hidden="true"></i>
                        </button>

                        <div className={`nav-backdrop${navOpen ? ' show' : ''}`}
                             aria-hidden="true" onClick={closeNav} />

                        <div className={`shell ${tier === 0 ? 'mini' : tier === 1 ? 'close' : ''} ${isDarkMode ? 'dark' : ''} slider${navOpen ? ' nav-open' : ''}`}>
                            <nav className={`shell ${tier === 0 ? 'mini' : tier === 1 ? 'close' : ''} ${isDarkMode ? 'dark' : '' } shell-nav`}>
                                <header>
                                    <div className="image-text">
                        <span className="image">
                            <Avatar src={viewer.avatar} size={45} />
                        </span>
                                        <div className="text logo-text">
                                            <span className="name">
                                                {viewer.nickname || siteName}
                                            </span>
                                        </div>
                                    </div>
                                    <i className="iconfont icon-iconfonticonfontarrowright toggle" onClick={handleToggleClick} style={{fontSize: 20}}></i>
                                    <i className="iconfont icon-iconfonticonfontarrowright toggle-collapse" onClick={handleCollapseClick} style={{fontSize: 20}}></i>
                                </header>

                                <div className="menu-bar">
                                    <div className="menu">
                                        <li className="search-box" onClick={handleSearchClick}>
                                            <i className="iconfont icon-sousuo1 icon"></i>
                                            <input type="text" placeholder="search..." value={searchVal} onChange={(e) => setSearchVal(e.target.value)} onKeyDown={(e) => {if(e.key === "Enter") { navigate('/dashboard/notes?kw=' + encodeURIComponent(searchVal.trim())) }}} />
                                        </li>

                                        <ul className="menu-links">
                                            {sidebar.map(item => {
                                                const fillSvg = NAV_FILL_SVG[item.icon];
                                                return (
                                                <li className={`nav-links ${activeIndex === item.index ? 'nav_select' : ''}`}
                                                    onClick={() => {
                                                        navigate(item.to ? `/dashboard/${item.to}` : '/dashboard')
                                                        closeNav()
                                                    }} key={item.index}>
                                                    {fillSvg ? (
                                                        /* 填充型 SVG：置 .icon 槽内，fill=currentColor 随 hover/选中变色 */
                                                        <span className="icon">
                                                            <svg viewBox={fillSvg.viewBox} className="nav-svg"
                                                                 fill="currentColor" aria-hidden="true">
                                                                {fillSvg.body}
                                                            </svg>
                                                        </span>
                                                    ) : (
                                                        <i className={`${item.icon.startsWith("fa-") ? "fa " : "iconfont"} ${item.icon} icon`}></i>
                                                    )}
                                                    <span className="text nac-text">{item.name}</span>
                                                </li>
                                                );
                                            })}
                                        </ul>
                                    </div>

                                    <div className="bottom-content">
                                        <li className={`nav-links ${activeIndex === 8 ? 'nav_select' : ''}`}
                                            onClick={() => {
                                                navigate('/dashboard/usercontrol');
                                                closeNav()
                                            }}>
                                            <i className="iconfont icon-iconfontcog icon"></i>
                                            <span className="text nac-text">站点设置</span>
                                        </li>

                                        <li className="nav-links" onClick={() => { navigate('/'); closeNav(); }}>
                                            <i className="iconfont icon-tuichu icon"></i>
                                            <span className="text nac-text">返回首页</span>
                                        </li>

                                        <li className="mode">
                                            <div className="sun-moon">
                                                {isDarkMode?<i className={`iconfont icon-taiyang1 icon ${isDarkMode ? 'moon' : 'sun'}`}></i>:
                                                    <i className={`iconfont icon-moonyueliang icon ${isDarkMode ? 'sun' : 'moon'}`}></i>}
                                            </div>
                                            <span className="mode-text text">{isDarkMode ? '夜间模式' : '白日模式'}</span>
                                            <div className="toggle-switch">
                                                <Switch handleModeSwitch={handleModeSwitch} isDarkMode={isDarkMode}/>
                                            </div>

                                        </li>
                                    </div>
                                </div>
                            </nav>
                        </div>
                        <Card className={`Card ${isDarkMode ? 'CardDark' : ''}`}>
                            <MainContext.Provider value={isDarkMode.toString()}>
                                <main className="dashboardPage" aria-label="后台内容" tabIndex={0}>
                                    <Outlet />
                                </main>
                            </MainContext.Provider>
                        </Card>

                        <div className='setting_btn' onClick={()=>toggleFullScreen()}>
                            <SettingButton />
                        </div>
                    </div>
                </>
                )}

            <Live2dAgent />
            <AnnouncementModal />
        </div>
        </ConfigProvider>
    );
};

export default Dashboard;

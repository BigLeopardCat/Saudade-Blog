import {useEffect, useRef, useState} from 'react';
import './index.css';
// import '../../assets/font/iconfont.js';
// import '../../assets/font/iconfont.css';
import {Outlet, useNavigate} from "react-router-dom";
import {Card, Spin, Avatar} from "antd";
import MainContext from "../../components/conText.tsx";
import Switch from "../../components/Switch";
import SettingButton from "../../components/Buttons/SettingButton";
import {useDispatch, useSelector} from "react-redux";
import {fetchUserInfo} from "../../store/components/user.tsx";
import UserState from "../../interface/UserState";
import {fetchCategories} from "../../store/components/categories.tsx";
import {fetchTags} from "../../store/components/tags.tsx";
import {fetchNoteList} from "../../store/components/note.tsx";
import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import { readDarkMode, recordUserChoice } from "../../theme";
import Live2dAgent from "../../components/Live2dAgent"; // 后台是顶层路由（不在 App 布局里），看板娘得自己挂


const Dashboard = () => {
    //hooks区域
    const navigate = useNavigate();
    const [SelectCurrent,setSelectCurrent] = useState(1)
    const [isShellClosed, setShellClosed] = useState(true);
    const [isDarkMode, setDarkMode] = useState(false);
    const [loading, setLoading] = useState(false);
    const [searchVal, setSearchVal] = useState('');
    const dispatch = useDispatch();
    const avatar = useSelector((state: { user: UserState }) => state.user.avatar);
    const name = useSelector((state: { user: UserState }) => state.user.name);

    //初始渲染
    useEffect(() => {
        dispatch<any>(fetchUserInfo())
        dispatch<any>(fetchCategories())
        dispatch<any>(fetchTags())
        dispatch<any>(fetchNoteList(true))
        // hash → 侧栏高亮索引（与下方 sidebar 数组 index 一一对应；
        // 底部导航「站点设置」等无对应 menu 项不映射，回落 1）
        const HASH_INDEX: Record<string, number> = {
            '#/dashboard': 1,
            '#/dashboard/comments': 3,
            '#/dashboard/albums': 4,
            '#/dashboard/announcement': 5,
            '#/dashboard/users': 6,
            '#/dashboard/analytics': 7,
        };
        const currentHashCode =
            location.hash.startsWith('#/dashboard/notes') ? 2 : (HASH_INDEX[location.hash] ?? 1);
        setSelectCurrent(currentHashCode)
        setLoading(true);
        setDarkMode(readDarkMode());
    },[])

    //回调函数区域

    const handleToggleClick = () => {
        setShellClosed(!isShellClosed);
    };

    const handleSearchClick = () => {
        setShellClosed(false);
    };

    const handleModeSwitch = () => {
        setDarkMode(!isDarkMode);
        localStorage.setItem("isDarkMode", JSON.stringify(!isDarkMode));
        // 同 Head：手动切换记入 darkModeUserChoice（含主题日，跨日自动恢复）
        recordUserChoice(!isDarkMode ? 'dark' : 'light');
    };

    // 导航栏数据
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
            icon: 'fa-bullhorn',
            to: 'announcement',
            active: false
        },
        {
            index: 6,
            name: '用户管理',
            // gear+person 双形 SVG（20260905：账号管理 + 评论管理合并入口，用户拍板）
            icon: 'svg-user-cog',
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


    //全屏
    const fullScreenRef = useRef<HTMLDivElement>(null);
    const [isFullScreen, setIsFullScreen] = useState<boolean>(false);

    const toggleFullScreen = () => {
        const elem = fullScreenRef.current;

        if (!isFullScreen) {
            if (elem?.requestFullscreen) {
                elem.requestFullscreen();
            } else { // @ts-ignore
                if (elem?.mozRequestFullScreen) { /* Firefox */
                                // @ts-ignore
                    elem.mozRequestFullScreen();
                            } else { // @ts-ignore
                    if (elem?.webkitRequestFullscreen) { /* Chrome, Safari & Opera */
                                                    // @ts-ignore
                        elem.webkitRequestFullscreen();
                                                } else { // @ts-ignore
                        if (elem?.msRequestFullscreen) { /* IE/Edge */
                                                                            // @ts-ignore
                            elem.msRequestFullscreen();
                                                                        }
                    }
                }
            }
            setIsFullScreen(true);
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
                // @ts-ignore
            } else if (document.mozCancelFullScreen) { /* Firefox */
                // @ts-ignore
                document.mozCancelFullScreen();
                // @ts-ignore
            } else if (document.webkitExitFullscreen) {
                // @ts-ignore/* Chrome, Safari & Opera */
                document.webkitExitFullscreen();
                // @ts-ignore
            } else if (document.msExitFullscreen) { /* IE/Edge */
                // @ts-ignore
                document.msExitFullscreen();
            }
            setIsFullScreen(false);
        }
    };

    return (
        <div className={`contain ${isDarkMode ? 'dark' : ''}`}>
            {!loading ? (
                <div className="loading-overlay">
                    <Spin tip="Loading..." className="loading">
                    </Spin>
                </div>
            ) : (
                <>

                    <div className={`content ${isDarkMode ? 'contentDark' : ''}`} ref={fullScreenRef}>
                        <div className={`shell ${isShellClosed ? 'close' : ''} ${isDarkMode ? 'dark' : ''} slider`}>
                            <nav className={`shell ${isShellClosed ? 'close' : ''} ${isDarkMode ? 'dark' : '' }`}>
                                <header>
                                    <div className="image-text">
                        <span className="image">
                            <Avatar src={avatar} size={45} />
                        </span>
                                        <div className="text logo-text">
                                            <span className="name">
                                                {name}
                                            </span>
                                        </div>
                                    </div>
                                    <i className="iconfont icon-iconfonticonfontarrowright toggle" onClick={handleToggleClick} style={{fontSize: 20}}></i>
                                </header>

                                <div className="menu-bar">
                                    <div className="menu">
                                        <li className="search-box" onClick={handleSearchClick}>
                                            <i className="iconfont icon-sousuo1 icon"></i>
                                            <input type="text" placeholder="search..." value={searchVal} onChange={(e) => setSearchVal(e.target.value)} onKeyDown={(e) => {if(e.key === "Enter") { navigate('/dashboard/notes?kw=' + encodeURIComponent(searchVal.trim())) }}} />
                                        </li>

                                        <ul className="menu-links">
                                            {sidebar.map(item => (
                                                <li className={`nav-links ${SelectCurrent === item.index ? 'nav_select' : ''}`}
                                                    onClick={() => {
                                                        navigate(item.to ? `/dashboard/${item.to}` : '/dashboard')
                                                        setSelectCurrent(item.index)
                                                    }} key={item.index}>
                                                    {item.icon === 'svg-user-cog' ? (
                                                        /* gear+person 双 path SVG：置 .icon 槽内，stroke=currentColor 随 hover/选中变色 */
                                                        <span className="icon">
                                                            <svg viewBox="0 0 24 24" className="nav-svg" fill="none"
                                                                 stroke="currentColor" strokeWidth="1.7"
                                                                 strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                                                <circle cx="6.4" cy="6.4" r="2.3"/>
                                                                <path d="M1.6 19.6c0-2.9 2.2-4.8 4.8-4.8s4.8 1.9 4.8 4.8"/>
                                                                <circle cx="17.4" cy="17.4" r="3.4"/>
                                                                <path d="M17.4 11.5v2M17.4 21.3v2M11.5 17.4h2M23.3 17.4h-2M15 15l-1.3-1.3M19.8 15l1.3-1.3M15 19.8l-1.3 1.3M19.8 19.8l1.3 1.3"/>
                                                            </svg>
                                                        </span>
                                                    ) : (
                                                        <i className={`${item.icon.startsWith("fa-") ? "fa " : "iconfont"} ${item.icon} icon`}></i>
                                                    )}
                                                    <span className="text nac-text">{item.name}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>

                                    <div className="bottom-content">
                                        {/* 20260905：管理类并入侧栏「用户管理」，本项回归设置专属（站点信息/用户信息/社交/其他） */}
                                        <li className="nav-links" onClick={() => navigate('/dashboard/usercontrol')}>
                                            <i className="iconfont icon-iconfontcog icon"></i>
                                            <span className="text nac-text">站点设置</span>
                                        </li>

                                        {/* 20260923 用户要求：这颗按钮**不再退出登录**，改为返回
                                            外部首页（原先点它弹一次确认框、删掉 token 才回到首页）。
                                            退出登录仍有入口——博客头部头像菜单里那颗「退出」。
                                            所以这里既不 deleteToken 也不派发 auth-change：令牌留着，
                                            回到前台仍是登录态。 */}
                                        <li className="nav-links" onClick={() => navigate('/')}>
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
                        <Card style={{ width: "90%",height: '95%' ,marginLeft:80}} className={`Card ${isDarkMode ? 'CardDark' : ''}`}>
                            <MainContext.Provider value={isDarkMode.toString()}>
                                <Outlet />
                            </MainContext.Provider>
                        </Card>

                        {/*  悬浮按钮  */}

                        <div className='setting_btn' onClick={()=>toggleFullScreen()}>
                            <SettingButton />
                        </div>
                    </div>
                </>
                )}

            {/* 看板娘（20260923 用户实测：在 dashboard 刷新后消失）。
                `/dashboard` 与 `/` 在路由表里是兄弟顶层路由，命中它时 <App/> 根本不在渲染树里，
                App.tsx 那颗 <Live2dAgent/> 不会挂载 ⇒ autoload.js 从不被注入。
                SPA 跳转进来时看着还在，是因为看板娘的 DOM 由 autoload.js 直接挂在 body 下、
                在 React 树之外，刷新才暴露。与 /guestbook（RiverBoard）同一套做法。
                autoload.js 自带防重入（window.__agentChatLoaded / #waifu 存在即跳过），
                来回跳不会叠出两只；waifu.css 也已按后台的 fixed 侧栏调过 z-index。 */}
            <Live2dAgent />
        </div>
    );
};

export default Dashboard;

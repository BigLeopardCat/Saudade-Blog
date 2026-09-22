import {useEffect, useRef, useState, type ReactNode} from 'react';
import './index.css';
// import '../../assets/font/iconfont.js';
// import '../../assets/font/iconfont.css';
import {Outlet, useNavigate} from "react-router-dom";
import {Card, Spin, Avatar, ConfigProvider, theme as antdTheme} from "antd";
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

/** 用户提供的填充型图标（20260923 换掉 公告的 fa-bullhorn 与 用户管理的 gear+person）。
 *  这些是"设计稿直接给的一段 svg"，不是图标库 —— 落库约定：
 *   · 根 svg 只留 viewBox + className="nav-svg" + fill="currentColor" + aria-hidden，
 *     原标签上的 t / class / p-id / version / xmlns / width / height 一律去掉（那串 p-id
 *     是设计工具的临时编号，留着只是噪音；width/height=200 会盖掉 .nav-svg 的 22px）。
 *   · **每条 path 上的 fill 也要去掉**：留着就盖掉根上的 currentColor，于是夜间悬停金、
 *     选中黑只变一半（原色 #77808F / #979797 只作参考记录，不落代码）。
 *   · 两枚 viewBox 不同（公告 1024²、用户管理 1097×1024），所以不能合成一个 svg 模板，
 *     但都由 .nav-svg 定 22×22 + 默认 preserveAspectRatio 居中，视觉尺寸一致。
 *  数据里写 key，渲染时查这张表；表里没有的仍走 iconfont / Font Awesome 那支。 */
const NAV_FILL_SVG: Record<string, { viewBox: string; body: ReactNode }> = {
    // 喇叭（公告）
    'svg-announcement': {
        viewBox: '0 0 1024 1024',
        body: (
            <path d="M921.9 468.6H749.6c-9.4 0-18.4 3.8-25 10.5-6.6 6.7-10.3 15.7-10.3 25.1v11.1c0 19.6 15.9 35.5 35.4 35.5h172.2c19.5 0 35.3-15.9 35.3-35.5v-11.1c0-9.4-3.7-18.4-10.3-25.1-6.6-6.7-15.6-10.5-25-10.5zM522.4 163.9c-53.6 42.6-165.7 102.3-246.3 159.8h-0.1c-0.9 0.6-1.8 3.8-2.8 4.3-9.5 5.4-13.8 20.1-65.6 20.1h-101c-26 0-42 12.2-42 39.6V631c0 27.4 14.7 40.9 42 40.9H208c51.5 0.1 55.7 14.8 65.2 20.1 0.9 0.5 1.8 3.7 2.7 4.3h0.1c78.2 57.5 191 121.8 246.4 162.7 16.7 12.3 72.1 33.9 72.1-42.1v-614c0-76.1-55.9-51.8-72.1-39z m159 167.8c9.2 16.1 27.3 20.2 40.5 9l141.5-119.3c13.3-11.1 16.5-33.2 7.4-49.4l-5.2-9.1c-9.1-16.1-27.3-20.1-40.5-9L683.6 273.2c-13.2 11.2-16.5 33.2-7.4 49.4l5.2 9.1z m40.4 347.4c-13.2-11.1-31.3-7-40.4 9l-5.2 9.1c-9.1 16.1-5.8 38.2 7.4 49.4L825.1 866c13.2 11.1 31.3 7.1 40.4-9l5.2-9.1c9.1-16.1 5.8-38.2-7.4-49.4L721.8 679.1z m0 0" />
        ),
    },
    // 人 + 列表（用户管理：账号管理 + 评论管理合并入口，20260905 用户拍板）
    'svg-user-list': {
        viewBox: '0 0 1097 1024',
        body: (
            <>
                <path d="M635.026286 560.786286c91.721143 0 166.253714-73.581714 166.253714-164.571429s-74.605714-164.571429-166.253714-164.571428c-91.721143 0-166.253714 73.581714-166.253715 164.571428s74.605714 164.571429 166.253715 164.571429z m0-73.142857a92.306286 92.306286 0 0 1-93.110857-91.428572c0-50.468571 41.545143-91.428571 93.110857-91.428571 51.492571 0 93.110857 40.96 93.110857 91.428571 0 50.395429-41.618286 91.428571-93.110857 91.428572z" />
                <path d="M887.661714 737.499429c0-138.093714-113.225143-249.856-252.635428-249.856-139.483429 0-252.708571 111.762286-252.708572 249.856a36.571429 36.571429 0 1 0 73.142857 0c0-97.499429 80.310857-176.713143 179.565715-176.713143s179.492571 79.213714 179.492571 176.713143a36.571429 36.571429 0 0 0 73.142857 0zM60.928 292.571429h243.858286a36.571429 36.571429 0 1 0 0-73.142858H60.928a36.571429 36.571429 0 1 0 0 73.142858zM60.928 512h243.858286a36.571429 36.571429 0 1 0 0-73.142857H60.928a36.571429 36.571429 0 1 0 0 73.142857zM60.928 731.428571h243.858286a36.571429 36.571429 0 1 0 0-73.142857H60.928a36.571429 36.571429 0 1 0 0 73.142857z" />
                <path d="M292.571429 0h658.285714a146.285714 146.285714 0 0 1 146.285714 146.285714v731.428572a146.285714 146.285714 0 0 1-146.285714 146.285714H292.571429a146.285714 146.285714 0 0 1-146.285715-146.285714V146.285714a146.285714 146.285714 0 0 1 146.285715-146.285714z m0 73.142857a73.142857 73.142857 0 0 0-73.142858 73.142857v731.428572a73.142857 73.142857 0 0 0 73.142858 73.142857h658.285714a73.142857 73.142857 0 0 0 73.142857-73.142857V146.285714a73.142857 73.142857 0 0 0-73.142857-73.142857H292.571429z" />
            </>
        ),
    },
};


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
        // hash → 侧栏高亮索引（与下方 sidebar 数组 index 一一对应）。
        // 底部那两颗（站点设置 / 返回首页）不在 sidebar 数组里，但**必须在这里映射**：
        // 「站点设置」落在 #/dashboard/usercontrol，不映射就回落 1 ⇒ 刷新后高亮跑到「主页」。
        // 索引用 8（sidebar 只到 7，子菜单是 201+），与顶部菜单不冲突。
        const HASH_INDEX: Record<string, number> = {
            '#/dashboard': 1,
            '#/dashboard/comments': 3,
            '#/dashboard/albums': 4,
            '#/dashboard/announcement': 5,
            '#/dashboard/users': 6,
            '#/dashboard/analytics': 7,
            '#/dashboard/usercontrol': 8,
        };
        const currentHashCode =
            location.hash.startsWith('#/dashboard/notes') ? 2 : (HASH_INDEX[location.hash] ?? 1);
        setSelectCurrent(currentHashCode)
        setLoading(true);
        setDarkMode(readDarkMode());
        // 反向同步：看板娘面板 / agent 的 DARKMODE 命令在这个页面上切主题时，壳里的
        // isDarkMode 要跟着走（否则只有 localStorage 变了、侧栏与 antd 主题原地不动）。
        // 不会循环：那个处理器只 setState + 写 localStorage，**从不回派发**（App.tsx 同理）。
        const onDarkModeChange = (e: Event) => setDarkMode(!!(e as CustomEvent).detail);
        window.addEventListener('darkmode-change', onDarkModeChange);
        return () => window.removeEventListener('darkmode-change', onDarkModeChange);
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
        // 同 Head 的协议：派发 darkmode-change。少了这一句，后台切完主题后看板娘的
        // `window.__darkMode`（agent 请求体 current_darkmode 的来源）仍是旧值。
        try { window.dispatchEvent(new CustomEvent('darkmode-change', { detail: !isDarkMode })); } catch (e) { /* ignore */ }
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
            icon: 'svg-announcement',
            to: 'announcement',
            active: false
        },
        {
            index: 6,
            name: '用户管理',
            // 人+列表 填充型 SVG（20260905：账号管理 + 评论管理合并入口，用户拍板）
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
        /* 后台的 antd 主题**必须在这层壳上定**：`/dashboard` 与 `/` 是兄弟顶层路由，命中后台时
           `<App/>` 根本不在树上 ⇒ App.tsx 的 frontDark 永远落不到后台；而 isDarkMode 只长在这
           个壳里，它已经是 `<Outlet/>` 的父节点，所以这里是唯一能罩住全部子页的位置。
           页内那几处 ConfigProvider（Home 的 locale / Notes / Talks / AllNotes）在 antd v5 里
           与父层**合并**，不用动它们。 */
        <ConfigProvider theme={{algorithm: isDarkMode ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm}}>
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
                                            {sidebar.map(item => {
                                                const fillSvg = NAV_FILL_SVG[item.icon];
                                                return (
                                                <li className={`nav-links ${SelectCurrent === item.index ? 'nav_select' : ''}`}
                                                    onClick={() => {
                                                        navigate(item.to ? `/dashboard/${item.to}` : '/dashboard')
                                                        setSelectCurrent(item.index)
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
                                        {/* 20260905：管理类并入侧栏「用户管理」，本项回归设置专属（站点信息/用户信息/社交/其他）。
                                            20260923：补 nav_select —— 它不在 sidebar 数组里，原来只 navigate 不置高亮，
                                            于是点它之后蓝色容器仍停在上一个被点的图标上（用户报的"选中没跟上"）。 */}
                                        <li className={`nav-links ${SelectCurrent === 8 ? 'nav_select' : ''}`}
                                            onClick={() => {
                                                navigate('/dashboard/usercontrol');
                                                setSelectCurrent(8);
                                            }}>
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
        </ConfigProvider>
    );
};

export default Dashboard;

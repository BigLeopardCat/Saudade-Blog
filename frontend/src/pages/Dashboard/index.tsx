import {useEffect, useRef, useState, type ReactNode} from 'react';
import './index.css';
// import '../../assets/font/iconfont.js';
// import '../../assets/font/iconfont.css';
import {Outlet, useLocation, useNavigate} from "react-router-dom";
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
import { useViewerProfile } from "../../components/UserCenter/identity"; // 侧栏身份（登录用户头像/昵称）
import AnnouncementModal from "../../components/AnnouncementModal"; // 同上：公告弹窗也跟壳走，不跟页面走

/** 用户提供的填充型图标（20260923 换掉 公告的 fa-bullhorn 与 用户管理的 gear+person；
 *  20261001 按用户给的新稿**两枚都换了一版**）。这些是"设计稿直接给的一段 svg"，
 *  不是图标库 —— 落库约定：
 *   · 根 svg 只留 viewBox + className="nav-svg" + fill="currentColor" + aria-hidden，
 *     原标签上的 t / class / p-id / version / xmlns / width / height 一律去掉（那串 p-id
 *     是设计工具的临时编号，留着只是噪音；width/height=200 会盖掉 .nav-svg 的 22px）。
 *   · **每条 path 上的 fill 也要去掉**：留着就盖掉根上的 currentColor，于是夜间悬停金、
 *     选中黑只变一半（原色 #77808F / #979797 只作参考记录，不落代码）。
 *   · 两枚新稿的 viewBox **都是 1024²**（旧稿用户管理那枚是 1097×1024，同一枚图标横着
 *     多出 73 个单位 ⇒ 按默认 preserveAspectRatio 居中后**纵向只有 20.5px**，比旁边
 *     23px 的字体图标小一圈）。换成 1024² 后纵横都吃满 22px，与相邻图标等高。
 *   · ⚠️ 尺寸这一条**光读代码看不出来**，`tests/dashboard-sidebar.test.py` 第八节把
 *     "九枚图标的墨迹高度两两相差 ≤ 1.5px"钉成了判据——换稿时它红就是真的没对齐。
 *  数据里写 key，渲染时查这张表；表里没有的仍走 iconfont / Font Awesome 那支。 */
const NAV_FILL_SVG: Record<string, { viewBox: string; body: ReactNode }> = {
    // 喇叭（公告，20261001 新稿）
    'svg-announcement': {
        viewBox: '0 0 1024 1024',
        body: (
            <path d="M61.139079 310.392465q0-26.58137 18.913667-44.983856t45.495036-18.402487l64.408703 0 0 287.283263-64.408703 0q-26.58137 0-45.495036-18.402487t-18.913667-44.983856l0-160.510577zM776.791335 46.623491q43.961496-41.916775 79.744109-46.006216t63.386343 18.913667 47.028577 67.475784 31.693171 99.168955 18.402487 114.504361 6.134162 113.993181-7.667703 108.370199-22.491928 101.724856-34.760252 83.32237-44.472676 53.162739-52.651559 12.268324-58.785721-39.872054q-29.648451-34.760252-80.255289-57.763361t-110.414919-38.849694-121.149703-25.559009-112.45964-17.380126-85.367091-14.824225-38.338514-17.380126l0-319.998794q4.089441-14.313045 32.204352-23.514288t71.565226-17.380126 98.146595-17.891306 111.43728-26.58137 110.9261-42.939135 98.146595-66.964604zM408.741603 673.330395q5.111802 12.268324 12.268324 26.58137 6.134162 13.290685 16.357766 30.670811t24.536649 37.827334q17.380126 24.536649 35.271433 51.629198t27.09255 49.073298 5.622982 36.293793-29.13727 14.313045l-58.274541 0q-20.447207 0-37.827334-7.667703t-33.226712-23.514288-32.715532-40.383234-36.293793-58.274541q-23.514288-38.849694-32.715532-67.986964t-12.268324-48.562117q-4.089441-22.491928 0-38.849694 8.178883 1.02236 19.424847 4.089441 9.201243 2.044721 22.491928 5.111802t30.670811 6.134162q17.380126 4.089441 31.181991 7.667703t25.047829 7.667703q12.268324 4.089441 22.491928 8.178883z" />
        ),
    },
    // 人 + 列表（用户管理：账号管理 + 评论管理合并入口，20260905 用户拍板；20261001 新稿）
    'svg-user-list': {
        viewBox: '0 0 1024 1024',
        body: (
            <path d="M144 192c26.24 0 48 21.76 48 48s-21.76 48-48 48H48C21.76 288 0 266.24 0 240S21.76 192 48 192h96z m452.48 64c-30.08 0-16.64 10.88-30.08 12.16-12.16 0-38.4 3.2-49.28 8.96-53.12 28.16-61.44 69.76-60.16 125.44 0 10.24-10.88 5.12-10.88 21.12 0 15.36 5.76 46.72 21.76 67.84 16.64 20.48 21.76 25.6 32.64 41.6 11.52 15.36 16.64 32.64 16.64 46.72 0 52.48-92.16 56.32-145.28 88.96l-5.76 3.84A53.696 53.696 0 0 0 400 768h365.44a53.76 53.76 0 0 0 28.16-99.2l-8.32-4.48c-53.76-28.8-136.96-34.56-136.96-84.48 0-14.08 5.76-31.36 16.64-46.72s16.64-21.12 33.28-42.24 21.76-51.84 21.76-67.84c0-15.36-10.88-10.24-10.88-21.12 0-10.24-1.92-53.76-21.76-93.44-19.2-39.68-60.8-52.48-90.88-52.48z m-452.48 448c26.24 0 48 21.76 48 48s-21.76 48-48 48H48c-26.24 0-48-21.76-48-48S21.76 704 48 704h96zM896 0c70.4 0 128 57.6 128 128v768c0 70.4-57.6 128-128 128H256c-70.4 0-128-57.6-128-128v-32h16c62.08 0 112-49.92 112-112S206.08 640 144 640H128V352h16C206.08 352 256 302.08 256 240S206.08 128 144 128H128c0-70.4 57.6-128 128-128h640z" />
        ),
    },
};

/* 手账配色进 antd token（20261001 批 E「dashboard 内部页也做同样风格化设计」）。
   色值仍然只有 `src/index.css` 的 `--washi-*` 一份 —— 这里是它的**逐字副本**，
   每行后面注了令牌名。必须写字面量而不是 `var(--washi-*)`：antd 要用这些种子色在
   运行时**推导**一整套派生色（hover / active / 浅底 / 描边 / 禁用），推导器认不了
   CSS 变量，喂进去会当场算出一片黑。改令牌时这两处同改（两侧的注释互为索引）。

   为什么不用 CSS 一条条覆盖：`colorPrimary` 一句话波及按钮、开关、勾选框、单选、
   分页选中、Select 选中项、Tabs 游标、链接、Spin、Upload……CSS 逐条追是长尾，
   而且很容易漏掉某一处，漏掉的那处就还是出厂蓝。 */
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
        /* ⚠️ 这一条不是可选的美化：夜间的主色是**亮粉**，而 antd 给实心底色的默认字色
           `colorTextLightSolid` 是**白**——白压 #ff8ec7 只有 1.6:1，等于看不见按钮上的字。
           改成深墨后是 6.4:1。（浅色档的 #d94f9a 压白字是 3.8:1，与出厂蓝同档，不动。） */
        colorTextLightSolid: '#3a2340',
    },
    common: {
        borderRadius: 8,
        /* antd 的 `lg` 断点（表格列的 `responsive: ['lg']` 用它筛列）默认是 **992**，
           比我们那条 CSS 断点低 32px ⇒ 992~1024 之间会出现"外壳已是抽屉、表格却还是
           全列"的破口。把它抬到 1024，两把尺子**精确对齐**。
           ⚠️ **断点 1024 三处同源**：这里、`Dashboard/index.css` 末尾那条 `@media`、
           以及壳里那条 matchMedia。改一处必须三处同改。
           antd 会校验 `screenLGMin <= screenLG <= screenLGMax <= screenXLMin`
           （768 ≤ 1024 ≤ 1199 ≤ 1200，成立）⇒ 不会抛；后台也没有别处用 `lg`/`xl`
           的 Grid 属性，改它只影响 Table 的列筛选。 */
        screenLG: 1024,
    },
};


const Dashboard = () => {
    //hooks区域
    const navigate = useNavigate();
    const { pathname } = useLocation();
    /* 侧栏宽度三档（20261006 用户第 3 条）：0 = 极简（只剩那颗圆钮）、1 = 收起 88px、
       2 = 展开 250px。默认仍是 1（与原来 `isShellClosed=true` 完全一致）。
       ⚠️ 三档是**互斥**的类名（`.mini` / `.close` / 无），不能叠——`.close` 与 `.mini`
       在 CSS 里各自往反方向拉宽度，同时挂上谁赢只看规则先后。 */
    const [tier, setTier] = useState<0 | 1 | 2>(1);
    const [isDarkMode, setDarkMode] = useState(false);
    const [loading, setLoading] = useState(false);
    const [searchVal, setSearchVal] = useState('');
    /* 窄屏抽屉的两颗新状态（20261006 用户第 6 条：dashboard 移动端适配）。
       ⚠️ **不复用上面的 tier**：tier 是「宽度轴」（0/88/250，由两颗圆钮驱动，被
       `dashboard-sidebar.test.py` 在 1280 下逐档断言），抽屉是「开合轴」（二元）。
       两者语义正交——硬塞进 tier 会得到跨断点 resize 时无意义的状态（"窄屏的 0 是关抽屉、
       桌面的 0 是宽 0"），还得改 `handleToggleClick` 的 `t===1?2:1`，当场撞红桌面套件。
       窄屏下 tier 三档在 CSS 里**整体作废**（见 index.css 末尾那段），JS 一个字不用改。

       ⚠️ **断点 1024 三处同源**：index.css 末尾的 `@media (max-width:1024px)`、下面那条
       matchMedia、以及 `WASHI_THEME.common.screenLG`（它决定 antd 表格列 `responsive:['lg']`
       的门槛）。改一处必须三处同改，否则会出现"外壳已是抽屉、表格却还是全列"的破口。

       ⚠️ **不另立 `isNarrow` state**：窄屏的可见性由 CSS 单独负责（这类"某个宽度下才存在"
       的状态在 JS 里再存一份，只会多一个能漂移的真相源），JS 这边只需要"跨断点把抽屉关掉"。 */
    const [navOpen, setNavOpen] = useState(false);
    const dispatch = useDispatch();
    // 侧栏那格身份 = **正在看后台的这个人**（20260930 用户点名：头像不许硬编码成站点那张）。
    // 站点作者名（`state.user.name`）仍是兜底：本机没有账号记录时侧栏不至于空着。
    const siteName = useSelector((state: { user: UserState }) => state.user.name);
    const viewer = useViewerProfile();

    //初始渲染
    useEffect(() => {
        dispatch<any>(fetchUserInfo())
        dispatch<any>(fetchCategories())
        dispatch<any>(fetchTags())
        dispatch<any>(fetchNoteList(true))
        setLoading(true);
        setDarkMode(readDarkMode());
        // 反向同步：看板娘面板 / agent 的 DARKMODE 命令在这个页面上切主题时，壳里的
        // isDarkMode 要跟着走（否则只有 localStorage 变了、侧栏与 antd 主题原地不动）。
        // 不会循环：那个处理器只 setState + 写 localStorage，**从不回派发**（App.tsx 同理）。
        const onDarkModeChange = (e: Event) => setDarkMode(!!(e as CustomEvent).detail);
        window.addEventListener('darkmode-change', onDarkModeChange);
        return () => window.removeEventListener('darkmode-change', onDarkModeChange);
    },[])

    /* 窄屏抽屉的三条收尾（20261006）。 */

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

    /* 手账皮的**范围根**（20261001 批 E）：内部页那层样式全部写在 `body.dash-skin`
       下（见 index.css 末尾那块）。必须挂 body 而不是 `.Card` —— antd 的 Modal /
       Select / Dropdown / Tooltip / Popconfirm 全部走 Portal 挂到 `document.body`
       下，`.Card` 在它们身上够不着，挂在 `.Card` 上等于这些浮层一条样式都吃不到。

       `washiDark` 是同一个根的第二半：浮层的祖先链只有 `body`，`.contain.dark` 不在
       链上 ⇒ 不挂这个类，浮层里的 `var(--washi-*)` 会一路落回 `:root` 的浅色档
       （夜间弹窗上一片深字）。两个类名都由本组件负责挂与摘，卸载时清干净
       ——SPA 跳回首页后不留死类名（`.washiDark` 会波及 body 下所有 `--washi-*` 使用者）。 */
    useEffect(() => {
        document.body.classList.add('dash-skin');
        return () => {
            document.body.classList.remove('dash-skin', 'washiDark');
        };
    }, []);

    useEffect(() => {
        document.body.classList.toggle('washiDark', isDarkMode);
    }, [isDarkMode]);

    //回调函数区域

    /* 那颗 `.toggle`（圆钮里的箭头）：展开态显 ◀、其余显 ▶，所以它的动作是
       「88 ⇄ 250」，而极简档（0）按一下先回到 88 —— 与箭头指的方向一致。 */
    const handleToggleClick = () => {
        setTier(t => (t === 1 ? 2 : 1));
    };

    /* 第二颗圆钮（只在 88 档出现）：◀ = 再收一档到极简。 */
    const handleCollapseClick = () => {
        setTier(0);
    };

    /* 点搜索框要能打字 ⇒ 把它所在的侧栏展开（沿用原来 `setShellClosed(false)` 的语义：
       那是"展开到 250"，不是"收起"）。 */
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

    /* 侧栏高亮**按当前路径派生**（20261006 修）。
       原来读的是 `location.hash`：路由早在 `main.tsx` 就换成了 `createBrowserRouter`
       （真实 path，全仓没有任何地方写 hash），于是那份 HASH_INDEX **恒不命中** ⇒
       刷新/深链/程序化跳转（图库页的「R2 配置」）一律回落到「主页」。
       现在直接反查 `sidebar` 自己的 `to`，不再维护第二份「路径 → 编号」表：
       `/dashboard` → '' → 主页(1)，`/dashboard/notes/xxx` → 'notes' → 2，以此类推。
       底部「站点设置」是硬编码的 li、不在 sidebar 数组里 ⇒ 只能特判（沿用原来的 8）。
       只读 `pathname`：`useLocation()` 每次返回**新对象**，拿整个 location 做依赖会白渲染。 */
    const seg = pathname.replace(/^\/dashboard\/?/, '').split('/')[0];
    const activeIndex = seg === 'usercontrol' ? 8 : (sidebar.find(i => i.to === seg)?.index ?? 1);


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
        /* ⚠️ 颜色必须进 `token`，**不能摊在 theme 的根上**：antd v5 的 `theme` 只认
           `{algorithm, token, components, inherit}` 四个键，摊在根上的 `colorPrimary`
           会被**静默忽略**（不报错、不警告，页面照旧一片出厂蓝——实测踩过）。
           `token` 里前面的主色/纸底/墨色是分档的那份，后面的 `common` 补圆角。 */
        <ConfigProvider theme={{
            algorithm: isDarkMode ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
            token: {
                ...(isDarkMode ? WASHI_THEME.dark : WASHI_THEME.light),
                ...WASHI_THEME.common,
            },
        }}>
        <div className={`contain ${isDarkMode ? 'dark' : ''}`}>
            {!loading ? (
                <div className="loading-overlay">
                    <Spin tip="Loading..." className="loading">
                    </Spin>
                </div>
            ) : (
                <>

                    <div className={`content ${isDarkMode ? 'contentDark' : ''}`} ref={fullScreenRef}>
                        {/* 窄屏外壳（20261006 用户第 6 条）：汉堡钮 + 遮罩。
                            两边都只在 index.css 末尾那条 `@media (max-width:1024px)` 里有样式，
                            桌面是 `display:none` ⇒ 对桌面零影响。

                            ⚠️ 汉堡钮必须放在 `.shell` **之外**：抽屉靠给外层 `.shell.slider` 加
                            `transform: translateX(-100%)` 滑出屏外，按钮放进去会被一起推走。
                            ⚠️ 图标 `icon-bars` 是**前台移动端头部**（frontHome/Head/index.tsx）
                            用的同一枚，别自创。 */}
                        <button type="button" className="pad-menu-btn" aria-label="打开导航"
                                aria-expanded={navOpen} onClick={() => setNavOpen(true)}>
                            <i className="iconfont icon-bars" aria-hidden="true"></i>
                        </button>

                        {/* 遮罩：点它关抽屉。只在窄屏且开着时显示。 */}
                        <div className={`nav-backdrop${navOpen ? ' show' : ''}`}
                             aria-hidden="true" onClick={closeNav} />

                        {/* `.shell` 是**嵌套两层**的，两层带同样的 tier 类名；只有外层多一个
                            `slider`。**transform 只加在外层**：它会让外层的固定定位成为
                            nav 的包含块，nav 跟着一起位移——推两层会位移两倍。 */}
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
                                    {/* 两颗圆钮的**类名必须分开**（20261006）：
                                        `.toggle` 是那颗一直都在的（展开态朝左、其余朝右），
                                        `.toggle-collapse` 是新增的、只在 88 档出现的第二颗（朝左）。
                                        合成一个类名会让两处选择器都失去意义（套件里就用 `.toggle`
                                        量 88→250）。第一颗的**位置**没动 —— 它的 top 是 50%，
                                        第二颗挂在 `calc(50% + 32px)`。 */}
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
                                        {/* 20260905：管理类并入侧栏「用户管理」，本项回归设置专属（站点信息/用户信息/社交/其他）。
                                            20260923：补 nav_select —— 它不在 sidebar 数组里，原来只 navigate 不置高亮，
                                            于是点它之后蓝色容器仍停在上一个被点的图标上（用户报的"选中没跟上"）。
                                            20261006：高亮改由 `activeIndex` 按路径派生（见上方），此处不再自己 setState
                                            —— 从图库页点「R2 配置」跳过来的那种**不经侧栏**的跳转，原来就漏掉了。 */}
                                        <li className={`nav-links ${activeIndex === 8 ? 'nav_select' : ''}`}
                                            onClick={() => {
                                                navigate('/dashboard/usercontrol');
                                                closeNav()
                                            }}>
                                            <i className="iconfont icon-iconfontcog icon"></i>
                                            <span className="text nac-text">站点设置</span>
                                        </li>

                                        {/* 20260923 用户要求：这颗按钮**不再退出登录**，改为返回
                                            外部首页（原先点它弹一次确认框、删掉 token 才回到首页）。
                                            退出登录仍有入口——博客头部头像菜单里那颗「退出」。
                                            所以这里既不 deleteToken 也不派发 auth-change：令牌留着，
                                            回到前台仍是登录态。 */}
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
                        {/* ⚠️ 这三个数（90% / 95% / 80px）**从内联搬到了 index.css 的 `.Card`**
                            （20261006）：内联样式压过一切普通 CSS 声明 ⇒ 只要它们还挂在这里，
                            窄屏那条 `@media` 里写多少 `.Card{width:100%; margin-left:0}` 都是
                            **静默失效**（本仓反复吃亏的"半死"）。搬走后行为逐字节不变。 */}
                        <Card className={`Card ${isDarkMode ? 'CardDark' : ''}`}>
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
                App.tsx 那颗 <Live2dAgent/> 不会挂载 ⇒ boot.js 从不被注入。
                SPA 跳转进来时看着还在，是因为看板娘的 DOM 由 boot.js 直接挂在 body 下、
                在 React 树之外，刷新才暴露。与 /guestbook（RiverBoard）同一套做法。
                boot.js 自带防重入（window.__agentChatLoaded / #waifu 存在即跳过），
                来回跳不会叠出两只；widget.css 也已按后台的 fixed 侧栏调过 z-index。 */}
            <Live2dAgent />
            {/* 挂在 ConfigProvider **里面**：后台这套 ConfigProvider 带 darkAlgorithm，
                公告卡片的配色取 antd token ⇒ 在这里才是深色可读的（见组件里的注释）。 */}
            <AnnouncementModal />
        </div>
        </ConfigProvider>
    );
};

export default Dashboard;

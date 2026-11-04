import { createBrowserRouter, Navigate, useParams } from "react-router-dom";
import { lazy, Suspense, type ReactNode } from "react";
import { AuthRouter } from "../components/AuthRouter.tsx";
import NotFound from "../components/NotFound";
import { registerSpaNavigate } from "./spaNavigate.ts";

const Login = lazy(() => import("../pages/Login"));
// A cold 404 must not download the home layout and its media/widgets.
const App = lazy(() => import("../App.tsx"));
const ContentHome = lazy(() => import("../frontHome/Content/ContentHome"));
const Dashboard = lazy(() => import("../pages/Dashboard"));
const RiverBoard = lazy(() => import("../pages/RiverBoard/index"));
const Home = lazy(() => import("../pages/Dashboard/Home"));
const Notes = lazy(() => import("../pages/Dashboard/Notes"));
const Comments = lazy(() => import("../pages/Dashboard/Talks"));
const Albums = lazy(() => import("../pages/Dashboard/Albums"));
const Users = lazy(() => import("../pages/Dashboard/Users"));
const Analytics = lazy(() => import("../pages/Dashboard/Analytics"));
const UserControl = lazy(() => import("../pages/Dashboard/UserControl"));
const AllNotes = lazy(() => import("../pages/Dashboard/Notes/AllNotes/index"));
const NewNotes = lazy(() => import("../pages/Dashboard/Notes/NewNotes/index"));
const AllCategorize = lazy(() => import("../pages/Dashboard/Notes/AllCategorize/index"));
const AllTag = lazy(() => import("../pages/Dashboard/Notes/AllTag/index"));
const AnnouncementManagement = lazy(() => import("../pages/Dashboard/Announcement"));
const AboutMe = lazy(() => import("../frontHome/Content/AboutMe"));
const Categories = lazy(() => import("../frontHome/Content/Categories"));
const Talk = lazy(() => import("../frontHome/Content/Talk"));
const Times = lazy(() => import("../frontHome/Content/Times"));
const ReadArticle = lazy(() => import("../frontHome/Content/ReadArticle"));

const routePage = (page: ReactNode) => (
    <Suspense fallback={<div role="status" style={{ minHeight: "40vh", padding: 32 }}>正在加载页面…</div>}>{page}</Suspense>
);

/**
 * 编辑器路由包装：`newnote/:id?` 换 id（编辑 30 → 点侧栏「编辑文章」变新建）时 React 不会重挂载，
 * 只是 param 变了——编辑器里上一篇的标题/正文/封面/裁剪参数会留着，自动保存再把它写进新建的草稿行，
 * 等于把上一篇复制一遍。key 强制换实例：旧实例卸载时正常补发/清理自己的草稿，新实例从零开始。
 */
const NewNotesRoute = () => {
    const { id } = useParams();
    return <NewNotes key={id ?? 'new'} />;
};

const router = createBrowserRouter([
    {
        path: '/',
        element: routePage(<App />),
        children: [
            {
                index: true,
                element: routePage(<ContentHome />)
            },
            {
                path: 'about',
                element: routePage(<AboutMe />)
            },
            {
                // 原友链页已废弃：/friends 重定向到留言板（河灯留言）
                path: 'friends',
                element: <Navigate to="/guestbook" replace />
            },
            {
                path: "talk",
                element: routePage(<Talk />)
            },
            {
                path: 'category/:id',
                element: routePage(<Categories />)
            },
            {
                path: 'times',
                element: routePage(<Times />)
            },
            {
                path: 'article/:id',
                element: routePage(<ReadArticle />)
            }
        ]
    },
    // Standalone full-screen page: no public header, footer, menus or widget boot.
    {
        path: '*',
        element: <NotFound />
    },
    {
        path: 'login',
        element: routePage(<Login />)
    },
    // 留言板（河灯）：主页导航"留言板"入口
    {
        path: 'guestbook',
        element: <Suspense fallback={<div style={{ minHeight: "100dvh", background: "#081723" }} />}><RiverBoard /></Suspense>
    },
    // 兼容旧地址 /he（早期隐藏路由），重定向到留言板
    {
        path: 'he',
        element: <Navigate to="/guestbook" replace />,
    },
    {
        path: '/dashboard',
        element: <AuthRouter>{routePage(<Dashboard />)}</AuthRouter>,
        children: [
            {
                index: true,
                element: routePage(<Home />)
            },
            {
                path: 'notes',
                element: routePage(<Notes />),
                children: [
                    {
                        index: true,
                        element: routePage(<AllNotes />)
                    },
                    {
                        path: 'newnote/:id?', // 在:id后面加上问号?表示id参数可选
                        element: routePage(<NewNotesRoute />),
                    },
                    {
                        path: 'allcategorize',
                        element: routePage(<AllCategorize />)
                    },
                    {
                        path: 'alltags',
                        element: routePage(<AllTag />)
                    }
                ]
            },
            {
                path: 'comments',
                element: routePage(<Comments />)
            },
            {
                path: 'albums',
                element: routePage(<Albums />)
            },
            {
                path: 'users',
                element: routePage(<Users />)
            },
            {
                // 旧「留言管理」地址 → 用户管理页（评论管理 Tab 内）
                path: 'talks',
                element: <Navigate to="/dashboard/users" replace />
            },
            {
                path: 'analytics',
                element: routePage(<Analytics />)
            },
            {
                path: 'announcement',
                element: routePage(<AnnouncementManagement />)
            },
            {
                path: 'usercontrol',
                element: routePage(<UserControl />)
            }
        ]
    }
])

// 站内跳转桥：把 `window.__spaNavigate(url)` 挂上，让对话面板里的站内跳转走路由换页而不是整页重载
// （面板在 #root 之外，整页重载会把它整个重建）。判据/白名单见 src/router/spaNavigate.ts。
registerSpaNavigate(router)

export default router

import { createBrowserRouter, Navigate, useParams } from "react-router-dom";
import Login from "../pages/Login";
import Dashboard from "../pages/Dashboard";
import RiverBoard from "../pages/RiverBoard/index";
import { AuthRouter } from "../components/AuthRouter.tsx";
import Home from "../pages/Dashboard/Home";
import Notes from "../pages/Dashboard/Notes";
import Comments from "../pages/Dashboard/Talks";
import Albums from "../pages/Dashboard/Albums";
import Users from "../pages/Dashboard/Users";
import Analytics from "../pages/Dashboard/Analytics";
import UserControl from "../pages/Dashboard/UserControl";
import AllNotes from "../pages/Dashboard/Notes/AllNotes/index";
import NewNotes from "../pages/Dashboard/Notes/NewNotes/index";
import AllCategorize from "../pages/Dashboard/Notes/AllCategorize/index";
import AllTag from "../pages/Dashboard/Notes/AllTag/index";
import AnnouncementManagement from "../pages/Dashboard/Announcement";
import ContentHome from "../frontHome/Content/ContentHome";
import App from "../App.tsx";
import AboutMe from "../frontHome/Content/AboutMe";
import Categories from "../frontHome/Content/Categories";
import Talk from "../frontHome/Content/Talk";
import Times from "../frontHome/Content/Times";
import NotFound from "../components/NotFound";
import ReadArticle from "../frontHome/Content/ReadArticle";
import { registerSpaNavigate } from "./spaNavigate.ts";

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
        element: <App />,
        children: [
            {
                index: true,
                element: <ContentHome />
            },
            {
                path: 'about',
                element: <AboutMe />
            },
            {
                // 原友链页已废弃：/friends 重定向到留言板（河灯留言）
                path: 'friends',
                element: <Navigate to="/guestbook" replace />
            },
            {
                path: "talk",
                element: <Talk />
            },
            {
                path: 'category/:id',
                element: <Categories />
            },
            {
                path: 'times',
                element: <Times />
            },
            {
                path: 'article/:id',
                element: <ReadArticle />
            },
            // 兜底：未知路径渲染 NotFound，但保留 App 布局（头部/底部/看板娘聊天面板）。
            // 若作为顶层路由，agent 误跳转（如 /iot）后整站布局和聊天面板会全部丢失
            {
                path: '*',
                element: <NotFound />
            }
        ]
    },
    {
        path: 'login',
        element: <Login />
    },
    // 留言板（河灯）：主页导航"留言板"入口
    {
        path: 'guestbook',
        element: <RiverBoard />
    },
    // 兼容旧地址 /he（早期隐藏路由），重定向到留言板
    {
        path: 'he',
        element: <Navigate to="/guestbook" replace />,
    },
    {
        path: '/dashboard',
        element: <AuthRouter> <Dashboard /> </AuthRouter>,
        children: [
            {
                index: true,
                element: <Home />
            },
            {
                path: 'notes',
                element: <Notes />,
                children: [
                    {
                        index: true,
                        element: <AllNotes />
                    },
                    {
                        path: 'newnote/:id?', // 在:id后面加上问号?表示id参数可选
                        element: <NewNotesRoute />,
                    },
                    {
                        path: 'allcategorize',
                        element: <AllCategorize />
                    },
                    {
                        path: 'alltags',
                        element: <AllTag />
                    }
                ]
            },
            {
                path: 'comments',
                element: <Comments />
            },
            {
                path: 'albums',
                element: <Albums />
            },
            {
                // 用户管理（20260905 拍板：账号管理 + 评论管理合并；原「留言管理」并入其评论管理 Tab）
                path: 'users',
                element: <Users />
            },
            {
                // 旧「留言管理」地址 → 用户管理页（评论管理 Tab 内）
                path: 'talks',
                element: <Navigate to="/dashboard/users" replace />
            },
            {
                path: 'analytics',
                element: <Analytics />
            },
            {
                path: 'announcement',
                element: <AnnouncementManagement />
            },
            {
                path: 'usercontrol',
                element: <UserControl />
            }
        ]
    }
])

// 站内跳转桥：把 `window.__spaNavigate(url)` 挂上，让对话面板里的站内跳转走路由换页而不是整页重载
// （面板在 #root 之外，整页重载会把它整个重建）。判据/白名单见 src/router/spaNavigate.ts。
registerSpaNavigate(router)

export default router

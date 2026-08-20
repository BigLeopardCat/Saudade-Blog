import { createBrowserRouter, Navigate } from "react-router-dom";
import Login from "../pages/Login";
import Dashboard from "../pages/Dashboard";
import RiverBoard from "../pages/RiverBoard/index";
import { AuthRouter } from "../components/AuthRouter.tsx";
import Home from "../pages/Dashboard/Home";
import Notes from "../pages/Dashboard/Notes";
import Comments from "../pages/Dashboard/Talks";
import Albums from "../pages/Dashboard/Albums";
import Friends from "../pages/Dashboard/Friends";
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
import FriendList from "../frontHome/Content/FriendList";
import Talk from "../frontHome/Content/Talk";
import Times from "../frontHome/Content/Times";
import NotFound from "../components/NotFound";
import ReadArticle from "../frontHome/Content/ReadArticle";

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
                path: 'friends',
                element: <FriendList />
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
                        element: <NewNotes />,
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
                path: 'friends',
                element: <Friends />
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

export default router

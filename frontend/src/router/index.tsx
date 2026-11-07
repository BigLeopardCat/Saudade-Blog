import { createBrowserRouter, Navigate, useParams } from "react-router-dom";
import { lazy, Suspense } from "react";
import { routePage } from "./RoutePage";
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

// Reset editor state when its article coordinate changes.
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
    {
        path: 'guestbook',
        element: <Suspense fallback={<div style={{ minHeight: "100dvh", background: "#081723" }} />}><RiverBoard /></Suspense>
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
                        path: 'newnote/:id?',
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

// SPA navigation keeps the persistent chat widget mounted.
registerSpaNavigate(router)

export default router

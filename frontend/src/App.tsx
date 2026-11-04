import Head from  './frontHome/Head';
import { Outlet } from "react-router-dom";
import Footer from "./frontHome/Footer";
import './frontHome/main.css';
// 副作用：注册 window.__openZoomOverlay（文章页单击放大查看器），
// 供看板娘对话框（live2d-widgets 原生脚本）点击委托复用——任何页面都需可用，
// 不能只依赖 ReadArticle 路由加载（对话面板出现在所有页面）
import './frontHome/Content/ReadArticle/zoomOverlay';
import { useEffect, useState } from "react";
import './App.sass';
import { readDarkMode, useAutoThemeSwitch } from './theme';
import BottomMenu from "./components/BottomMenu";
import Live2dAgent from "./components/Live2dAgent";
import AnnouncementModal from "./components/AnnouncementModal";
import ErrorBoundary from "./components/ErrorBoundary";

function App() {
    const [isDark, setDark] = useState(false);
    const [scrollHeight, setScrollHeight] = useState(0);
    useEffect(() => {
        setDark(readDarkMode());
        const handleDarkModeChange = (e: Event) => {
            const on = !!(e as CustomEvent).detail;
            setDark(on);
        };
        window.addEventListener('darkmode-change', handleDarkModeChange);
        const handleScroll = () => {
            const currentScrollHeight = window.scrollY || document.documentElement.scrollTop;
            setScrollHeight(currentScrollHeight);
        };

        window.addEventListener('scroll', handleScroll);
        return () => {
            window.removeEventListener('darkmode-change', handleDarkModeChange);
            window.removeEventListener('scroll', handleScroll);
        };
    }, []);

    useAutoThemeSwitch();

    return (
        <div className={isDark ? 'frontDark frontRoot' : 'frontRoot'}>
            <Head setDark={setDark} isDark={isDark} scrollHeight={scrollHeight}/>
            <ErrorBoundary scope="page">
                <Outlet />
            </ErrorBoundary>
            <Footer />
            <BottomMenu scrollHeight={scrollHeight} isDark={isDark} setDark={setDark}/>
            <Live2dAgent />
            <AnnouncementModal />
        </div>
    );
}

export default App;

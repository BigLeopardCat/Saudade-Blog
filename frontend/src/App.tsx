import Head from  './frontHome/Head';
import { Outlet } from "react-router-dom";
import Footer from "./frontHome/Footer";
import './frontHome/main.css';
import { useEffect, useState } from "react";
import './App.sass';
import BottomMenu from "./components/BottomMenu";
import Live2dAgent from "./components/Live2dAgent";

function App() {
    const [isDark, setDark] = useState(false);
    const [scrollHeight, setScrollHeight] = useState(0);
    useEffect(() => {
        setDark(localStorage.getItem('isDarkMode') === 'true');
        // 看板娘 agent 的 DARKMODE: 命令 / 夜间自动切换通过自定义事件同步暗色状态
        const handleDarkModeChange = (e: Event) => {
            const on = !!(e as CustomEvent).detail;
            setDark(on);
            try { localStorage.setItem('isDarkMode', JSON.stringify(on)); } catch (err) { /* ignore */ }
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

    return (
        <div className={isDark ? 'frontDark frontRoot' : 'frontRoot'}>
            <Head setDark={setDark} isDark={isDark} scrollHeight={scrollHeight}/>
            <Outlet />
            <Footer />
            <BottomMenu scrollHeight={scrollHeight} isDark={isDark} setDark={setDark}/>
            <Live2dAgent />
        </div>
    );
}

export default App;

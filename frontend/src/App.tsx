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
import { readDarkMode, autoThemeDecision } from './theme';
import BottomMenu from "./components/BottomMenu";
import Live2dAgent from "./components/Live2dAgent";

function App() {
    const [isDark, setDark] = useState(false);
    const [scrollHeight, setScrollHeight] = useState(0);
    useEffect(() => {
        setDark(readDarkMode());
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

    // 夜间/日间时段自动切换（前端默认行为，不依赖 agent/看板娘脚本）：
    // 23:00-次日06:00 自动开启夜间，其余时段自动恢复日间；
    // 访客手动选择过（darkModeUserChoice，含通过对话让 agent 调节）则在本主题日
    // （06:00 为界）内尊重意愿不覆盖，跨 6:00 自动恢复跟随（判据全在 theme.ts 的
    // autoThemeDecision / recordUserChoice，见那里的注释）；
    // ⚠️ 这是每分钟一次的【状态收敛】而非 23:00 的一次性事件——所以"手动切夜间"必须
    //    记成意愿，否则白天开的夜间模式 60 秒后就被这里改回去（20260915 修的 bug）。
    useEffect(() => {
        const prefersAuto = () => {
            try {
                const next = autoThemeDecision();
                if (next !== null) {
                    window.dispatchEvent(new CustomEvent('darkmode-change', { detail: next }));
                }
            } catch (err) { /* ignore */ }
        };
        prefersAuto();
        const timer = setInterval(prefersAuto, 60 * 1000);
        const onVisible = () => { if (!document.hidden) prefersAuto(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
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

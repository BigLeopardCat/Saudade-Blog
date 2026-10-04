import ReactDOM from 'react-dom/client'
import './index.css'
// 副作用：注册 SPA 侧的错误上报（资源加载失败的捕获监听 + `reportError`）。
// 放在最前面，任何一步之后崩掉都还在监听（20261004）。
import './utils/report'
import {RouterProvider} from "react-router-dom";
import router from "./router";
import {Provider} from "react-redux";
import store from "./store";
import {HelmetProvider} from "react-helmet-async";
import ErrorBoundary from "./components/ErrorBoundary";
import { recoverFromStaleChunk } from "./utils/staleChunk";

// 换代后的悬空 chunk（20261005，A 案）。现场：一个**一直开着**的标签页里那份 index.html
// 是老一代的，它的 `import()` 指向老一代的分块名（带内容哈希），而部署时 dist 差集
// 已经按"本次构建的清单"把那些文件删掉了 ⇒ 点开首页展示柜时那条 URL 404，用户看到的
// 是一张兜底卡，而卡上的「重试」永远好不了。唯一的出路是整页刷新。
// Vite 为**预载失败**那条路派发 `vite:preloadError`，这里接住它；原生 `import()` 不经过
// `__vitePreload`，那条由 ErrorBoundary 接 —— 两边共用同一个带闸的自愈函数（一分钟内
// 只自动刷一次，闸拦下就交给卡上的手动刷新），谁先撞上谁刷。
// 细节与"为什么误伤比漏报更贵"见 `utils/staleChunkCore.ts`。
window.addEventListener('vite:preloadError', (e) => {
    if (recoverFromStaleChunk()) e.preventDefault()
})

ReactDOM.createRoot(document.getElementById('root')!).render(
        // 最外层兜底（20261004）：App.tsx 那层只包内容区，而**后台是另一颗壳**
        // （pages/Dashboard 不在 App 的路由树下），它崩了没有这一层就是白屏且无日志。
        <ErrorBoundary scope="app">
            <HelmetProvider>
                <Provider store={store}>
                    <RouterProvider router={router}>
                    </RouterProvider>
                </Provider>
            </HelmetProvider>
        </ErrorBoundary>
)

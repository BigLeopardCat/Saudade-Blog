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

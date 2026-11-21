import {applyScene, readScene} from './sceneTheme';
import {readDarkMode} from './theme';
import {startAuthExpiry} from './utils/authSession';
import ReactDOM from 'react-dom/client'
import './index.css'
import './utils/report'
import {RouterProvider} from "react-router-dom";
import router from "./router";
import {Provider} from "react-redux";
import store from "./store";
import {HelmetProvider} from "react-helmet-async";
import ErrorBoundary from "./components/ErrorBoundary";
import { recoverFromStaleChunk } from "./utils/staleChunk";
import LocaleBoundary from './i18n/LocaleBoundary';
import {readLocale} from './i18n';

applyScene(readScene());
document.documentElement.lang = readLocale();
document.documentElement.dataset.sceneDark = String(readDarkMode());

window.addEventListener('vite:preloadError', (e) => {
    if (recoverFromStaleChunk()) e.preventDefault()
})

const stopAuthExpiry = startAuthExpiry();
if (import.meta.hot) import.meta.hot.dispose(stopAuthExpiry);

ReactDOM.createRoot(document.getElementById('root')!).render(
        <LocaleBoundary><ErrorBoundary scope="app">
            <HelmetProvider>
                <Provider store={store}>
                    <RouterProvider router={router}>
                    </RouterProvider>
                </Provider>
            </HelmetProvider>
        </ErrorBoundary></LocaleBoundary>
)

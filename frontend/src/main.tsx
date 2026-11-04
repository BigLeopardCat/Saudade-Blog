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

window.addEventListener('vite:preloadError', (e) => {
    if (recoverFromStaleChunk()) e.preventDefault()
})

const stopAuthExpiry = startAuthExpiry();
if (import.meta.hot) import.meta.hot.dispose(stopAuthExpiry);

ReactDOM.createRoot(document.getElementById('root')!).render(
        <ErrorBoundary scope="app">
            <HelmetProvider>
                <Provider store={store}>
                    <RouterProvider router={router}>
                    </RouterProvider>
                </Provider>
            </HelmetProvider>
        </ErrorBoundary>
)

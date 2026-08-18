import ReactDOM from 'react-dom/client'
import './index.css'
import {RouterProvider} from "react-router-dom";
import router from "./router";
import {Provider} from "react-redux";
import store from "./store";
import {HelmetProvider} from "react-helmet-async";

ReactDOM.createRoot(document.getElementById('root')!).render(
        <HelmetProvider>
            <Provider store={store}>
                <RouterProvider router={router}>
                </RouterProvider>
            </Provider>
        </HelmetProvider>
)

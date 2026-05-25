import axios from "axios";
import getToken from "./getToken.tsx"
import { message } from "antd";

const http = axios.create({
    baseURL: import.meta.env.VITE_HTTP_BASEURL || '',
    timeout: 15000
})

// 添加请求拦截器
http.interceptors.request.use(
    function (config) {
        const token = getToken();
        if (token) {
            config.headers.Authorization = token;
        }
        return config;
    },
    function (error) {
        return Promise.reject(error);
    }
);

// 添加响应拦截器
http.interceptors.response.use(
    function (response) {
        return response;
    },
    function (error) {
        if (error.response && error.response.status === 401) {
            // 清除本地过期的 token
            localStorage.removeItem("tokenKey");
            // 提示用户
            message.error("登录状态已过期，请重新登录");
            // 延时 1 秒后跳转，让用户看得到提示
            setTimeout(() => {
                window.location.href = "/login";
            }, 1000);
        }
        return Promise.reject(error);
    }
);

export default http

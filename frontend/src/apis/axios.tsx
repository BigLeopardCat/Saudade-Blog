import {clearAuthToken} from '../utils/authSession';
import axios from "axios";
import type { AxiosError } from "axios";
import getToken from "./getToken.tsx"
import { message } from "antd";
import { runtimeBaseURL } from "../utils/runtimeApi";
import { reportError } from "../utils/report";
import { isOwnReport, shouldReportStatus } from "../utils/reportCore";

const http = axios.create({
    baseURL: runtimeBaseURL,
    timeout: 15000
})

// 添加请求拦截器
http.interceptors.request.use(
    function (config) {
        const token = getToken();
        if (token) {
            // 后端统一 Bearer 解析（strip_prefix("Bearer ")），裸 token 会导致鉴权失败
            config.headers.Authorization = token.startsWith('Bearer ') ? token : 'Bearer ' + token;
        }
        return config;
    },
    function (error) {
        return Promise.reject(error);
    }
);

/** Report failed XHR requests while excluding cancellations and report recursion. */
function reportApiFailure(error: AxiosError) {
    if (error.code === 'ERR_CANCELED') return;
    const config = error.config;
    const method = (config?.method || 'get').toUpperCase();
    // 相对路径（`/api/x`）看不出同源还是跨源，拼上 baseURL 才是真实请求地址
    const path = config?.url || '';
    const fullUrl = (config?.baseURL || '') + path;
    if (isOwnReport(fullUrl) || isOwnReport(path)) return;

    const status = error.response?.status;
    if (shouldReportStatus(status)) {
        reportError({
            type: 'http_status',
            message: `${status} ${method} ${path}`,
            url: fullUrl,
        });
    } else if (!status) {
        // 没有 response = 请求根本没走完：网络断了 / 被拦截 / 15s 超时（ECONNABORTED）
        reportError({
            type: 'fetch_fail',
            message: `${error.code || 'NETWORK'} ${method} ${path}`,
            url: fullUrl,
        });
    }
    // 剩下的情况（401/403 等被 shouldReportStatus 挡掉的）不报：见 reportCore 里那段注释
}

// 添加响应拦截器
http.interceptors.response.use(
    function (response) {
        return response;
    },
    function (error) {
        if (error.response && error.response.status === 401) {
            // 清除本地过期的 token
            const sent = error.config?.headers?.Authorization;
            if (typeof sent !== 'string' || !clearAuthToken(sent)) return Promise.reject(error);
            // 提示用户
            message.error("登录状态已过期，请重新登录");
            // 延时 1 秒后跳转，让用户看得到提示
            setTimeout(() => {
                if (!getToken()) window.location.href = "/login";
            }, 1000);
        // 403 is a permission failure; keep the authenticated session.
        }
        reportApiFailure(error);
        return Promise.reject(error);
    }
);

export default http

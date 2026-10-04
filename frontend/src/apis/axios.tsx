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

/**
 * 把一次 axios 失败送进前端日志（20261004）。
 *
 * axios 是 SPA 唯一的 HTTP 客户端，而它走 **XHR** 适配器 —— `boot.js` 那个
 * `window.fetch` 包装看不见它的失败。没有这一段，"博客自身"（除看板娘之外的全部
 * 请求）接口失败在 `logs/frontend/monitor.log` 里是**完全不存在**的：日志里只有
 * 看板娘的声音，这也是那份日志长期"无效"的一大半原因。
 *
 * 主动取消（路由切换 / 停止生成时 abort）不是故障，与 boot.js 对 AbortError 的取向一致。
 */
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
            localStorage.removeItem("tokenKey");
            // 提示用户
            message.error("登录状态已过期，请重新登录");
            // 延时 1 秒后跳转，让用户看得到提示
            setTimeout(() => {
                window.location.href = "/login";
            }, 1000);
        // 注意：403（token 有效但角色非 admin，AuthRouter 已提示"无权限访问后台"并跳回首页）
        // 不在此处理——token 本身有效，清 token/强制登出会让普通用户陷入
        // "登录→被踢→重新登录"循环，且与 AuthRouter 的提示重复
        }
        reportApiFailure(error);
        return Promise.reject(error);
    }
);

export default http

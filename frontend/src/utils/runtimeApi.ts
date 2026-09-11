export const runtimeBaseURL = import.meta.env.VITE_HTTP_BASEURL || (window.location.port === '4173' || window.location.port === '5173' ? window.location.protocol + "//" + window.location.hostname + ":3000" : '');

/**
 * 静态图片（封面/相册/头像）的 CDN 域名。留空 = 不重写，行为与未接入 CDN 时完全一致，
 * 拿到域名后只改 frontend/.env.production 里的 VITE_CDN_BASEURL 一行 + 重新部署即生效，无需改代码。
 * 只重写 /api/protect/download/ 前缀（图片下载接口）——它是本机 3M 上行的大头。
 */
export const cdnBaseURL = (import.meta.env.VITE_CDN_BASEURL || '').replace(/\/+$/, '');

/** 图片下载接口前缀：只有这个前缀走 CDN */
const CDN_ASSET_PREFIX = '/api/protect/download/';

export const resolveApiAssetUrl = (url?: string) => {
    if (!url) {
        return '';
    }

    if (/^(https?:|data:|blob:)/i.test(url)) {
        return url;
    }

    if (url.startsWith('/api/')) {
        if (cdnBaseURL && url.startsWith(CDN_ASSET_PREFIX)) {
            return `${cdnBaseURL}${url}`;
        }
        return `${runtimeBaseURL}${url}`;
    }

    return url;
};

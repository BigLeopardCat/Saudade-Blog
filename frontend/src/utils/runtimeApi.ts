export const runtimeBaseURL = import.meta.env.VITE_HTTP_BASEURL || (window.location.port === '4173' || window.location.port === '5173' ? window.location.protocol + "//" + window.location.hostname + ":3000" : '');

/** Optional CDN origin for public media only; authenticated API calls stay on the runtime host. */
export const cdnBaseURL = (import.meta.env.VITE_CDN_BASEURL || '').replace(/\/+$/, '');

const CDN_ASSET_PREFIXES = ['/api/protect/download/', '/api/public/media/'];

export const resolveApiAssetUrl = (url?: string) => {
    if (!url) {
        return '';
    }

    if (/^(https?:|data:|blob:)/i.test(url)) {
        return url;
    }

    if (url.startsWith('/api/')) {
        if (cdnBaseURL && CDN_ASSET_PREFIXES.some(prefix => url.startsWith(prefix))) {
            return `${cdnBaseURL}${url}`;
        }
        return `${runtimeBaseURL}${url}`;
    }

    return url;
};

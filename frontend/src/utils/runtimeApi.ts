export const runtimeBaseURL = import.meta.env.VITE_HTTP_BASEURL || (window.location.port === '4173' || window.location.port === '5173' ? window.location.protocol + "//" + window.location.hostname + ":3000" : '');

export const resolveApiAssetUrl = (url?: string) => {
    if (!url) {
        return '';
    }

    if (/^(https?:|data:|blob:)/i.test(url)) {
        return url;
    }

    if (url.startsWith('/api/')) {
        return `${runtimeBaseURL}${url}`;
    }

    return url;
};

import {useEffect} from 'react';
import {useLocation} from 'react-router-dom';

export function useReaderLayout() {
    const {pathname} = useLocation();
    useEffect(() => {
        const article = /^\/article\/[^/]+\/?$/.test(pathname);
        if (article) document.documentElement.dataset.readerArticle = pathname;
        else delete document.documentElement.dataset.readerArticle;
        window.dispatchEvent(new Event('reader-layout-change'));
        return () => {
            delete document.documentElement.dataset.readerArticle;
            window.dispatchEvent(new Event('reader-layout-change'));
        };
    }, [pathname]);
}

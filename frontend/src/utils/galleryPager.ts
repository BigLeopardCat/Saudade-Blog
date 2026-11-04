import { useCallback, useRef, useState } from "react";
import { GALLERY_PAGE_SIZE, getImageList } from "../apis/ImageMethods.tsx";
import type { ImgUrl } from "../interface/ImgTypes";

export function useGalleryPager() {
    const [images, setImages] = useState<ImgUrl[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState('');
    const [hasMore, setHasMore] = useState(false);
    const busy = useRef(false);
    /** 已加载的那一份（`loadMore` 要拿它的尾巴当游标）。用 ref 而不是读 state：
     *  `loadMore` 因此不必依赖 `images`，函数身份稳定（`InfiniteScroll` 的 `next` 每次
     *  渲染都换一个函数会让它自己重新排一轮）。 */
    const loaded = useRef<ImgUrl[]>([]);

    const keep = (rows: ImgUrl[]) => {
        loaded.current = rows;
        setImages(rows);
    };

    /** 从头拉第一页。打开弹窗 / 手动刷新 / 删完图重载都走这条。 */
    const reload = useCallback(async (opts?: { silent?: boolean }) => {
        if (busy.current) return;
        busy.current = true;
        if (!opts?.silent) setLoading(true);
        setError('');
        try {
            const res = await getImageList();
            // 两层都要判：HTTP 200 不代表业务成功（本站信封是 `code`）。
            // 读不到 ≠ 图库是空的——失败要留 error、清空列表，让界面说人话。
            if (res.data?.code !== 200) {
                keep([]);
                setHasMore(false);
                setError(res.data?.message || '图库读取失败');
                return;
            }
            const rows: ImgUrl[] = Array.isArray(res.data?.data) ? res.data.data : [];
            keep(rows);
            setHasMore(rows.length >= GALLERY_PAGE_SIZE);
        } catch {
            keep([]);
            setHasMore(false);
            setError('图库读取失败');
        } finally {
            busy.current = false;
            if (!opts?.silent) setLoading(false);
        }
    }, []);

    /** 续下一页（追加）。返回这次是否真的取到了行——调用方据此决定要不要给反馈。 */
    const loadMore = useCallback(async () => {
        if (busy.current) return false;
        const last = loaded.current[loaded.current.length - 1];
        if (!last) return false; // 空列表：没有游标可传，别发一次注定重复第一页的请求
        busy.current = true;
        setLoadingMore(true);
        try {
            const res = await getImageList(last.imageKey);
            const rows: ImgUrl[] = res.data?.code === 200 && Array.isArray(res.data?.data)
                ? res.data.data
                : [];
            keep([...loaded.current, ...rows]);
            setHasMore(rows.length >= GALLERY_PAGE_SIZE);
            return rows.length > 0;
        } catch {
            // 失败就停在原地：已加载的那些照旧显示，只是没有下一页可点
            //（**不清空**——清掉会让人以为图库忽然空了）
            setHasMore(false);
            return false;
        } finally {
            busy.current = false;
            setLoadingMore(false);
        }
    }, []);

    return { images, loading, loadingMore, error, hasMore, reload, loadMore };
}

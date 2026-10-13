import { useCallback, useRef, useState } from "react";
import { GALLERY_PAGE_SIZE, getImageList } from "../apis/ImageMethods.tsx";
import type { ImgUrl } from "../interface/ImgTypes";

/**
 * 图库分页的取数逻辑（20261014）。三处消费方共用**这一份**：
 *   · `components/Editor/ImagePicker.tsx`（编辑器「从图库选图」）
 *   · `pages/Dashboard/Notes/NewNotes/index.tsx`（文章封面选图）
 *   · `pages/Dashboard/Albums/index.tsx`（图库页，滚动到底自动续）
 *
 * 为什么要抽出来：判据只有两条，而它们必须**三处一致**——
 *   · 下一页的游标 = 已加载的**最后一张**的 `imageKey`（服务端认 `image_key < before`）；
 *   · `hasMore` = 这一次回来的行数 **等于**页大小（服务端不报总数，见下）。
 * 抄成三份的话，"页大小改了"或者"某处把游标写成了第一张"这类错会在三处各自漂，
 * 而页面上的症状（点「载入更多」没反应 / 列表出现重复行）都不好倒推回这里。
 *
 * ⚠️ `hasMore` 是**保守**判据：回来的行数正好等于页大小时它会说"还有"，
 * 而真实情况可能刚好取完 —— 那一次点下去会拿到 0 行、`hasMore` 随之变假，
 * 界面显示「没有更多了」。多一次空请求，换掉的是"要不要给接口加一个 total 字段"
 * （那要改响应信封，三个消费方与两个沙箱套件都认 `data` 是数组）。
 *
 * ⚠️ 取数闸（`busy`）：`InfiniteScroll` 在滚动里会连续触发 `next`，而一次请求要等
 * 一个来回 —— 没有闸就是同一页发两遍，列表里出现**重复行**（同游标、同结果）。
 * `reload` 与 `loadMore` 共用这一个闸：翻页途中来一次背景重拉会打乱已加载的页。
 */
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

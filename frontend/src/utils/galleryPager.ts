import {useMemo} from 'react'
import {galleryApi, galleryError} from '../apis/galleryApi'

export function useGalleryPager(open:boolean) {
    const query=galleryApi.useImagesInfiniteQuery({}, {skip:!open,refetchOnMountOrArgChange:true})
    const images=useMemo(()=>query.data?.pages.flatMap(page=>page.items)??[],[query.data])
    return {
        images,
        loading:open&&(query.isLoading||query.isUninitialized),
        loadingMore:query.isFetchingNextPage,
        error:query.isError&&!images.length?galleryError(query.error):'',
        pageError:query.isError&&!!images.length?galleryError(query.error):'',
        hasMore:!!query.hasNextPage,
        reload:query.refetch,
        loadMore:query.fetchNextPage,
    }
}

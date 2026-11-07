import {Suspense, type ReactNode} from 'react'

export const routePage = (page: ReactNode) => (
    <Suspense fallback={
        <div role="status" aria-label="正在加载页面"
            style={{minHeight: '40vh', display: 'grid', placeItems: 'center'}}>
            <img src="/loading.svg" alt="" aria-hidden="true" width={48} height={48}/>
        </div>
    }>{page}</Suspense>
)

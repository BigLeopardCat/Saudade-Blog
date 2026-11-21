import {Suspense, type ReactNode} from 'react'
import {t, useLocale} from '../i18n'

function RouteLoading() {
    useLocale()
    return <div role="status" aria-label={t('正在加载页面')}
        style={{minHeight: '40vh', display: 'grid', placeItems: 'center'}}>
        <img src="/loading.svg" alt="" aria-hidden="true" width={48} height={48}/>
    </div>
}

export const routePage = (page: ReactNode) => (
    <Suspense fallback={<RouteLoading />}>{page}</Suspense>
)

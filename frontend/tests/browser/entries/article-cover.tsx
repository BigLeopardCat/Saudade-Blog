import '../../../src/index.css'
import '../../../src/frontHome/main.css'
import {lazy} from 'react'
import {createRoot} from 'react-dom/client'
import {Provider} from 'react-redux'
import {HelmetProvider} from 'react-helmet-async'
import {MemoryRouter, Route, Routes} from 'react-router-dom'
import ReadArticle from '../../../src/frontHome/Content/ReadArticle'
import {routePage} from '../../../src/router/RoutePage'
import {useIsDarkMode} from '../../../src/theme'
import store from '../../../src/store'

declare global {
    interface Window { finishRouteLoad?: () => void }
}
const DeferredPage = lazy(() => new Promise<{default: () => JSX.Element}>(resolve => {
    window.finishRouteLoad = () => resolve({default: () => <h1>页面已就绪</h1>})
}))
function Fixture() {
    const dark = useIsDarkMode()
    if (location.hash === '#pending-route') return routePage(<DeferredPage/>)
    return <div className={`frontRoot${dark ? ' frontDark' : ''}`}>
        <button type="button" onClick={() => window.dispatchEvent(
            new CustomEvent('darkmode-change', {detail: !dark}))}>切换主题</button>
        <MemoryRouter initialEntries={[new URLSearchParams(location.hash.slice(1)).get('path') || '/article/1']}>
            <Routes><Route path="/article/:id" element={<ReadArticle/>}/></Routes>
        </MemoryRouter>
    </div>
}
createRoot(document.getElementById('root')!).render(
    <HelmetProvider><Provider store={store}><Fixture/></Provider></HelmetProvider>
)

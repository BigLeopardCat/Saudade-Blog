import '../../../src/index.css'
import '../../../src/frontHome/main.css'
import {createRoot} from 'react-dom/client'
import {lazy} from 'react'
import {HelmetProvider} from 'react-helmet-async'
import {Provider} from 'react-redux'
import {Link, MemoryRouter, Route, Routes} from 'react-router-dom'
import App from '../../../src/App'
import {routePage} from '../../../src/router/RoutePage'
import store from '../../../src/store'

const ReadArticle = lazy(() => import('../../../src/frontHome/Content/ReadArticle'))
const initial = new URLSearchParams(location.hash.slice(1)).get('path') || '/'
createRoot(document.getElementById('root')!).render(<HelmetProvider><Provider store={store}>
    <MemoryRouter initialEntries={[initial]}><Routes><Route path="/" element={<App/>}>
        <Route index element={<main style={{minHeight: '100vh', paddingTop: 120}}><Link to="/article/1">打开示例文章</Link></main>}/>
        <Route path="article/:id" element={routePage(<ReadArticle/>)}/>
    </Route></Routes></MemoryRouter>
</Provider></HelmetProvider>)

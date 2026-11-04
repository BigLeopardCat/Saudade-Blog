import {createRoot} from 'react-dom/client'
import {HelmetProvider} from 'react-helmet-async'
import {MemoryRouter, useLocation, useNavigate} from 'react-router-dom'
import {Provider} from 'react-redux'
import {configureStore} from '@reduxjs/toolkit'
import SeoHelmet from '../../../src/components/SeoHelmet'
import Footer from '../../../src/frontHome/Footer'

const user={blogCopyright:'测试站主',name:'回退作者',blogIcp:'',blogPublicIcp:''}
const store=configureStore({reducer:()=>({user})})
function Pages() {
  const {pathname}=useLocation()
  const navigate=useNavigate()
  const noindex=['/login','/dashboard/users','/missing'].includes(pathname)
  return <>
    <SeoHelmet title={pathname==='/article/23'?'测试文章':'测试页面'}
      description="页面独立摘要" image={pathname==='/guestbook'?'http://[invalid':'//cdn.example.test/cover.webp'} noindex={noindex}/>
    {['/article/23','/login','/dashboard/users','/missing','/guestbook'].map(path=><button
      key={path} onClick={()=>navigate(path)}>{path}</button>)}
    <Footer/>
  </>
}
createRoot(document.getElementById('root')!).render(<Provider store={store}>
  <HelmetProvider><MemoryRouter initialEntries={['/article/23']}><Pages/></MemoryRouter></HelmetProvider>
</Provider>)

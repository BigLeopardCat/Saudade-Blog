import '../../../src/index.css'
import {createRoot} from 'react-dom/client'
import {MemoryRouter,Route,Routes} from 'react-router-dom'
import {Provider} from 'react-redux'
import {HelmetProvider} from 'react-helmet-async'
import Dashboard from '../../../src/pages/Dashboard'
import Albums from '../../../src/pages/Dashboard/Albums'
import Talks from '../../../src/pages/Dashboard/Talks'
import store from '../../../src/store'

const route=location.hash.slice(1)||'albums'
localStorage.setItem('tokenKey',`h.${btoa(JSON.stringify({sub:7,role:'admin',exp:Date.now()/1000+600}))}.s`)
createRoot(document.getElementById('root')!).render(<HelmetProvider><Provider store={store}>
  <MemoryRouter initialEntries={['/dashboard/'+route]}><Routes>
    <Route path="/dashboard" element={<Dashboard/>}>
      <Route path="albums" element={<Albums/>}/>
      <Route path="talks" element={<Talks/>}/>
      <Route path="future" element={<section><h1>长业务页面</h1>{Array.from({length:100},(_,i)=><p key={i} style={{padding:12}}>业务项目 {i}</p>)}<button>页面最后一个操作</button></section>}/>
    </Route>
  </Routes></MemoryRouter>
</Provider></HelmetProvider>)

import {createRoot} from 'react-dom/client'
import {Provider} from 'react-redux'
import {MemoryRouter, Route, Routes} from 'react-router-dom'
import store from '../../../src/store'
import '../../../src/pages/Dashboard/index.css'
import Notes from '../../../src/pages/Dashboard/Notes'
import NewNotes from '../../../src/pages/Dashboard/Notes/NewNotes'

localStorage.setItem('tokenKey', 'offline-editor-fixture')
store.dispatch({type:'categories/setCategories',payload:[{categoryKey:1,key:1,categoryTitle:'测试分类'}]})
createRoot(document.getElementById('root')!).render(<Provider store={store}>
  <MemoryRouter initialEntries={['/dashboard/notes/newnote/7']}><Routes>
    <Route path="/dashboard/notes" element={<main className="dashboardPage" style={{height:"calc(100dvh - 32px)"}}><Notes/></main>}>
      <Route index element={<h1>文章列表</h1>}/>
      <Route path="newnote/:id" element={<NewNotes/>}/>
    </Route>
  </Routes></MemoryRouter>
</Provider>)

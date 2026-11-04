import {createRoot} from 'react-dom/client'
import {Provider} from 'react-redux'
import {MemoryRouter, Route, Routes} from 'react-router-dom'
import store from '../../../src/store'
import NewNotes from '../../../src/pages/Dashboard/Notes/NewNotes'

localStorage.setItem('tokenKey', 'offline-editor-fixture')
store.dispatch({type:'categories/setCategories',payload:[{categoryKey:1,key:1,categoryTitle:'测试分类'}]})
createRoot(document.getElementById('root')!).render(<Provider store={store}>
  <MemoryRouter initialEntries={['/edit/7']}><Routes>
    <Route path="/edit/:id" element={<NewNotes/>}/>
    <Route path="/dashboard/notes" element={<h1>文章列表</h1>}/>
  </Routes></MemoryRouter>
</Provider>)

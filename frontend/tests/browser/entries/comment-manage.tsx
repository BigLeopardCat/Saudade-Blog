import '../../../src/pages/Dashboard/index.css'
import {createRoot} from 'react-dom/client'
import {Provider} from 'react-redux'
import store from '../../../src/store'
import CommentManage from '../../../src/pages/Dashboard/CommentManage'

const claims = btoa(JSON.stringify({sub:7,role:'admin',exp:Math.floor(Date.now()/1000)+3600}))
localStorage.setItem('tokenKey',`header.${claims}.offline`)
createRoot(document.getElementById('root')!).render(<Provider store={store}>
  <div style={{height:'100vh',boxSizing:'border-box'}}><CommentManage /></div>
</Provider>)

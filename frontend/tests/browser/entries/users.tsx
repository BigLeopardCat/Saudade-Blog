import '../../../src/pages/Dashboard/index.css'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Provider } from 'react-redux'
import store from '../../../src/store'
import Users from '../../../src/pages/Dashboard/Users'

createRoot(document.getElementById('root')!).render(<Provider store={store}>
  <BrowserRouter><div style={{ height: 700 }}><Users /></div></BrowserRouter>
</Provider>)

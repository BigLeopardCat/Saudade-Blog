import '../../../src/index.css'
import {createRoot} from 'react-dom/client'
import {MemoryRouter, Route, Routes} from 'react-router-dom'
import {Provider} from 'react-redux'
import {HelmetProvider} from 'react-helmet-async'
import store from '../../../src/store'
import Dashboard from '../../../src/pages/Dashboard'
import Users from '../../../src/pages/Dashboard/Users'
createRoot(document.getElementById('root')!).render(<HelmetProvider><Provider store={store}>
<MemoryRouter initialEntries={['/dashboard/users']}><Routes>
<Route path="/dashboard" element={<Dashboard />}><Route path="users" element={<Users />}/></Route>
</Routes></MemoryRouter></Provider></HelmetProvider>)

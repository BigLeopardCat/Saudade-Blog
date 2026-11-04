import {createRoot} from 'react-dom/client'
import {Provider} from 'react-redux'
import {MemoryRouter} from 'react-router-dom'
import store from '../../../src/store'
import Albums from '../../../src/pages/Dashboard/Albums'

localStorage.setItem('tokenKey','offline-gallery-admin')
createRoot(document.getElementById('root')!).render(<Provider store={store}><MemoryRouter><Albums/></MemoryRouter></Provider>)

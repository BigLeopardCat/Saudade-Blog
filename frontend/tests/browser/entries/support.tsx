import {createRoot} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import Support from '../../../src/pages/Support'
createRoot(document.getElementById('root')!).render(<MemoryRouter><Support staff={location.hash === '#staff'}/></MemoryRouter>)

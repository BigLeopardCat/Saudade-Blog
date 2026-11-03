import '../../../src/index.css'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import store from '../../../src/store'
import UserCenter from '../../../src/components/UserCenter'
createRoot(document.getElementById('root')!).render(<Provider store={store}><MemoryRouter>
  <UserCenter open onClose={() => undefined} />
</MemoryRouter></Provider>)

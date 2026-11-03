import {createRoot} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import UserControl from '../../../src/pages/Dashboard/UserControl'

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[{pathname: '/dashboard/usercontrol', state: {tab: '4'}}]}>
    <UserControl/>
  </MemoryRouter>,
)

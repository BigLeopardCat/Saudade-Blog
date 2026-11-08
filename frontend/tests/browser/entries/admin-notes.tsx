import {createRoot} from 'react-dom/client'
import {Provider} from 'react-redux'
import {MemoryRouter, useLocation} from 'react-router-dom'
import store from '../../../src/store'
import AllNotes from '../../../src/pages/Dashboard/Notes/AllNotes'

function Location(){return <output data-testid="location">{useLocation().search}</output>}
const search=new URLSearchParams(location.hash.slice(1)).get('query')??''
createRoot(document.getElementById('root')!).render(<Provider store={store}>
  <MemoryRouter initialEntries={['/dashboard/notes/allnotes'+search]}>
    <Location/><AllNotes/>
  </MemoryRouter>
</Provider>)

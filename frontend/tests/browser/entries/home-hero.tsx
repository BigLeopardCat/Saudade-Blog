import '../../../src/index.css'
import '../../../src/frontHome/main.css'
import '../../../src/App.sass'
import {createRoot} from 'react-dom/client'
import {HelmetProvider} from 'react-helmet-async'
import {Provider} from 'react-redux'
import {MemoryRouter} from 'react-router-dom'
import store from '../../../src/store'
import ContentHome from '../../../src/frontHome/Content/ContentHome'
createRoot(document.getElementById('root')!).render(<HelmetProvider><Provider store={store}>
  <MemoryRouter><div className="frontRoot"><ContentHome/></div></MemoryRouter>
</Provider></HelmetProvider>)

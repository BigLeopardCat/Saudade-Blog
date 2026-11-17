import {createRoot} from 'react-dom/client'
import {Provider} from 'react-redux'
import store from '../../../src/store'
import FeaturedPhotoSettings from '../../../src/pages/Dashboard/UserControl/FeaturedPhotoSettings'
createRoot(document.getElementById('root')!).render(<Provider store={store}><FeaturedPhotoSettings/></Provider>)

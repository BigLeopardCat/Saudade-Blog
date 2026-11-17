import {createRoot} from 'react-dom/client'
import FeaturedPhotos from '../../../src/frontHome/Content/ContentHome/FeaturedPhotos'
import '../../../src/scene.css'
createRoot(document.getElementById('root')!).render(<div className="heroRight" style={{width: 480, height: 320, margin: '120px auto'}}><FeaturedPhotos/></div>)

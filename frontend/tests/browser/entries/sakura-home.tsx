import '../../../src/index.css'
import '../../../src/frontHome/main.css'
import '../../../src/App.sass'
import {createRoot} from 'react-dom/client'
import {HelmetProvider} from 'react-helmet-async'
import {Provider} from 'react-redux'
import {MemoryRouter} from 'react-router-dom'
import {readDarkMode} from '../../../src/theme'
import {useState} from 'react'
import store from '../../../src/store'
import Head from '../../../src/frontHome/Head'
import Footer from '../../../src/frontHome/Footer'
import ContentHome from '../../../src/frontHome/Content/ContentHome'
function SceneHome() {
    const [dark, setDark] = useState(readDarkMode)
    return <div className={dark ? 'frontRoot frontDark' : 'frontRoot'}>
        <Head isDark={dark} setDark={setDark} scrollHeight={0}/><ContentHome/><Footer/>
    </div>
}
createRoot(document.getElementById('root')!).render(<HelmetProvider><Provider store={store}><MemoryRouter><SceneHome/></MemoryRouter></Provider></HelmetProvider>)

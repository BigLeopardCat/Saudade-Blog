import '../../../src/index.css'
import '../../../src/frontHome/main.css'
import '../../../src/App.sass'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { useState } from 'react'
import store from '../../../src/store'
import Head from '../../../src/frontHome/Head'

function PublicShell() {
  const location = useLocation()
  const [dark, setDark] = useState(false)
  return <div className={dark ? 'frontRoot frontDark' : 'frontRoot'}>
    <output hidden data-testid="location">{location.pathname + location.search}</output>
    <Head isDark={dark} setDark={setDark} scrollHeight={0} />
    <main aria-label="首页内容" style={{ minHeight: '150vh', background: 'var(--washi-theme-bg)' }}>首页内容</main>
  </div>
}
createRoot(document.getElementById('root')!).render(<Provider store={store}><MemoryRouter><PublicShell /></MemoryRouter></Provider>)

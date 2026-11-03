import '../../../src/index.css'
import { ConfigProvider, theme } from 'antd'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import AnnouncementModal from '../../../src/components/AnnouncementModal'
import { useIsDarkMode } from '../../../src/theme'

function Fixture() {
  const [mounted, setMounted] = useState(true)
  const dark = useIsDarkMode()
  return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
    <button onClick={() => setMounted(value => !value)}>切换挂载</button>
    {mounted && <AnnouncementModal />}
  </ConfigProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)

import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import Announcement from '../../../src/pages/Dashboard/Announcement'

export function AnnouncementHarness() {
  const [mounted, setMounted] = useState(true)
  return <ConfigProvider locale={zhCN} theme={{ token: { fontFamily: '"Noto Sans CJK SC", sans-serif' } }}>
    <button onClick={() => setMounted(value => !value)}>切换挂载</button>
    {mounted && <Announcement />}
  </ConfigProvider>
}
createRoot(document.getElementById('root')!).render(<AnnouncementHarness />)

import '../../../src/pages/Dashboard/index.css'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import store from '../../../src/store'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import AllTag from '../../../src/pages/Dashboard/Notes/AllTag'

createRoot(document.getElementById('root')!).render(<Provider store={store}>
  <ConfigProvider locale={zhCN} theme={{ token: { fontFamily: '"Noto Sans CJK SC", sans-serif', colorPrimary: '#d94f9a', screenLG: 1024 } }}><AllTag /></ConfigProvider>
</Provider>)

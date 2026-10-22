import '../../../src/pages/Dashboard/index.css'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import AllCategorize from '../../../src/pages/Dashboard/Notes/AllCategorize'

const store = configureStore({ reducer: { harness: () => null } })
createRoot(document.getElementById('root')!).render(<Provider store={store}>
  <ConfigProvider locale={zhCN} theme={{ token: { fontFamily: '"Noto Sans CJK SC", sans-serif', colorPrimary: '#d94f9a', screenLG: 1024 } }}><AllCategorize /></ConfigProvider>
</Provider>)

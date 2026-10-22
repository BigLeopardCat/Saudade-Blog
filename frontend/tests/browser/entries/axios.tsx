import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import http from '../../../src/apis/axios'

export function ClientHarness() {
  const [result, setResult] = useState('idle')
  const request = (path: string) => {
    setResult('pending')
    void http.get(`/api/${path}`).then(
      response => setResult(`success:${response.status}`),
      error => setResult(`failure:${error.response?.status}`),
    )
  }
  return <><button onClick={() => request('check')}>请求</button><output aria-label="请求结果">{result}</output></>
}
createRoot(document.getElementById('root')!).render(<ClientHarness />)

import { describe, expect, it, vi } from 'vitest'
import { locate } from '../../src/components/ArticleGraph/locate'
import type { GraphData } from '../../src/components/ArticleGraph/types'
const data = {nodes:[{i:0,w:'Python',x:0,y:0,z:0,n:1,a:0,a2:0}],articles:[],edges:[]} as unknown as GraphData
const response = (json: unknown) => new Response(JSON.stringify(json), {status:200})
describe('optional semantic graph lookup', () => {
  it('does not call the agent for anonymous queries', async () => {
    const fetch = vi.fn();vi.stubGlobal('fetch',fetch)
    const result = await locate('Python',data)
    expect(result.source).toBe('local');expect(result.reason).toBe('login_required')
    expect(result.hits[0].w).toBe('Python');expect(fetch).not.toHaveBeenCalled()
  })
  it('labels unavailable services and rejects mismatched nodes', async () => {
    localStorage.setItem('tokenKey','fixture')
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({ok:true,words:[{w:'wrong-version',s:1},{w:'Python',s:'bad'}]})))
    expect((await locate('Python',data)).reason).toBe('service_unavailable')
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({ok:true,words:[{w:'python',s:0.9}]})))
    expect(await locate('Python',data)).toEqual({source:'vector',hits:[{w:'python',s:0.9}]})
  })
  it('cancels work without silently producing local results', async () => {
    localStorage.setItem('tokenKey','fixture')
    const controller = new AbortController()
    vi.stubGlobal('fetch',vi.fn((_url: string, init: RequestInit) => new Promise((_resolve,reject) => {
      init.signal?.addEventListener('abort',() => reject(new DOMException('Aborted','AbortError')))
    })))
    const pending = locate('Python',data,controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({name:'AbortError'})
  })
})

it('rejects corrupt graph coordinates and dangling references before rendering', async () => {
  const {isGraphData}=await import('../../src/components/ArticleGraph/loader')
  const valid={...data,v:'fixture',articles:[{id:5,t:'Python'}]}
  expect(isGraphData(valid)).toBe(true)
  expect(isGraphData({...valid,nodes:[{...data.nodes[0],a:7}]})).toBe(false)
  expect(isGraphData({...valid,nodes:[{...data.nodes[0],x:NaN}]})).toBe(false)
  expect(isGraphData({...valid,edges:[[0,1,0.5]]})).toBe(false)
})

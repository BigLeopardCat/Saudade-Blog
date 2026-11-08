import {test,expect} from './sandbox'
import type {Page,Route} from '@playwright/test'

test.use({entry:'admin-notes',viewport:{width:1400,height:950}})
const row=(id:number,title='文章')=>({noteKey:id,noteTitle:title+id,cover:'',noteCategory:null,
  noteTags:'',isTop:0,status:'public',createTime:'2026-01-01',updateTime:'2026-01-01'})
const page=(items:ReturnType<typeof row>[],total=1003,current=1,size=10)=>
  ({code:200,data:{items,total,page:current,pageSize:size}})
const deferred=()=>{let release!:()=>void;const ready=new Promise<void>(resolve=>{release=resolve});return {ready,release}}
async function mock(page:Page,handle:(route:Route,url:URL)=>Promise<void>){
  const calls:URL[]=[]
  await page.route('**/api/**',route=>route.fulfill({json:{code:200,data:[]}}))
  await page.route('**/api/protected/notes?**',async route=>{
    const url=new URL(route.request().url());calls.push(url);await handle(route,url)
  })
  return calls
}

test('server pages keep deep links, transmit filters and read only the requested window',async({page:browser,sandboxURL})=>{
  const calls=await mock(browser,async(route,url)=>{
    const current=Number(url.searchParams.get('page')),size=Number(url.searchParams.get('page_size'))
    const items=Array.from({length:size},(_,i)=>row(1004-((current-1)*size+i)))
    await route.fulfill({json:page(items,1003,current,size)})
  })
  await browser.goto(sandboxURL+'#query='+encodeURIComponent('?tab=3&page=3&size=20'))
  await expect(browser.locator('.ant-table-tbody .ant-table-row')).toHaveCount(20)
  expect(calls.map(url=>Object.fromEntries(url.searchParams))).toEqual([
    {page:'3',page_size:'20',status:'draft'},
  ])
  await browser.locator('.ant-pagination-item-4').click()
  await expect.poll(()=>calls.length).toBe(2)
  expect(calls[1].searchParams.get('page')).toBe('4')
  await expect(browser.getByTestId('location')).toContainText('page=4')
  await browser.getByLabel('文章标题',{exact:true}).fill('目标')
  await browser.getByRole('button',{name:/^搜\s*索$/}).click()
  await expect.poll(()=>calls.length).toBe(3)
  expect(calls[2].searchParams.get('page')).toBe('1')
  expect(calls[2].searchParams.get('title')).toBe('目标')
  expect(calls[2].searchParams.get('status')).toBe('draft')
})

test('business failures preserve confirmed rows and expose retry instead of an empty result',async({page:browser,sandboxURL})=>{
  let fail=false
  const calls=await mock(browser,async route=>{
    await route.fulfill({json:fail?{code:500,message:'database unavailable',data:null}:page([row(1003)],1)})
  })
  await browser.goto(sandboxURL)
  await expect(browser.getByText('文章1003',{exact:true})).toBeVisible()
  fail=true
  await browser.getByRole('button',{name:'刷新文章列表',exact:true}).click()
  await expect(browser.getByRole('alert')).toContainText('文章列表加载失败')
  await expect(browser.getByText('文章1003',{exact:true})).toBeVisible()
  await expect(browser.getByText('没有符合条件的文章',{exact:true})).toHaveCount(0)
  fail=false
  await browser.getByRole('alert').getByRole('button',{name:/^重\s*试$/}).click()
  await expect(browser.getByRole('alert')).toHaveCount(0)
  expect(calls).toHaveLength(3)
})

test('late old-filter data cannot replace the current selection',async({page:browser,sandboxURL})=>{
  const old=deferred()
  const calls=await mock(browser,async(route,url)=>{
    const title=url.searchParams.get('title')
    if(title==='slow')await old.ready
    await route.fulfill({json:page([row(title==='new'?2:1,title==='new'?'新结果':'旧结果')],1)})
  })
  await browser.goto(sandboxURL)
  const title=browser.getByLabel('文章标题',{exact:true})
  await title.fill('slow');await browser.getByRole('button',{name:/^搜\s*索$/}).click()
  await expect.poll(()=>calls.length).toBe(2)
  await title.fill('new');await browser.getByRole('button',{name:/^搜\s*索$/}).click()
  await expect(browser.getByText('新结果2',{exact:true})).toBeVisible()
  const finished=browser.waitForResponse(response=>new URL(response.url()).searchParams.get('title')==='slow')
  old.release();await finished
  await expect(browser.getByText('新结果2',{exact:true})).toBeVisible()
  await expect(browser.getByText('旧结果1',{exact:true})).toHaveCount(0)
})


test('chat and unapproved preparations do not reload articles; a confirmation attempt refreshes the same page',async({page:browser,sandboxURL})=>{
  const calls=await mock(browser,async(route,url)=>{
    await route.fulfill({json:page([row(9)],21,Number(url.searchParams.get('page')))})
  })
  await browser.goto(sandboxURL+'#query='+encodeURIComponent('?page=2'))
  await expect(browser.getByText('文章9',{exact:true})).toBeVisible()
  expect(calls).toHaveLength(1)
  await browser.evaluate(()=>{
    for(const detail of [undefined,{confirmationAttempted:false},{articleIdsToRefresh:[9]}])
      window.dispatchEvent(new CustomEvent('agent-turn-done',{detail}))
  })
  // Flush browser effects; an ignored event must never enqueue a query.
  await browser.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  expect(calls).toHaveLength(1)
  await browser.evaluate(()=>window.dispatchEvent(new CustomEvent('agent-turn-done',{
    detail:{confirmationAttempted:true,articleIdsToRefresh:[9]}})))
  await expect.poll(()=>calls.length).toBe(2)
  expect(calls[1].searchParams.get('page')).toBe('2')
})

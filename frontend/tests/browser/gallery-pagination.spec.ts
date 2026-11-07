import {test,expect} from './sandbox'
import type {Page} from '@playwright/test'
import type {GalleryFolder,GalleryImage,GalleryPage} from '../../src/apis/galleryApi'

declare global {
  interface Window {readonly galleryObservers?:{root:string|null}[]}
}

test.use({entry:'dashboard-pages',viewport:{width:1280,height:540}})

type Listing={before:number|null;folderId:number|null;search:string|null}
type ListingResponse=GalleryPage|{error:string}

const image=(id:number,name='图片'):GalleryImage=>({imageKey:id,imageUrl:'/fixture/gallery.svg',
  displayName:name+id,description:'分页测试',folderId:0,isFavorite:false,version:'a'.repeat(64)})
const rows=(start:number,count:number)=>Array.from({length:count},(_,index)=>image(start-index))
const deferred=()=>{
  let release!:()=>void
  const ready=new Promise<void>(resolve=>{release=resolve})
  return {ready,release}
}

async function mockGallery(page:Page,list:(input:Listing)=>ListingResponse|Promise<ListingResponse>,
  folders:GalleryFolder[]=[]){
  const calls:Listing[]=[]
  await page.route('**/live2d-widgets/**',route=>route.fulfill({contentType:'application/javascript',body:''}))
  await page.route('**/default-avatar.png',route=>route.fulfill({status:204}))
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname
    let data:unknown=[]
    if(path.endsWith('/profile'))data={id:7,username:'tester',nickname:'Tester',role:'admin'}
    if(path.endsWith('/gallery/folders'))data=folders
    if(path.endsWith('/images/r2'))data={enabled:false,configured:false,usedBytes:0,limitBytes:100,publicBase:''}
    return route.fulfill({json:{code:200,data}})
  })
  await page.route('**/api/protect/gallery/images**',async route=>{
    const url=new URL(route.request().url())
    const number=(key:string)=>url.searchParams.has(key)?Number(url.searchParams.get(key)):null
    const input={before:number('before'),folderId:number('folderId'),search:url.searchParams.get('search')}
    calls.push(input)
    expect(route.request().method()).toBe('GET')
    expect(url.searchParams.get('limit')).toBe('30')
    const result=await list(input)
    if('error' in result)await route.fulfill({status:503,json:{code:503,message:result.error}})
    else await route.fulfill({json:{code:200,data:result}})
  })
  await page.route('**/fixture/gallery.svg',route=>route.fulfill({contentType:'image/svg+xml',
    body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="pink"/></svg>'}))
  return calls
}

async function scrollBottom(page:Page,mobile=false){
  if(mobile)await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight))
  else await page.getByRole('main',{name:'后台内容'}).evaluate(el=>{el.scrollTop=el.scrollHeight})
}

async function settleLayout(page:Page){
  await page.evaluate(()=>new Promise<void>(resolve=>{
    requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))
  }))
}

for(const mobile of [false,true]){
  test(`${mobile?'mobile document':'desktop main'} loads the next cursor once and stops at the end`,async({page,sandboxURL})=>{
    if(mobile)await page.setViewportSize({width:390,height:660})
    const calls=await mockGallery(page,({before})=>before===null
      ?{items:rows(60,30),nextCursor:31}:{items:rows(30,30),nextCursor:null})
    await page.goto(sandboxURL)
    await expect(page.locator('.albumTile')).toHaveCount(30)
    await expect(page.getByRole('button',{name:'加载更多',exact:true})).toHaveCount(0)
    expect(calls.map(call=>call.before)).toEqual([null])
    await scrollBottom(page,mobile)
    await expect(page.locator('.albumTile')).toHaveCount(60)
    expect(calls.map(call=>call.before)).toEqual([null,31])
    const names=await page.locator('.albumName').allTextContents()
    expect(names).toEqual(Array.from({length:60},(_,index)=>'图片'+(60-index)))
    expect(new Set(names).size).toBe(60)
    const main=page.getByRole('main',{name:'后台内容'})
    if(mobile){
      expect(await page.evaluate(()=>window.scrollY)).toBeGreaterThan(0)
      expect(await main.evaluate(el=>el.scrollTop)).toBe(0)
    }else{
      expect(await main.evaluate(el=>el.scrollTop)).toBeGreaterThan(0)
      expect(await page.evaluate(()=>window.scrollY)).toBe(0)
    }
    await expect(page.getByText('已显示全部图片',{exact:true})).toBeVisible()
    await scrollBottom(page,mobile)
    await page.evaluate(()=>window.dispatchEvent(new Event('resize')))
    await settleLayout(page)
    expect(calls.map(call=>call.before)).toEqual([null,31])
  })
}

test('an underfilled first screen keeps fetching cursors without requiring a scroll event',async({page,sandboxURL})=>{
  await page.setViewportSize({width:1280,height:1400})
  const calls=await mockGallery(page,({before})=>before===null?{items:[image(3)],nextCursor:3}
    :before===3?{items:[image(2)],nextCursor:2}:{items:[image(1)],nextCursor:null})
  await page.goto(sandboxURL)
  await expect(page.locator('.albumTile')).toHaveCount(3)
  await expect(page.getByText('已显示全部图片',{exact:true})).toBeVisible()
  expect(calls.map(call=>call.before)).toEqual([null,3,2])
  expect(await page.getByRole('main',{name:'后台内容'}).evaluate(el=>el.scrollTop)).toBe(0)
  expect(await page.evaluate(()=>window.scrollY)).toBe(0)
})

test('a failed page retains existing images, stops automatic retries and retries that cursor explicitly',async({page,sandboxURL})=>{
  const retry=deferred()
  let attempts=0
  const calls=await mockGallery(page,async({before})=>{
    if(before===null)return {items:rows(12,2),nextCursor:11}
    attempts++
    if(attempts===1)return {error:'图库暂时不可用'}
    await retry.ready
    return {items:rows(10,2),nextCursor:null}
  })
  await page.goto(sandboxURL)
  await expect(page.getByRole('alert')).toContainText('图库暂时不可用')
  await expect(page.locator('.albumTile')).toHaveCount(2)
  expect(calls.map(call=>call.before)).toEqual([null,11])
  await page.setViewportSize({width:1270,height:560})
  await scrollBottom(page)
  await settleLayout(page)
  expect(calls.map(call=>call.before)).toEqual([null,11])
  await page.getByRole('alert').getByRole('button',{name:'重试',exact:true}).click()
  await expect.poll(()=>calls.length).toBe(3)
  await page.evaluate(()=>{
    for(let index=0;index<5;index++)window.dispatchEvent(new Event('resize'))
  })
  await settleLayout(page)
  expect(calls.map(call=>call.before)).toEqual([null,11,11])
  retry.release()
  await expect(page.locator('.albumTile')).toHaveCount(4)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(await page.locator('.albumName').allTextContents()).toEqual(['图片12','图片11','图片10','图片9'])
  expect(calls.map(call=>call.before)).toEqual([null,11,11])
})

test('a failed first page retries the initial request without inventing an empty gallery',async({page,sandboxURL})=>{
  let failed=true
  const calls=await mockGallery(page,()=>failed?{error:'首页加载失败'}
    :{items:[image(1)],nextCursor:null})
  await page.goto(sandboxURL)
  await expect(page.getByRole('alert')).toContainText('首页加载失败')
  await expect(page.getByText('这里还没有图片',{exact:true})).toHaveCount(0)
  await expect(page.locator('.albumTile')).toHaveCount(0)
  await page.evaluate(()=>window.dispatchEvent(new Event('resize')))
  await settleLayout(page)
  expect(calls.map(call=>call.before)).toEqual([null])
  failed=false
  await page.getByRole('alert').getByRole('button',{name:'重试',exact:true}).click()
  await expect(page.getByRole('button',{name:'查看图片 图片1',exact:true})).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(calls.map(call=>call.before)).toEqual([null,null])
})

test('folder and search changes clear old results while an earlier page is still in flight',async({page,sandboxURL})=>{
  const old=deferred(),folder=deferred(),search=deferred()
  const calls=await mockGallery(page,async({before,folderId,search:term})=>{
    if(term){await search.ready;return {items:[image(301,'搜索结果')],nextCursor:null}}
    if(folderId===10){
      if(before===null){await folder.ready;return {items:[image(210,'分类'),image(209,'分类')],nextCursor:209}}
      return {items:[image(208,'分类')],nextCursor:null}
    }
    if(before===null)return {items:rows(60,30),nextCursor:31}
    await old.ready
    return {items:rows(30,30),nextCursor:1}
  },[{id:10,parentId:0,name:'封面',imageCount:3}])
  await page.goto(sandboxURL)
  await expect(page.locator('.albumTile')).toHaveCount(30)
  await scrollBottom(page)
  await expect.poll(()=>calls.map(call=>call.before)).toEqual([null,31])
  await page.getByRole('navigation',{name:'图库分类'}).getByRole('tab').filter({hasText:'封面'}).click()
  await expect.poll(()=>calls.at(-1)?.folderId).toBe(10)
  await expect(page.locator('.albumTile')).toHaveCount(0)
  folder.release()
  await expect(page.locator('.albumTile')).toHaveCount(3)
  expect(calls.filter(call=>call.folderId===10).map(call=>call.before)).toEqual([null,209])
  const oldResponse=page.waitForResponse(response=>{
    const url=new URL(response.url())
    return url.pathname==='/api/protect/gallery/images'&&url.searchParams.get('before')==='31'
      &&!url.searchParams.has('folderId')
  })
  old.release()
  await oldResponse
  await settleLayout(page)
  expect(await page.locator('.albumName').allTextContents()).toEqual(['分类210','分类209','分类208'])
  await page.getByLabel('搜索图库').fill('封面关键词')
  await page.getByLabel('搜索图库').press('Enter')
  await expect.poll(()=>calls.at(-1)?.search).toBe('封面关键词')
  await expect(page.locator('.albumTile')).toHaveCount(0)
  search.release()
  await expect(page.getByRole('button',{name:'查看图片 搜索结果301',exact:true})).toBeVisible()
  await expect(page.locator('.albumTile')).toHaveCount(1)
  expect(calls.filter(call=>call.search).map(call=>call.before)).toEqual([null])
})

test('changing between internal and document scrolling rebinds the observer and unmount disconnects it',async({page,sandboxURL})=>{
  await page.addInitScript(()=>{
    const Native=window.IntersectionObserver
    const active=new Set<IntersectionObserver>()
    window.IntersectionObserver=class extends Native{
      observe(target:Element){if(target.classList.contains('albumMore'))active.add(this);super.observe(target)}
      disconnect(){active.delete(this);super.disconnect()}
    }
    Object.defineProperty(window,'galleryObservers',{get:()=>[...active].map(observer=>({
      root:observer.root instanceof Element?observer.root.className:null,
    }))})
  })
  const calls=await mockGallery(page,({before})=>before===null
    ?{items:rows(60,30),nextCursor:31}:{items:rows(30,30),nextCursor:null})
  await page.goto(sandboxURL)
  const observers=()=>page.evaluate(()=>window.galleryObservers)
  await expect.poll(observers).toEqual([{root:'dashboardPage'}])
  await page.setViewportSize({width:390,height:660})
  await expect.poll(observers).toEqual([{root:null}])
  await page.setViewportSize({width:1280,height:540})
  await expect.poll(observers).toEqual([{root:'dashboardPage'}])
  await page.locator('.shell-nav .menu-links .nav-links').filter({hasText:'说说'}).click()
  await expect(page.locator('.albumLibrary')).toHaveCount(0)
  await expect.poll(observers).toEqual([])
  await page.evaluate(()=>window.dispatchEvent(new Event('resize')))
  await settleLayout(page)
  expect(await observers()).toEqual([])
  expect(calls.map(call=>call.before)).toEqual([null])
})

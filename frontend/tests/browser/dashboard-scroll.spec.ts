import {test,expect} from './sandbox'

test.use({entry:'dashboard-pages',viewport:{width:1280,height:540}})

async function mock(page:import('@playwright/test').Page){
  await page.route('**/live2d-widgets/**',route=>route.fulfill({contentType:'application/javascript',body:''}))
  await page.route('**/default-avatar.png',route=>route.fulfill({status:204}))
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname
    let data:unknown=[]
    if(path.endsWith('/profile'))data={id:7,username:'tester',nickname:'Tester',role:'admin'}
    if(path.endsWith('/gallery/images'))data={items:Array.from({length:30},(_,i)=>({imageKey:30-i,imageUrl:'/fixture/picture.png',displayName:'图片'+(30-i),description:'山景封面',folderId:0,isFavorite:false,version:'a'.repeat(64)})),nextCursor:null}
    if(path.endsWith('/images/r2'))data={enabled:false,configured:false,usedBytes:0,limitBytes:100,publicBase:''}
    if(path==='/api/public/talk')data=Array.from({length:30},(_,i)=>({talkKey:i+1,talkTitle:'说说'+i,content:'长列表测试',createdAt:'2026-11-04 12:00:00',createdTime:'2026-11-04 12:00:00'}))
    return route.fulfill({json:{code:200,data}})
  })
  await page.route('**/fixture/picture.png',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')}))
}

test('gallery scrolls inside the dashboard and grid checkboxes sit in the upper right',async({page,sandboxURL})=>{
  await mock(page);await page.goto(sandboxURL)
  const main=page.getByRole('main',{name:'后台内容'})
  await expect(page.getByRole('button',{name:'查看图片 图片30',exact:true})).toBeVisible()
  const checkbox=page.getByRole('checkbox',{name:'选择图片 图片30',exact:true})
  const tile=checkbox.locator('xpath=ancestor::*[contains(@class,"albumTile")]')
  const bounds=await tile.boundingBox(),tick=await checkbox.boundingBox()
  expect(tick!.y-bounds!.y).toBeLessThan(35)
  expect(bounds!.x+bounds!.width-tick!.x).toBeLessThan(55)
  await checkbox.check()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await main.focus();await page.keyboard.press('Control+End')
  await expect.poll(()=>main.evaluate(el=>el.scrollTop)).toBeGreaterThan(200)
  await expect(page.getByRole('button',{name:'查看图片 图片1',exact:true})).toBeInViewport()
  expect(await page.evaluate(()=>window.scrollY)).toBe(0)
})

for(const viewport of [{width:1280,height:540},{width:390,height:660}]){
  test(`image details keep action buttons within ${viewport.width}×${viewport.height}`,async({page,sandboxURL})=>{
    await page.setViewportSize(viewport);await mock(page);await page.goto(sandboxURL)
    await page.getByRole('button',{name:'查看图片 图片30',exact:true}).click()
    const dialog=page.getByRole('dialog',{name:'图片30',exact:true})
    await expect(dialog).toBeVisible()
    for(const label of ['重命名','移动到',/^删\s*除$/,/^关\s*闭$/]){
      const button=dialog.getByRole('button',{name:label,exact:true})
      await expect(button).toBeInViewport()
      const box=await button.boundingBox()
      expect(box!.y+box!.height).toBeLessThanOrEqual(viewport.height)
    }
    await dialog.getByRole('button',{name:'重命名',exact:true}).click()
    await expect(dialog.getByRole('button',{name:'保存名称'})).toBeVisible()
    await expect(dialog.getByRole('button',{name:/^关\s*闭$/})).toBeInViewport()
  })
}

test('future long routes inherit a keyboard-accessible scroll container',async({page,sandboxURL})=>{
  await mock(page);await page.goto(sandboxURL+'#future')
  const main=page.getByRole('main',{name:'后台内容'})
  await main.focus();await page.keyboard.press('Control+End')
  await expect(page.getByRole('button',{name:'页面最后一个操作'})).toBeInViewport()
  expect(await page.evaluate(()=>window.scrollY)).toBe(0)
  await page.setViewportSize({width:390,height:660})
  await page.getByRole('button',{name:'页面最后一个操作'}).scrollIntoViewIfNeeded()
  await expect(page.getByRole('button',{name:'页面最后一个操作'})).toBeInViewport()
  expect(await page.evaluate(()=>window.scrollY)).toBeGreaterThan(0)
})

for(const route of ['talks']){
  test(`${route} content can reach its bottom without a viewport-height child trap`,async({page,sandboxURL})=>{
    await mock(page);await page.goto(sandboxURL+'#'+route)
    const main=page.getByRole('main',{name:'后台内容'})
    await expect.poll(()=>main.evaluate(el=>el.scrollHeight-el.clientHeight)).toBeGreaterThan(200)
    await main.focus();await page.keyboard.press('Control+End')
    await expect.poll(()=>main.evaluate(el=>Math.abs(el.scrollHeight-el.clientHeight-el.scrollTop))).toBeLessThan(3)
  })
}

test('direct refresh keeps every collapsed sidebar icon centered and mobile labels visible',async({page,sandboxURL})=>{
  await page.setViewportSize({width:1280,height:900});await mock(page);await page.goto(sandboxURL)
  await page.reload()
  const nav=page.locator('.shell-nav')
  await expect(nav).toHaveClass(/close/)
  const centers=()=>nav.locator('.menu-links .nav-links .icon').evaluateAll(elements=>elements.map(el=>{
    const box=el.getBoundingClientRect(),nav=el.closest('nav')!.getBoundingClientRect()
    return Math.abs(box.x+box.width/2-nav.x-nav.width/2)
  }))
  await expect.poll(async()=>Math.max(...await centers())).toBeLessThan(2)
  const undo=await page.addStyleTag({content:'.shell .menu-links{padding-inline-start:40px !important}'})
  expect(Math.max(...await centers())).toBeGreaterThan(20)
  await undo.evaluate(el=>{el.parentNode?.removeChild(el)})
  await page.setViewportSize({width:390,height:660})
  await page.getByRole('button',{name:'打开导航'}).click()
  await expect(nav.getByText('图库',{exact:true})).toBeVisible()
})

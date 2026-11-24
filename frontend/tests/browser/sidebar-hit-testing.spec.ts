import {test, expect} from './sandbox'
test.use({entry:'dashboard-users'})
test('collapsed sidebar names cannot intercept account tab clicks',async({page,sandboxURL})=>{
  await page.addInitScript(()=>localStorage.setItem('tokenKey',`h.${btoa(JSON.stringify({sub:7,role:'admin',exp:Date.now()/1000+600}))}.s`))
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname
    if(path==='/api/protected/admin/support/cases'){
      return route.fulfill({json:{code:200,data:{items:[{
        id:65,ownerId:17,kind:'ticket',assignee:'staff',status:'waiting_staff',version:2,
        subject:'需要人工核实',updatedAt:'2026-11-23T09:00:00Z',
      }],nextBefore:null}}})
    }
    const data=path.endsWith('/profile')?{id:7,username:'long-sidebar-name',nickname:'A very long sidebar display name',role:'admin'}:path.endsWith('/user')?{blogTitle:'Saudade',blogAuthor:'Author'}:path.endsWith('/social')?{}:[]
    return route.fulfill({json:path.endsWith('/temp-users')?[]:{code:200,data}})
  })
  await page.route('**/live2d-widgets/**',route=>route.fulfill({contentType:'application/javascript',body:''}))
  await page.route('**/default-avatar.png',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')}))
  await page.goto(sandboxURL)
  const tab=page.getByRole('tab',{name:'账号管理',exact:true})
  await expect(tab).toBeVisible()
  await expect(page.locator('.shell-nav')).toHaveClass(/close/)
  await expect.poll(()=>tab.evaluate(el=>{const r=el.getBoundingClientRect();return [0.1,0.5,0.9].every(x=>[0.1,0.5,0.9].every(y=>el.contains(document.elementFromPoint(r.x+r.width*x,r.y+r.height*y))))})).toBe(true)
  await page.getByRole('tab',{name:'额度管理',exact:true}).click()
  const box=await tab.boundingBox()
  await page.mouse.click(box!.x+box!.width/2,box!.y+box!.height-2)
  await expect(tab).toHaveAttribute('aria-selected','true')
  await expect(page.locator('.shell-nav').getByText('客服工作台',{exact:true})).toHaveCount(0)
  await page.getByRole('tab',{name:'工单处理',exact:true}).click()
  await expect(page.getByRole('button',{name:/需要人工核实/})).toBeVisible()
})

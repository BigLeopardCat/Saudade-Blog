import {expect, test} from './sandbox'

test.use({entry: 'support'})

test('guest help and authenticated consultation survive a lost create response', async ({page, sandboxURL}) => {
  await page.addInitScript(() => {localStorage.setItem('saudade.locale','zh-CN')})
  const requests: string[] = []
  let promoted = false
  const item = () => ({id:32,ownerId:17,kind:promoted?'ticket':'question',version:promoted?2:1,
    status:'waiting_staff',subject:'无法打开归档',updatedAt:'2026-11-23T08:00:00Z'})
  await page.route('**/api/**', route => {
    const req=route.request(), path=new URL(req.url()).pathname
    const ok=(data:unknown)=>route.fulfill({json:{code:200,data}})
    if(path==='/api/public/support/topics') return ok([{id:'archive',question:'怎样找到以前读过的文章？',answer:'进入归档',href:'/times'}])
    if(!req.headers().authorization) return route.fulfill({status:401})
    if(path==='/api/protected/support/cases' && req.method()==='POST'){
      requests.push(req.postDataJSON().requestId)
      if(requests.length===1) return route.abort('failed')
      return ok(item())
    }
    if(path==='/api/protected/support/cases') return ok({items:[],nextBefore:null})
    if(path.endsWith('/32/events')) {
      expect(req.postDataJSON()).toMatchObject({action:'escalate',version:1})
      promoted=true;return ok(item())
    }
    if(path.endsWith('/32')) return ok({case:item(),guidance:{topic:{id:'find-article',answer:'打开归档找文章',href:'/times'}},events:{items:[{id:1,sender:'customer',action:'open_question',
      body:'我的私有提问',createdAt:'2026-11-23T08:00:00Z'}],nextBefore:null}})
    return route.fulfill({status:404})
  })
  await page.goto(sandboxURL)
  await expect(page.getByRole('link',{name:'请先登录'})).toHaveAttribute('href','/login?returnTo=support')
  await page.getByText('怎样找到以前读过的文章？').click()
  await expect(page.getByText('进入归档',{exact:true})).toBeVisible()
  await page.evaluate(() => {
    localStorage.setItem('tokenKey','h.'+btoa(JSON.stringify({sub:17,role:'user',exp:Date.now()/1000+600}))+'.s')
    window.dispatchEvent(new Event('auth-change'))
  })
  await page.getByRole('button',{name:'新建咨询或工单'}).click()
  await page.getByLabel('主题',{exact:true}).fill('无法打开归档')
  await page.getByLabel('问题描述').fill('我的私有提问')
  await page.getByRole('button',{name:'提交',exact:true}).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await page.getByRole('button',{name:'提交',exact:true}).click()
  await expect(page.getByRole('heading',{name:'#32 无法打开归档'})).toBeVisible()
  await expect(page.getByLabel('首次咨询参考').getByRole('link')).toHaveAttribute('href','/times')
  expect(requests).toHaveLength(2)
  expect(requests[0]).toBeTruthy()
  expect(requests[1]).toBe(requests[0])
  await page.getByRole('button',{name:'转为工单'}).click()
  await expect(page.getByText('工单 · 待客服回复',{exact:true})).toBeVisible()
  await page.evaluate(() => { localStorage.removeItem('tokenKey'); window.dispatchEvent(new Event('auth-change')) })
  await expect(page.getByRole('link',{name:'请先登录'})).toBeVisible()
  await expect(page.getByText('我的私有提问')).toHaveCount(0)
})

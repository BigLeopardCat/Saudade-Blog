import {test,expect} from './sandbox'

test.use({entry:'user-center'})
test('switching accounts discards personal views and late responses from the previous account',async({page,sandboxURL})=>{
  await page.addInitScript(()=>{
    const claims=btoa(JSON.stringify({sub:4,role:'user',exp:Date.now()/1000+600}))
    localStorage.setItem('tokenKey',`fixture.${claims}.fixture`)
  })
  let release!:()=>void
  const old=new Promise<void>(resolve=>{release=resolve})
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname
    const bearer=route.request().headers().authorization??''
    const owner=JSON.parse(Buffer.from(bearer.split('.')[1],'base64url').toString()).sub as number
    if(path.endsWith('/profile')&&owner===4)await old
    const data=path.endsWith('/profile')?{id:owner,username:`owner${owner}`,nickname:`账号${owner}`,role:'user',avatar:''}:
      path.endsWith('/summary')?{notifications:1,messages:0,total:1,pendingReview:0,pendingQuota:0,pendingComments:0}:
      path.endsWith('/notifications')?{unread:1,items:[{id:owner,title:`仅账号${owner}的通知`,type:'notice',
        content:'private',isRead:false,createdAt:'2026-11-08 08:00:00'}]}:[]
    await route.fulfill({json:{code:200,data}})
  })
  await page.route('**/default-avatar.png',route=>route.fulfill({contentType:'image/png',
    body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')}))
  await page.goto(sandboxURL)
  await page.getByRole('tab',{name:/公告和通知/}).click()
  await expect(page.locator('.ucNoticeRow').filter({hasText:'仅账号4的通知'})).toBeVisible()
  await page.evaluate(()=>{
    const claims=btoa(JSON.stringify({sub:5,role:'user',exp:Date.now()/1000+600}))
    localStorage.setItem('tokenKey',`fixture.${claims}.fixture`)
    window.dispatchEvent(new Event('auth-change'))
  })
  await expect(page.locator('.ucNoticeRow').filter({hasText:'仅账号4的通知'})).toHaveCount(0)
  await expect(page.locator('.ucAvatarName')).toContainText('账号5')
  const returned=page.waitForResponse(response=>{
    if(!new URL(response.url()).pathname.endsWith('/profile'))return false
    const bearer=response.request().headers().authorization??''
    return JSON.parse(Buffer.from(bearer.split('.')[1],'base64url').toString()).sub===4
  })
  // Resolve the old HTTP response after the new account is already displayed.
  release()
  await returned
  await expect(page.locator('.ucAvatarName')).toContainText('账号5')
  await page.getByRole('tab',{name:/公告和通知/}).click()
  await expect(page.locator('.ucNoticeRow').filter({hasText:'仅账号5的通知'})).toBeVisible()
  await expect(page.locator('.ucNoticeRow').filter({hasText:'仅账号4的通知'})).toHaveCount(0)
})

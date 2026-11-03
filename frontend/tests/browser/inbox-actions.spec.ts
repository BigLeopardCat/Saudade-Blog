import { test, expect } from './sandbox'
test.use({entry:'user-center'})
test('reading comes before deletion in notification and mail lists and details', async ({page,sandboxURL}) => {
  await page.addInitScript(() => {
    const claims=btoa(JSON.stringify({sub:4,role:'user',exp:Date.now()/1000+600}))
    localStorage.setItem('tokenKey',`fixture.${claims}.fixture`)
  })
  const sent: string[]=[]
  await page.route('**/api/**',route => {
    const path=new URL(route.request().url()).pathname
    if (route.request().method()==='DELETE') sent.push(path)
    const data=path.endsWith('/summary') ? {notifications:1,messages:1,total:2} :
      path.endsWith('/notifications') ? {unread:1,items:[{id:42,type:'notice',title:'通知标题',content:'通知正文',link:'/guestbook?lid=1',isRead:false,createdAt:'2026-11-04 07:00:00'}]} :
      path.endsWith('/messages') ? {unread:1,inbox:[{id:43,peerName:'发件人',peerAvatar:'',title:'信件标题',content:'信件正文',isRead:false,createdAt:'2026-11-04 07:00:00'}],outbox:[],drafts:[]} :
      path.endsWith('/profile') ? {username:'reader',nickname:'读者',role:'user',avatar:''} : {}
    return route.fulfill({json:{code:200,data}})
  })
  await page.route('**/default-avatar.png', route => route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')}))
  await page.goto(sandboxURL)
  await page.getByRole('tab',{name:/公告和通知/}).click()
  const notice=page.locator('.ucNoticeRow')
  await expect(notice.locator('.ant-list-item-action button')).toHaveText(['去看看','标记已读','删除'])
  await notice.locator('.ant-list-item-meta-title').click()
  await expect(page.locator('.ucNoticeDetailBar').getByRole('button',{name:/删除/})).toHaveCount(0)
  await expect(page.locator('.ucNoticeDetailFoot button')).toHaveText(['去看看','标记为已读','删除'])
  await page.getByRole('tab',{name:/站内信箱/}).click()
  const mail=page.locator('.ucMailRow')
  await expect(mail.locator('.ant-list-item-action button')).toHaveText(['阅读','删除'])
  await mail.getByRole('button',{name:/阅\s*读/}).click()
  await expect(page.locator('.ucMailDetailBody')).toHaveText('信件正文')
  await expect(page.locator('.ucMailDetailBar').getByRole('button',{name:/删除/})).toHaveCount(0)
  await expect(page.locator('.ucMailDetail .ucNoticeDetailFoot').getByRole('button',{name:/删\s*除/})).toBeVisible()
  expect(sent).toEqual([])
})

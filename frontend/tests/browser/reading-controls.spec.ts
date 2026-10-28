import { test, expect } from './sandbox'

test.describe('account tabs', () => {
  test.use({ entry: 'users' })
  test('labels remain clickable across their full text and switch panels', async ({ page, sandboxURL }) => {
    await page.addInitScript(() => {
      const claims = btoa(JSON.stringify({sub: 7, role: 'admin', exp: Date.now()/1000 + 600}))
      localStorage.setItem('tokenKey', `test.${claims}.test`)
    })
    await page.route('**/api/temp-users', route => route.fulfill({ json: [] }))
    await page.route('**/api/protected/quota/requests**', route => route.fulfill({ json: { code: 200, data: [], total: 0 } }))
    await page.goto(sandboxURL)
    const accounts = page.getByRole('tab', { name: '账号管理', exact: true })
    await expect(accounts).toBeVisible()
    await expect(accounts).toHaveCSS('cursor', 'pointer')
    await expect(accounts).toHaveCSS('user-select', 'none')
    const quota = page.getByRole('tab', { name: '额度管理', exact: true })
    await quota.click()
    await expect(quota).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.QuotaManage')).toBeVisible()
    const box = await accounts.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + box!.width - 2, box!.y + box!.height / 2)
    await expect(accounts).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.tu-section')).toBeVisible()
  })
})

test.describe('announcement reading', () => {
  test.use({ entry: 'announcement-popup' })
  test('long text leaves a stable scroll gutter and can be read with the keyboard', async ({ page, sandboxURL }) => {
    await page.route('**/api/public/announcements', route => route.fulfill({json: {code: 200, data: [{
      id: 8, title: '长公告', content: '公告正文需要保留独立的滚动空间。\n'.repeat(80), createdAt: '2026-10-28 15:00:00',
    }]}}))
    await page.goto(sandboxURL)
    const region = page.getByLabel('公告内容', { exact: true })
    await expect(region).toBeVisible()
    const geometry = await region.evaluate(el => ({overflow: el.scrollHeight > el.clientHeight,
      gap: parseFloat(getComputedStyle(el).paddingInlineEnd), gutter: getComputedStyle(el).scrollbarGutter}))
    expect(geometry.overflow).toBe(true)
    expect(geometry.gap).toBeGreaterThanOrEqual(12)
    expect(geometry.gutter).toBe('stable')
    const edgeGap = await region.evaluate(el =>
      el.closest('.ant-modal-content')!.getBoundingClientRect().right - el.getBoundingClientRect().right)
    expect(edgeGap).toBeLessThanOrEqual(16)
    await expect(page.getByRole('button', { name: '我知道了', exact: true })).toBeVisible()
    await region.focus()
    await page.keyboard.press('End')
    await expect.poll(() => region.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
    await page.getByRole('button', { name: '我知道了', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('removing an announcement updates only its personal record and survives refresh', async ({ page, sandboxURL }) => {
    let removed = false
    let deletes = 0
    await page.addInitScript(() => localStorage.setItem('tokenKey', 'fixture-token'))
    await page.route('**/api/protected/notifications/announcement', route => route.fulfill({ json: {
      code: 200, data: removed ? null : { id: 42, type: 'announcement', title: '可移除的公告',
        content: '正文内容', isRead: false, createdAt: '2026-10-29 01:00:00' },
    } }))
    await page.route('**/api/protected/notifications/42', route => {
      expect(route.request().method()).toBe('DELETE')
      removed = true
      deletes += 1
      return route.fulfill({ json: { code: 200, data: { notifications: 0, messages: 0, total: 0 } } })
    })
    await page.goto(sandboxURL)
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: /删\s*除/ }).click()
    expect(deletes).toBe(0)
    const confirm = page.locator('.ant-popconfirm')
    await expect(confirm).toContainText('只移除本人的记录')
    await confirm.getByRole('button', { name: /删\s*除/ }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    expect(deletes).toBe(1)
    await page.reload()
    await expect(page.getByRole('dialog')).toBeHidden()
    expect(deletes).toBe(1)
  })
})

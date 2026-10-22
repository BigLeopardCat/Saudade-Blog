import { test, expect } from './sandbox'

test.use({ entry: 'announcement' })
const listAPI = '**/api/public/announcements'
const writeAPI = '**/api/protected/announcements'

for (const failure of ['business', 'transport'] as const) {
  test(`failed ${failure} save keeps the draft and permits one successful retry`, async ({ page, sandboxURL }) => {
    let requests = 0
    let allowResponse!: () => void
    const gate = new Promise<void>(resolve => { allowResponse = resolve })
    await page.route(listAPI, route => route.fulfill({ json: { code: 200, data: [] } }))
    // Network errors also reach the real reporting module; isolate its telemetry.
    await page.route('**/api/monitor/log', route => route.fulfill({ json: { code: 200 } }))
    await page.route(writeAPI, async route => {
      expect(route.request().method()).toBe('POST')
      expect(route.request().postDataJSON()).toEqual({ title: '待发布公告', content: '失败也要保留的正文' })
      requests += 1
      if (requests === 1) {
        await gate
        if (failure === 'transport') await route.abort('failed')
        else await route.fulfill({ json: { code: 500, message: '写入失败' } })
      } else await route.fulfill({ json: { code: 200, data: { id: 10 } } })
    })
    await page.goto(sandboxURL)
    await page.evaluate(() => {
      document.body.dataset.published = '0'
      window.addEventListener('announcement-published', () => {
        document.body.dataset.published = String(Number(document.body.dataset.published) + 1)
      })
    })
    await page.getByRole('button', { name: '新增公告' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('标题').fill('待发布公告')
    await dialog.getByLabel('内容').fill('失败也要保留的正文')
    const save = dialog.getByRole('button', { name: /保\s*存/ })
    await save.click()
    await expect.poll(() => requests).toBe(1)
    // Deliver repeated click events while the real mutation is still pending.
    await save.dispatchEvent('click')
    await save.dispatchEvent('click')
    expect(requests).toBe(1)
    allowResponse()
    await expect(page.locator('.ant-message-error')).toContainText(failure === 'business' ? '写入失败' : '请求失败')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('标题')).toHaveValue('待发布公告')
    await expect(dialog.getByLabel('内容')).toHaveValue('失败也要保留的正文')
    expect(await page.locator('body').getAttribute('data-published')).toBe('0')
    await save.click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('.ant-message-success')).toContainText('已创建')
    expect(requests).toBe(2)
    expect(await page.locator('body').getAttribute('data-published')).toBe('1')
  })
}

test('remount and visible focus refresh real rows, deduplicate events, and clean up on unmount', async ({ page, sandboxURL }) => {
  let reads = 0
  let title = '旧公告'
  await page.route(listAPI, route => {
    reads += 1
    return route.fulfill({ json: { code: 200, data: [{ id: 1, title, content: '正文', createdAt: '2026-10-23T12:00:00+08:00' }] } })
  })
  await page.clock.install({ time: new Date('2026-10-23T04:00:00Z') })
  await page.goto(sandboxURL)
  await expect(page.getByRole('cell', { name: '旧公告', exact: true })).toBeVisible()
  expect(reads).toBe(1)
  await page.getByRole('button', { name: '删除选中' }).click()
  await expect(page.locator('.ant-message-warning')).toContainText('请选择')
  expect(reads).toBe(1)
  title = '外部发布后的公告'
  await page.clock.fastForward(501)
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.getByRole('cell', { name: title, exact: true })).toBeVisible()
  expect(reads).toBe(2)
  await page.clock.fastForward(501)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
  })
  expect(reads).toBe(2)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => reads).toBe(3)
  await page.getByRole('button', { name: '切换挂载' }).click()
  await expect(page.locator('.ant-table')).toHaveCount(0)
  await page.clock.fastForward(501)
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(reads).toBe(3)
  title = '重新挂载后的公告'
  await page.getByRole('button', { name: '切换挂载' }).click()
  await expect(page.getByRole('cell', { name: title, exact: true })).toBeVisible()
  expect(reads).toBe(4)
})

test('failed announcement update preserves the existing draft and notifies only after confirmed retry', async ({ page, sandboxURL }) => {
  const existing = { id: 7, title: '已有公告', content: '原有正文', createdAt: '2026-10-23T12:00:00+08:00' }
  let updates = 0
  await page.route(listAPI, route => route.fulfill({ json: { code: 200, data: [existing] } }))
  await page.route('**/api/protected/announcements/7', route => {
    expect(route.request().method()).toBe('PUT')
    expect(route.request().postDataJSON()).toEqual({ title: '修改中的公告', content: '编辑失败也必须保留的正文' })
    updates += 1
    return route.fulfill({ json: updates === 1 ? { code: 500, message: '更新公告失败' } : { code: 200 } })
  })
  await page.goto(sandboxURL)
  await page.evaluate(() => {
    document.body.dataset.published = '0'
    window.addEventListener('announcement-published', () => {
      document.body.dataset.published = String(Number(document.body.dataset.published) + 1)
    })
  })
  await page.getByRole('row', { name: /已有公告/ }).getByText('编辑', { exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('内容')).toHaveValue('原有正文')
  await dialog.getByLabel('标题').fill('修改中的公告')
  await dialog.getByLabel('内容').fill('编辑失败也必须保留的正文')
  await dialog.getByRole('button', { name: /保\s*存/ }).click()
  await expect(page.locator('.ant-message-error')).toContainText('更新公告失败')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('标题')).toHaveValue('修改中的公告')
  await expect(dialog.getByLabel('内容')).toHaveValue('编辑失败也必须保留的正文')
  expect(updates).toBe(1)
  expect(await page.locator('body').getAttribute('data-published')).toBe('0')
  await expect(page.locator('.ant-message-success')).toHaveCount(0)
  await dialog.getByRole('button', { name: /保\s*存/ }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('.ant-message-success')).toContainText('已更新')
  expect(updates).toBe(2)
  expect(await page.locator('body').getAttribute('data-published')).toBe('1')
})

test('failed announcement delete keeps its selected row and never emits a publish notification', async ({ page, sandboxURL }) => {
  let reads = 0
  let deletes = 0
  let removed = false
  await page.route(listAPI, route => {
    reads += 1
    return route.fulfill({ json: { code: 200, data: removed ? [] : [{ id: 7, title: '待删除公告', content: '删除失败保留正文', createdAt: '2026-10-23T12:00:00+08:00' }] } })
  })
  await page.route(writeAPI, route => {
    expect(route.request().method()).toBe('DELETE')
    expect(route.request().postDataJSON()).toEqual([7])
    deletes += 1
    removed = deletes > 1
    return route.fulfill({ json: removed ? { code: 200 } : { code: 500, message: '删除公告失败' } })
  })
  await page.goto(sandboxURL)
  await page.evaluate(() => {
    document.body.dataset.published = '0'
    window.addEventListener('announcement-published', () => {
      document.body.dataset.published = String(Number(document.body.dataset.published) + 1)
    })
  })
  const row = page.getByRole('row', { name: /待删除公告/ })
  await row.getByRole('checkbox').check()
  await page.getByRole('button', { name: '删除选中' }).click()
  await expect(page.locator('.ant-message-error')).toContainText('删除公告失败')
  await expect(row).toBeVisible()
  await expect(row.getByRole('checkbox')).toBeChecked()
  await expect(page.locator('.ant-message-success')).toHaveCount(0)
  expect(deletes).toBe(1)
  expect(reads).toBe(1)
  expect(await page.locator('body').getAttribute('data-published')).toBe('0')
  await page.getByRole('button', { name: '删除选中' }).click()
  await expect(row).toHaveCount(0)
  await expect(page.locator('.ant-message-success')).toContainText('已删除')
  expect(deletes).toBe(2)
  expect(await page.locator('body').getAttribute('data-published')).toBe('0')
})

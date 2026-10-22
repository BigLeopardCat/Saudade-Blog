import { mkdir } from 'node:fs/promises'
import { test, expect } from './sandbox'

test.use({ entry: 'tags' })
for (const width of [1280, 390]) {
  test(`tag editing targets the correct level and failed create retains input at ${width}px`, async ({ page, sandboxURL }) => {
    await page.setViewportSize({ width, height: 900 })
    const writes: { method: string; path: string; body: Record<string, unknown> }[] = []
    let childCreates = 0
    await page.route('**/api/public/tagone', route => route.fulfill({ json: { code: 200, data: [{ tagKey: 1, title: '技术札记', level: 1, color: '#765ca0' }] } }))
    await page.route('**/api/public/tagtwo', route => route.fulfill({ json: { code: 200, data: [{ tagKey: 1, title: '重号子标签', level: 2, color: '#4b8f81', fatherKey: 1, fatherTag: '技术札记' }] } }))
    await page.route('**/api/protected/**', async route => {
      const path = new URL(route.request().url()).pathname
      writes.push({ method: route.request().method(), path, body: route.request().postDataJSON() })
      if (path === '/api/protected/tagtwo') {
        childCreates += 1
        await route.fulfill({ json: childCreates === 1 ? { code: 500, message: '标签写入失败' } : { code: 200 } })
      } else await route.fulfill({ json: { code: 200 } })
    })
    await page.goto(sandboxURL)
    await expect(page.getByText('重号子标签', { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    if (process.env.ADMIN_PREVIEW_DIR) {
      await mkdir(process.env.ADMIN_PREVIEW_DIR, { recursive: true })
      await page.screenshot({ path: `${process.env.ADMIN_PREVIEW_DIR}/tags-${width}.png`, fullPage: true })
    }
    await page.getByText('重号子标签', { exact: true }).click()
    await expect(page.getByRole('heading', { name: '编辑子标签「重号子标签」' })).toBeVisible()
    await page.getByLabel('标签名称').fill('修改子标签')
    await page.getByRole('button', { name: '保存修改' }).click()
    await expect.poll(() => writes.length).toBe(1)
    expect(writes[0]).toMatchObject({ method: 'PUT', path: '/api/protected/tagtwo/1', body: { title: '修改子标签' } })
    await page.getByRole('button', { name: '结束编辑' }).click()
    await page.getByText('技术札记', { exact: true }).click()
    await page.getByRole('button', { name: '在此主标签下新建子标签' }).click()
    await page.getByLabel('标签名称').fill('要保留的草稿标签')
    await page.getByRole('button', { name: '创建标签' }).click()
    await expect(page.getByText('标签写入失败', { exact: true })).toBeVisible()
    await expect(page.getByLabel('标签名称')).toHaveValue('要保留的草稿标签')
    await page.getByRole('button', { name: '创建标签' }).click()
    await expect(page.getByLabel('标签名称')).toHaveValue('')
    expect(writes.slice(1)).toHaveLength(2)
    for (const write of writes.slice(1)) expect(write).toMatchObject({ method: 'POST', path: '/api/protected/tagtwo', body: { title: '要保留的草稿标签', fatherTag: 1 } })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  })
}

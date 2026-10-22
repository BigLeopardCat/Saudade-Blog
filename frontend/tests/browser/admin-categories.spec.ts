import { mkdir } from 'node:fs/promises'
import { test, expect } from './sandbox'

test.use({ entry: 'categories' })
for (const width of [1280, 390]) {
  test(`category create failure retains fields and editing targets its ID at ${width}px`, async ({ page, sandboxURL }) => {
    await page.setViewportSize({ width, height: 900 })
    let creates = 0
    const writes: { path: string; body: Record<string, unknown> }[] = []
    await page.route('**/api/public/category', route => route.fulfill({ json: { code: 200, data: [{ categoryKey: 11, categoryTitle: '技术札记', pathName: 'tech-notes', introduce: '记录代码与工程实践', color: '#765ca0', icon: 'fa-code', noteCount: 28 }] } }))
    await page.route('**/api/protected/category**', async route => {
      const path = new URL(route.request().url()).pathname
      writes.push({ path, body: route.request().postDataJSON() })
      if (path === '/api/protected/category') {
        creates += 1
        await route.fulfill({ json: creates === 1 ? { code: 500, message: '分类写入失败' } : { code: 200 } })
      } else await route.fulfill({ json: { code: 200 } })
    })
    await page.goto(sandboxURL)
    await expect(page.getByRole('button', { name: '编辑分类 技术札记' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    if (process.env.ADMIN_PREVIEW_DIR) {
      await mkdir(process.env.ADMIN_PREVIEW_DIR, { recursive: true })
      await page.screenshot({ path: `${process.env.ADMIN_PREVIEW_DIR}/categories-${width}.png`, fullPage: true })
    }
    await page.getByRole('button', { name: '新建分类' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('分类名称', { exact: true }).fill('旅行见闻')
    await expect(dialog.getByLabel('访问路径', { exact: true })).toHaveValue('旅行见闻')
    await dialog.getByRole('textbox', { name: /分类介绍/ }).fill('把沿途见闻留在这里')
    await dialog.getByRole('button', { name: '创建分类' }).click()
    await expect(page.getByText('分类写入失败', { exact: true })).toBeVisible()
    await expect(dialog.getByLabel('分类名称', { exact: true })).toHaveValue('旅行见闻')
    await expect(dialog.getByRole('textbox', { name: /分类介绍/ })).toHaveValue('把沿途见闻留在这里')
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    if (process.env.ADMIN_PREVIEW_DIR) await page.screenshot({ path: `${process.env.ADMIN_PREVIEW_DIR}/category-form-${width}.png`, fullPage: true })
    await dialog.getByRole('button', { name: '创建分类' }).click()
    await expect(dialog).toBeHidden()
    await page.getByRole('button', { name: '编辑分类 技术札记' }).click()
    await expect(dialog.getByLabel('访问路径', { exact: true })).toHaveValue('tech-notes')
    await dialog.getByLabel('分类名称', { exact: true }).fill('工程札记')
    await expect(dialog.getByLabel('访问路径', { exact: true })).toHaveValue('tech-notes')
    await dialog.getByRole('button', { name: '保存修改' }).click()
    await expect(dialog).toBeHidden()
    expect(writes).toHaveLength(3)
    expect(writes[2]).toMatchObject({ path: '/api/protected/category/11', body: { categoryTitle: '工程札记', pathName: 'tech-notes' } })
  })
}

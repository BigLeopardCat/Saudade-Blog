import type {Page} from '@playwright/test'
import {test, expect} from './sandbox'

test.use({entry: 'public-header'})

async function stubPublic(page: Page) {
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url())
    const data = url.pathname === '/api/public/search' ? {
      notes: [{type: 'note', key: 1, title: '首页', snippet: '中文正文保持原样', author: '作者', createTime: '2026-11-21'}],
      talks: [], board: [], comments: [], total: 1, counts: {note: 1, talk: 0, board: 0, comment: 0},
      hasMore: false, terms: [],
    } : url.pathname.endsWith('/user') ? {blogTitle: 'Saudade', blogAuthor: '站点作者'} : []
    return route.fulfill({json: {code: 200, data}})
  })
  await page.route('**/default-avatar.png', route => route.fulfill({status: 204, body: ''}))
}

for (const width of [1440, 390]) {
  test(`switches the public navigation and open search without losing input at ${width}px`, async ({page, sandboxURL}) => {
    await page.setViewportSize({width, height: 900})
    await stubPublic(page)
    await page.goto(sandboxURL)
    await page.getByRole('button', {name: 'Switch to English'}).click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await page.getByRole('button', {name: 'Search', exact: true}).click()
    const dialog = page.getByRole('dialog')
    const input = dialog.locator('input[role="combobox"]')
    await expect(input).toHaveAttribute('aria-label', 'Search this site')
    await input.fill('保留查询')
    await expect(dialog.getByText('中文正文保持原样')).toBeVisible()
    await dialog.getByRole('button', {name: '切换为中文'}).click()
    await expect(input).toHaveValue('保留查询')
    await expect(input).toHaveAttribute('aria-label', '搜索站内内容')
    await expect(dialog.getByText('中文正文保持原样')).toBeVisible()
    await dialog.getByRole('button', {name: 'Switch to English'}).click()
    await expect(input).toHaveValue('保留查询')
    await expect(dialog.getByText('首页', {exact: true})).toBeVisible()
    await page.keyboard.press('Escape')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
    await page.reload()
    await expect(page.getByRole('button', {name: 'Search', exact: true})).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await page.screenshot({path: test.info().outputPath(`public-english-${width}.png`)})
  })
}

test('language changes in another tab update the mounted public header', async ({page, context, sandboxURL}) => {
  await stubPublic(page)
  await page.goto(sandboxURL)
  const tab = await context.newPage()
  try {
    await stubPublic(tab)
    await tab.goto(sandboxURL)
    await tab.getByRole('button', {name: 'Switch to English'}).click()
    await expect(page.getByRole('button', {name: 'Search', exact: true})).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await page.getByRole('button', {name: '切换为中文'}).click()
    await expect(tab.getByRole('button', {name: '搜索', exact: true})).toBeVisible()
  } finally {await tab.close()}
})

import { test, expect } from './sandbox'

test.use({ entry: 'public-header' })
for (const width of [1440, 390]) {
  test(`public header owns its drawer on cold refresh and after lazy dashboard CSS at ${width}px`, async ({ page, sandboxURL }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname
      const data = pathname.endsWith('/user') ? { blogTitle: 'Saudade', blogAuthor: '站点作者' }
        : pathname.endsWith('/social') ? {} : []
      return route.fulfill({ json: { code: 200, data } })
    })
    await page.route('**/default-avatar.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') }))
    await page.goto(sandboxURL)
    const drawer = page.locator('#public-navigation-drawer')
    const assertClosed = async () => {
      await expect(page.locator('.firstTitle')).toHaveText('Saudade')
      await expect(drawer).toBeHidden()
      expect(await page.locator('header').evaluate(element => element.getBoundingClientRect().height)).toBe(0)
      expect(await page.getByRole('main').evaluate(element => element.getBoundingClientRect().top)).toBe(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
      if (width > 1200) await expect(drawer).toHaveCSS('display', 'none')
      else expect(await drawer.evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0)
    }
    await assertClosed()
    const headerColor = await page.locator('.webTitle').evaluate(element => getComputedStyle(element).color)
    await page.addStyleTag({ url: new URL('/dashboard-overview.css', sandboxURL).href })
    await assertClosed()
    expect(await page.locator('.webTitle').evaluate(element => getComputedStyle(element).color)).toBe(headerColor)
    if (width < 1200) {
      await page.getByRole('button', { name: '打开导航菜单' }).click()
      await expect(drawer).toBeVisible()
      await expect.poll(() => drawer.evaluate(element => Math.round(element.getBoundingClientRect().left))).toBe(0)
      await expect(page.locator('.phoneSideOverlay')).toBeVisible()
      await expect(page.locator('body')).toHaveCSS('overflow', 'hidden')
      await page.getByRole('button', { name: '关闭导航菜单' }).click()
      await expect(drawer).toBeHidden()
      await expect(page.locator('.phoneSideOverlay')).toHaveCount(0)
      await page.getByRole('button', { name: '打开导航菜单' }).click()
      await expect(drawer).toBeVisible()
      await page.setViewportSize({ width: 1440, height: 900 })
      await expect(page.locator('.phoneSideOverlay')).toHaveCount(0)
      await expect(drawer).toBeHidden()
      await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden')
      await page.setViewportSize({ width, height: 900 })
    }
    await page.reload()
    await assertClosed()
  })
}

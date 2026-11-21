import {test, expect} from '@playwright/test'

for (const scenario of [
  {path: '/login', english: 'Password', chinese: '密码', role: 'label'},
  {path: '/missing-locale-page', english: 'Oh… this page is missing', chinese: '呜…页面不见了', role: 'heading'},
  {path: '/guestbook', english: 'Light a lantern', chinese: '点一盏河灯', role: 'button'},
]) {
  test(`standalone ${scenario.path} offers English and Chinese controls`, async ({page}) => {
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
      ? route.continue() : route.abort())
    await page.route('**/api/**', route => route.fulfill({json: {code: 200, data: []}}))
    // This case checks the public page; the real widget is exercised by its own browser matrix.
    await page.route('**/live2d-widgets/boot.js**', route => route.fulfill({contentType: 'text/javascript', body: ''}))
    await page.addInitScript(() => localStorage.setItem('saudade.locale', 'en'))
    await page.setViewportSize({width: 390, height: 844})
    await page.goto('http://127.0.0.1:5174' + scenario.path)
    const control = (name: string) => scenario.role === 'label'
      ? page.getByLabel(name, {exact: true})
      : scenario.role === 'heading' ? page.getByRole('heading', {name, exact: true})
      : page.getByRole('button', {name, exact: true})
    await expect(control(scenario.english)).toBeVisible()
    await page.getByRole('button', {name: '切换为中文'}).click()
    await expect(control(scenario.chinese)).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await page.getByRole('button', {name: 'Switch to English'}).click()
    await expect(control(scenario.english)).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391)
    await page.screenshot({path: test.info().outputPath('pinned-standalone-english.png')})
  })
}

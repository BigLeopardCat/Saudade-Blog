import {test, expect, type Locator} from '@playwright/test'

async function expectReadable(button: Locator) {
  const contrast = await button.evaluate(element => {
    const style = getComputedStyle(element)
    const rgb = (color: string) => color.match(/[\d.]+/g)!.map(Number)
    const foreground = rgb(style.color), background = rgb(style.backgroundColor)
    const alpha = background[3] ?? 1
    // White underneath translucent dark paper gives a conservative contrast estimate.
    const composite = background.slice(0, 3).map(value => value * alpha + 255 * (1 - alpha))
    const luminance = (channels: number[]) => channels.slice(0, 3).reduce((sum, value, i) => {
      const channel = value / 255
      return sum + (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]
    }, 0)
    const a = luminance(foreground), b = luminance(composite)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  })
  expect(contrast, 'Language text must remain readable against its button').toBeGreaterThanOrEqual(4.5)
}

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
    await expectReadable(page.getByTestId('language-switch'))
    await page.screenshot({path: test.info().outputPath('pinned-standalone-english.png')})
    if (scenario.path !== '/guestbook') {
      await page.evaluate(() => {
        localStorage.setItem('isDarkMode', 'true')
        window.dispatchEvent(new CustomEvent('darkmode-change', {detail: true}))
      })
      await expect(page.locator('.frontDark').first()).toBeAttached()
      await expectReadable(page.getByTestId('language-switch'))
      await page.screenshot({path: test.info().outputPath('pinned-standalone-english-dark.png')})
    }
  })
}

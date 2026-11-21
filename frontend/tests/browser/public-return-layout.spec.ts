import {readFileSync} from 'node:fs'
import {test, expect} from './sandbox'

test.use({entry: 'home-hero'})
const dashboardCSS = readFileSync(new URL('../../src/pages/Dashboard/index.css', import.meta.url), 'utf8')
const title = '返回首页后的公告'
const content = '第一段公告内容，不应贴边或被裁切。\n\n'.repeat(40) + '最后一段公告内容。'

for (const width of [390, 1440]) {
  test(`pinned announcement retains readable layout after dashboard styles at ${width}px`, async ({page, sandboxURL}) => {
    await page.setViewportSize({width, height: 900})
    await page.emulateMedia({reducedMotion: 'reduce'})
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname
      const data = path === '/api/public/pinned-announcements'
        ? [{id: 7, title, content, createdAt: '2026-11-04 06:04:00'}]
        : path === '/api/public/notes/feed' ? {items: [], nextCursor: null} : []
      return route.fulfill({json: {code: 200, data}})
    })
    await page.goto(sandboxURL)
    for (const returned of [false, true]) {
      if (returned) {
        await page.addStyleTag({content: dashboardCSS})
        await page.evaluate(() => {
          document.body.classList.add('dash-skin')
          document.body.classList.remove('dash-skin', 'washiDark')
        })
      }
      await page.locator('.AnnouncementCard h3 button').first().click()
      const dialog = page.getByRole('dialog')
      const inset = await dialog.evaluate(element => {
        const surface = element.querySelector('.ant-modal-content')!.getBoundingClientRect()
        const heading = element.querySelector('.ant-modal-title')!.getBoundingClientRect()
        const time = element.querySelector('time')!.getBoundingClientRect()
        return {headingTop: heading.top - surface.top, headingLeft: heading.left - surface.left,
          textLeft: time.left - surface.left}
      })
      expect(inset.headingTop).toBeGreaterThanOrEqual(20)
      expect(inset.headingLeft).toBeGreaterThanOrEqual(24)
      expect(inset.textLeft).toBeGreaterThanOrEqual(24)
      const body = dialog.getByRole('region', {name: '公告内容'})
      await expect(body).toBeVisible()
      expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
      const bounds = (await dialog.boundingBox())!
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(900)
      await body.focus()
      await body.evaluate(element => element.scrollTop = element.scrollHeight)
      await expect(body.getByText(/最后一段公告内容/)).toBeVisible()
      // The floating agent layer must not cover a modal's content or controls.
      await page.evaluate(() => {
        const probe = document.createElement('div'); probe.id = 'agent-layer-probe'
        probe.style.cssText = 'position:fixed;inset:0;z-index:1001;pointer-events:auto'
        document.body.appendChild(probe)
      })
      const onTop = await dialog.evaluate(element => {
        const box = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + 50))
      })
      expect(onTop).toBe(true)
      await page.locator('#agent-layer-probe').evaluate(element => element.remove())
      if (returned) await page.screenshot({path: test.info().outputPath(`pinned-announcement-return-${width}.png`), animations: 'disabled'})
      await dialog.getByRole('button', {name: 'Close', exact: true}).click()
      await expect(dialog).not.toBeVisible()
    }
  })
}

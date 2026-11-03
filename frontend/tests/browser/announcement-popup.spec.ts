import type { Page } from '@playwright/test'
import { test, expect } from './sandbox'

test.use({ entry: 'announcement-popup' })
const publicAPI = '/api/public/announcements'
const pendingAPI = '/api/protected/notifications/announcement'
const readAPI = '/api/protected/notifications/read'
const seenKey = 'announcement_seen_id'
const row = (id: number, isRead = false) => ({
  id, type: 'announcement', title: `公告 ${id}`, content: `正文 ${id}`,
  isRead, createdAt: '2026-10-23 12:34:56', updatedAt: '2026-10-23 12:35:00',
})

async function backend(page: Page, url: string, initial: unknown) {
  const state = { data: initial, code: 200, status: 200, reads: 0, writes: [] as unknown[] }
  await page.route(`**${url}`, route => {
    expect(route.request().method()).toBe('GET')
    state.reads += 1
    return route.fulfill({ status: state.status, json: { code: state.code, data: state.data } })
  })
  await page.route(`**${readAPI}`, route => {
    expect(route.request().method()).toBe('POST')
    state.writes.push(route.request().postDataJSON())
    return route.fulfill({ json: { code: 200, data: { notifications: 0, messages: 0, total: 0 } } })
  })
  await page.route('**/api/monitor/log', route => route.fulfill({ json: { code: 200 } }))
  return state
}

async function notify(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('announcement-published')))
}

async function signedIn(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('tokenKey', 'h.browser-test.s')
    localStorage.setItem('announcement_seen_id', '5')
  })
}

test('guest dismissal is not acknowledgment; only acknowledgment survives a reload', async ({ page, sandboxURL }) => {
  const server = await backend(page, publicAPI, [row(7)])
  await page.goto(sandboxURL)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('公告 7')
  await expect(dialog).toContainText('正文 7')
  await expect(dialog).toContainText('2026-10-23 12:35')
  await page.locator('.ant-modal-wrap').click({ position: { x: 3, y: 3 } })
  await expect(dialog).toBeHidden()
  expect(await page.evaluate(key => localStorage.getItem(key), seenKey)).toBeNull()
  const before = server.reads
  await notify(page)
  await expect.poll(() => server.reads).toBe(before + 1)
  await expect(dialog).toBeHidden()
  await page.reload()
  await expect(dialog).toContainText('公告 7')
  await dialog.locator('.ant-modal-close').click()
  await expect(dialog).toBeHidden()
  expect(await page.evaluate(key => localStorage.getItem(key), seenKey)).toBeNull()
  await page.reload()
  await expect(dialog).toContainText('公告 7')
  await dialog.getByRole('button', { name: '我知道了' }).click()
  await expect(dialog).toBeHidden()
  expect(await page.evaluate(key => localStorage.getItem(key), seenKey)).toBe('7')
  await page.reload()
  await expect.poll(() => server.reads).toBe(5)
  await expect(dialog).toBeHidden()
  expect(server.writes).toEqual([])
})

test('signed-in acknowledgment updates exactly the shown notification and leaves the guest watermark alone', async ({ page, sandboxURL }) => {
  await signedIn(page)
  const server = await backend(page, pendingAPI, row(9))
  await page.goto(sandboxURL)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('公告 9')
  await expect(dialog).toContainText('2026-10-23 12:34')
  await dialog.locator('.ant-modal-close').click()
  await expect(dialog).toBeHidden()
  expect(server.writes).toEqual([])
  await page.reload()
  await expect(dialog).toContainText('公告 9')
  await dialog.getByRole('button', { name: '我知道了' }).click()
  await expect.poll(() => server.writes).toEqual([{ ids: [9], all: false }])
  expect(await page.evaluate(key => localStorage.getItem(key), seenKey)).toBe('5')
  server.data = row(9, true)
  await page.reload()
  await expect.poll(() => server.reads).toBeGreaterThanOrEqual(3)
  await expect(dialog).toBeHidden()
})

for (const account of ['guest', 'signed-in'] as const) {
  test(`${account} receives a publication without remounting and suppresses an already dismissed popup`, async ({ page, sandboxURL }) => {
    if (account === 'signed-in') await signedIn(page)
    else await page.addInitScript(() => localStorage.setItem('announcement_seen_id', '7'))
    const server = await backend(page, account === 'guest' ? publicAPI : pendingAPI,
      account === 'guest' ? [row(7)] : row(7, true))
    await page.goto(sandboxURL)
    const dialog = page.getByRole('dialog')
    await expect.poll(() => server.reads).toBe(1)
    await expect(dialog).toBeHidden()
    server.data = account === 'guest' ? [row(8), row(7)] : row(8)
    await notify(page)
    await expect(dialog).toContainText('公告 8')
    await expect(dialog).not.toContainText('正文 7')
    await dialog.locator('.ant-modal-close').click()
    await expect(dialog).toBeHidden()
    await notify(page)
    await expect.poll(() => server.reads).toBe(3)
    await expect(dialog).toBeHidden()
    server.data = account === 'guest' ? [row(10), row(8)] : row(10)
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect(dialog).toContainText('公告 10')
    await dialog.getByRole('button', { name: '我知道了' }).click()
    await expect(dialog).toBeHidden()
    if (account === 'guest') {
      expect(await page.evaluate(key => localStorage.getItem(key), seenKey)).toBe('10')
      expect(server.writes).toEqual([])
    } else await expect.poll(() => server.writes).toEqual([{ ids: [10], all: false }])
  })
}

test('hidden pages do not poll, visible pages do, and unmount removes timers and event subscriptions', async ({ page, sandboxURL }) => {
  await page.clock.install()
  const server = await backend(page, publicAPI, [])
  await page.goto(sandboxURL)
  await expect.poll(() => server.reads).toBe(1)
  await page.clock.runFor(1000)
  expect(server.reads).toBe(1)
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }))
  await page.clock.fastForward(60_000)
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(server.reads).toBe(1)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => server.reads).toBe(2)
  await page.clock.fastForward(60_000)
  await expect.poll(() => server.reads).toBe(3)
  await page.getByRole('button', { name: '切换挂载' }).click()
  await page.clock.fastForward(60_000)
  await notify(page)
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(server.reads).toBe(3)
  server.data = [row(11)]
  await page.getByRole('button', { name: '切换挂载' }).click()
  await expect(page.getByRole('dialog')).toContainText('公告 11')
  expect(server.reads).toBe(4)
})

for (const failure of ['business', 'http'] as const) {
  test(`${failure} failure cannot display stale response content; a later successful event can recover`, async ({ page, sandboxURL }) => {
    await signedIn(page)
    const server = await backend(page, pendingAPI, row(55))
    if (failure === 'business') server.code = 500
    else server.status = 503
    await page.goto(sandboxURL)
    await expect.poll(() => server.reads).toBe(1)
    await expect(page.getByRole('dialog')).toBeHidden()
    server.code = 200
    server.status = 200
    await notify(page)
    await expect(page.getByRole('dialog')).toContainText('公告 55')
    expect(server.writes).toEqual([])
  })
}

test('popup geometry, scroll spacing and theme remain readable without covering its title or action', async ({ page, sandboxURL }) => {
  await backend(page, publicAPI, [{ ...row(7), content: '长公告内容。'.repeat(800) }])
  await page.goto(sandboxURL)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const measure = () => dialog.evaluate(el => {
    const card = el.querySelector('.ant-modal-content')!
    const title = el.querySelector('.ant-modal-title')!
    const scroll = el.querySelector('.washiScroll')!
    const button = el.querySelector('.washiOk')!
    const cr = card.getBoundingClientRect(), tr = title.getBoundingClientRect()
    const sr = scroll.getBoundingClientRect(), br = button.getBoundingClientRect()
    const cs = getComputedStyle(card), ts = getComputedStyle(title.firstElementChild!), bs = getComputedStyle(button)
    const lum = (color: string) => {
      const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number)
      return (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) / 255
    }
    return { top: tr.top - cr.top, symmetric: Math.abs((tr.left - cr.left) - (cr.right - tr.right)),
      titleAbove: tr.bottom <= sr.top, scrollAbove: sr.bottom <= br.top, scrollable: scroll.scrollHeight > scroll.clientHeight,
      gutter: parseFloat(getComputedStyle(scroll).paddingRight), titleHeight: tr.height,
      buttonHeight: br.height, buttonWidth: br.width, radius: parseFloat(bs.borderRadius), gradient: bs.backgroundImage,
      cardLuminance: lum(cs.backgroundColor), titleLuminance: lum(ts.color) }
  })
  // Assert a single geometry snapshot; rc-motion can start after the first visible frame.
  let light: Awaited<ReturnType<typeof measure>> | undefined
  await expect(async () => {
    const actual = await measure()
    expect(actual.top).toBeGreaterThanOrEqual(24)
    expect(actual.top).toBeLessThanOrEqual(32)
    expect(actual.symmetric).toBeLessThanOrEqual(2)
    expect(actual.titleHeight).toBeGreaterThanOrEqual(27)
    expect(actual.titleHeight).toBeLessThanOrEqual(34)
    expect(actual.titleAbove && actual.scrollAbove && actual.scrollable).toBe(true)
    expect(actual.gutter).toBeGreaterThanOrEqual(20)
    expect(actual.buttonHeight).toBeGreaterThanOrEqual(40)
    expect(actual.buttonWidth).toBeGreaterThanOrEqual(140)
    expect(actual.radius).toBeGreaterThanOrEqual(20)
    expect(actual.gradient).toContain('linear-gradient')
    light = actual
  }).toPass({ timeout: 7000 })
  await page.evaluate(() => {
    localStorage.setItem('isDarkMode', JSON.stringify('true'))
    window.dispatchEvent(new CustomEvent('darkmode-change', { detail: true }))
  })
  await expect(page.locator('.washiModal')).toHaveClass(/washiDark/)
  const dark = await measure()
  expect(dark.cardLuminance).toBeLessThan(0.35)
  expect(dark.titleLuminance).toBeGreaterThan(0.5)
  expect(dark.gradient).not.toBe(light!.gradient)
})

import { test, expect } from './sandbox'

test.use({ entry: 'axios' })

for (const [label, token, expected] of [
  ['bare token', 'session-token', 'Bearer session-token'],
  ['Bearer token', 'Bearer session-token', 'Bearer session-token'],
  ['guest', null, undefined],
] as const) {
  test(`200 preserves the response and normalizes authorization: ${label}`, async ({ page, sandboxURL }) => {
    if (token) await page.addInitScript(value => localStorage.setItem('tokenKey', value), token)
    let authorization: string | undefined
    await page.route('**/api/check', async route => {
      authorization = route.request().headers().authorization
      await route.fulfill({ json: { code: 200 }, status: 200 })
    })
    await page.goto(sandboxURL)
    await page.getByRole('button', { name: '请求', exact: true }).click()
    await expect(page.getByLabel('请求结果')).toHaveText('success:200')
    expect(authorization).toBe(expected)
    expect(await page.evaluate(() => localStorage.getItem('tokenKey'))).toBe(token)
    await expect(page.locator('.ant-message-notice-content')).toHaveCount(0)
  })
}

test('401 rejects, clears expired credentials, shows feedback, then redirects', async ({ page, sandboxURL }) => {
  await page.clock.install({ time: new Date('2026-10-23T04:00:00Z') })
  await page.addInitScript(() => localStorage.setItem('tokenKey', 'expired-token'))
  await page.route('**/api/check', route => route.fulfill({ status: 401, json: { code: 401 } }))
  await page.goto(sandboxURL)
  await page.clock.pauseAt(new Date('2026-10-23T04:01:00Z'))
  await page.getByRole('button', { name: '请求', exact: true }).click()
  await expect(page.getByLabel('请求结果')).toHaveText('failure:401')
  expect(await page.evaluate(() => localStorage.getItem('tokenKey'))).toBeNull()
  await expect(page.getByText('登录状态已过期，请重新登录')).toBeVisible()
  expect(page.url()).toBe(sandboxURL)
  await page.clock.fastForward(1000)
  await expect(page).toHaveURL(new URL('/login', sandboxURL).href)
})

test('403 rejects without logging out a valid lower-privilege account', async ({ page, sandboxURL }) => {
  await page.route('**/api/monitor/log', route => route.fulfill({ json: { code: 200 } }))
  await page.clock.install({ time: new Date('2026-10-23T04:00:00Z') })
  await page.addInitScript(() => localStorage.setItem('tokenKey', 'valid-token'))
  await page.route('**/api/check', route => route.fulfill({ status: 403, json: { code: 403 } }))
  await page.goto(sandboxURL)
  await page.getByRole('button', { name: '请求', exact: true }).click()
  await expect(page.getByLabel('请求结果')).toHaveText('failure:403')
  await page.clock.fastForward(2000)
  expect(await page.evaluate(() => localStorage.getItem('tokenKey'))).toBe('valid-token')
  expect(page.url()).toBe(sandboxURL)
  await expect(page.locator('.ant-message-notice-content')).toHaveCount(0)
})


test('a late 401 from the previous session preserves a new login', async ({ page, sandboxURL }) => {
  await page.addInitScript(() => localStorage.setItem('tokenKey', 'old-session'))
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/check', async route => {
    await pending
    await route.fulfill({ status: 401, json: { code: 401 } })
  })
  await page.goto(sandboxURL)
  const request = page.waitForRequest('**/api/check')
  await page.getByRole('button', { name: '请求', exact: true }).click()
  await request
  await page.evaluate(() => {
    localStorage.setItem('tokenKey', 'new-session')
    window.dispatchEvent(new Event('auth-change'))
  })
  release()
  await expect(page.getByLabel('请求结果')).toHaveText('failure:401')
  expect(await page.evaluate(() => localStorage.getItem('tokenKey'))).toBe('new-session')
  await expect(page.locator('.ant-message-notice-content')).toHaveCount(0)
  expect(page.url()).toBe(sandboxURL)
})

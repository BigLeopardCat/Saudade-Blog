import type {Page} from '@playwright/test'
import type {R2Usage} from '../../src/interface/Setting'
import {test, expect} from './sandbox'

test.use({entry: 'r2-settings'})
const GiB = 1024 ** 3
const stored = {
  blogTitle: '无关站点标题', manualReviewEnabled: true,
  r2ImageEnabled: true, r2ImageBucket: 'saved-image-bucket', r2ImagePrefix: 'saved-gallery',
  r2ImagePublicBase: 'https://saved-images.example.test', r2ImageQuotaGB: 9.5,
}
const usage: R2Usage = {
  enabled: true, configured: true, credentials: true, credsSource: 'R2_IMAGE_*',
  bucket: 'active-image-bucket', prefix: 'active-gallery', publicBase: 'https://active-images.example.test',
  quotaGB: 9.5, limitBytes: 9.5 * GiB, usedBytes: 4.75 * GiB, listError: null,
}

async function backend(page: Page) {
  const state = {
    settings: {...stored}, usage: {...usage}, settingsReads: 0, usageReads: 0,
    writes: [] as Record<string, unknown>[], saveError: '', saveStatus: 200,
  }
  await page.route('**/api/protected/websetting', route => {
    if (route.request().method() === 'GET') {
      state.settingsReads += 1
      return route.fulfill({json: {code: 200, data: state.settings}})
    }
    expect(route.request().method()).toBe('POST')
    const payload = route.request().postDataJSON() as Record<string, unknown>
    state.writes.push(payload)
    if (state.saveError || state.saveStatus !== 200) return route.fulfill({status: state.saveStatus, json: {code: 500, message: state.saveError}})
    Object.assign(state.settings, payload)
    return route.fulfill({json: {code: 200, data: 'Settings updated'}})
  })
  await page.route('**/api/monitor/log', route => route.fulfill({json: {code: 200}}))
  await page.route('**/api/protect/images/r2', route => {
    expect(route.request().method()).toBe('GET')
    state.usageReads += 1
    return route.fulfill({json: {code: 200, data: state.usage}})
  })
  return state
}

const bucket = (page: Page) => page.getByPlaceholder('图库专用的 R2 桶（别用部署桶）')
const prefix = (page: Page) => page.getByPlaceholder('gallery（对象键的命名空间，两端斜杠会自动去掉）')
const publicBase = (page: Page) => page.getByPlaceholder('https://img.example.com（桶要开公开读）')
const panel = (page: Page) => page.locator('.r2_storage')
const usageFeedback = (page: Page) => panel(page).locator(':scope > div').first()
const save = (page: Page) => panel(page).getByRole('button', {name: /保\s*存/})

async function fillRatio(page: Page) {
  return panel(page).locator('.ant-progress-inner').evaluate(el => {
    const fill = el.querySelector('.ant-progress-bg')!
    return fill.getBoundingClientRect().width / el.getBoundingClientRect().width
  })
}

test('gallery navigation state opens storage settings, restores saved values and shows actual usage', async ({page, sandboxURL}) => {
  const server = await backend(page)
  await page.goto(sandboxURL)
  await expect(page.getByRole('tab')).toHaveText(['站点信息', '社交媒体', '向量图谱', '图库存储'])
  await expect(page.getByRole('tab', {name: '图库存储'})).toHaveAttribute('aria-selected', 'true')
  await expect(panel(page).locator('.ant-input-group-addon')).toHaveText(['桶名', '前缀', '公开域名'])
  // Saved form fields differ from effective usage metadata; the sources cannot be interchanged.
  await expect(bucket(page)).toHaveValue('saved-image-bucket')
  await expect(prefix(page)).toHaveValue('saved-gallery')
  await expect(publicBase(page)).toHaveValue('https://saved-images.example.test')
  await expect(panel(page).getByRole('spinbutton')).toHaveValue('9.5')
  await expect(panel(page).getByRole('switch')).toBeChecked()
  await expect(usageFeedback(page)).toContainText('4.75 GB / 上限 9.50 GB（50%）')
  await expect(usageFeedback(page)).toContainText('凭据来源：R2_IMAGE_*')
  await expect.poll(() => fillRatio(page)).toBeCloseTo(0.5, 2)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(server.writes).toEqual([])
})

test('failed usage lookup shows its reason with a zero gray bar instead of fabricated capacity', async ({page, sandboxURL}) => {
  const server = await backend(page)
  server.usage = {...usage, listError: '列桶失败：HTTP 403', usedBytes: 0, limitBytes: 0}
  await page.goto(sandboxURL)
  await expect(usageFeedback(page)).toContainText('列桶失败：HTTP 403')
  await expect(usageFeedback(page)).not.toContainText(/\d+(?:\.\d+)?\s*(?:GB|GiB|MB)|%/)
  await expect.poll(() => fillRatio(page)).toBe(0)
  await expect(panel(page).locator('.ant-progress-bg')).toHaveCSS('background-color', 'rgb(191, 191, 191)')
  await expect(bucket(page)).toHaveValue('saved-image-bucket')
  expect(server.writes).toEqual([])
})

test('saving submits exactly five storage fields and reloads saved settings and usage', async ({page, sandboxURL}) => {
  const server = await backend(page)
  await page.goto(sandboxURL)
  await expect(bucket(page)).toHaveValue('saved-image-bucket')
  await bucket(page).fill('new-image-bucket')
  await prefix(page).fill('new-gallery')
  await publicBase(page).fill('https://new-images.example.test')
  await panel(page).getByRole('spinbutton').fill('12')
  await panel(page).getByRole('switch').click()
  const settingsBefore = server.settingsReads, usageBefore = server.usageReads
  server.usage = {...usage, enabled: false, listError: 'R2 图床已关闭', usedBytes: 0}
  await save(page).click()
  await expect.poll(() => server.writes).toEqual([{
    r2ImageEnabled: false, r2ImageBucket: 'new-image-bucket', r2ImagePrefix: 'new-gallery',
    r2ImagePublicBase: 'https://new-images.example.test', r2ImageQuotaGB: 12,
  }])
  await expect(page.locator('.ant-message-success')).toContainText('图库存储设置已保存')
  await expect.poll(() => server.settingsReads).toBeGreaterThan(settingsBefore)
  await expect.poll(() => server.usageReads).toBe(usageBefore + 1)
  await expect(usageFeedback(page)).toContainText('R2 图床已关闭')
  await expect(panel(page).getByRole('switch')).not.toBeChecked()
  await expect.poll(async () => Number(await panel(page).getByRole('spinbutton').inputValue())).toBe(12)
  expect(server.settings.blogTitle).toBe('无关站点标题')
  expect(server.settings.manualReviewEnabled).toBe(true)
})

test('the quota lower bound cannot send a zero value and still permits a valid save', async ({page, sandboxURL}) => {
  const server = await backend(page)
  await page.goto(sandboxURL)
  const quota = panel(page).getByRole('spinbutton')
  await expect(quota).toHaveValue('9.5')
  await quota.fill('0')
  await panel(page).getByText('配额', {exact: true}).click()
  await expect.poll(async () => Number(await quota.inputValue())).toBeGreaterThan(0)
  await save(page).click()
  await expect.poll(() => server.writes.length).toBe(1)
  const saved = server.writes[0].r2ImageQuotaGB
  expect(typeof saved).toBe('number')
  expect(saved).toBeGreaterThan(0)
  await expect(page.locator('.ant-message-success')).toContainText('图库存储设置已保存')
  await expect(usageFeedback(page)).toContainText('4.75 GB')
})

for (const failure of ['business', 'http'] as const) {
  test(`${failure} failure preserves the editable draft and reports success only after a confirmed retry`, async ({page, sandboxURL}) => {
    const server = await backend(page)
    server.saveError = '公开域名设置不合法'
    server.saveStatus = failure === 'http' ? 503 : 200
    await page.goto(sandboxURL)
    await expect(bucket(page)).toHaveValue('saved-image-bucket')
    await publicBase(page).fill('https://draft-images.example.test')
    const settingsBefore = server.settingsReads, usageBefore = server.usageReads
    await save(page).click()
    await expect(page.locator('.ant-message-error')).toContainText(failure === 'business' ? '公开域名设置不合法' : '保存失败')
    expect(server.writes).toHaveLength(1)
    await expect(publicBase(page)).toHaveValue('https://draft-images.example.test')
    await expect(page.locator('.ant-message-success')).toHaveCount(0)
    expect(server.settingsReads).toBe(settingsBefore)
    expect(server.usageReads).toBe(usageBefore)
    server.saveError = ''
    server.saveStatus = 200
    // Ant's hidden exit icon can remain in the accessible name after loading ends.
    await expect(save(page)).not.toHaveClass(/\bant-btn-loading\b/)
    await expect(save(page)).toBeEnabled()
    await save(page).click()
    await expect(page.locator('.ant-message-success')).toContainText('图库存储设置已保存')
    expect(server.writes).toHaveLength(2)
    await expect.poll(() => server.usageReads).toBe(usageBefore + 1)
    expect(server.settings.r2ImagePublicBase).toBe('https://draft-images.example.test')
  })
}

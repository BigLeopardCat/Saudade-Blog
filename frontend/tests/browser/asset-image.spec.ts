import {test, expect} from './sandbox'

test.use({entry: 'asset-image', viewport: {width: 390, height: 900}})
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="3000"><rect width="300" height="3000" fill="pink"/></svg>'

test('failed image has a bounded retry UI and sanitized diagnostics; retry preserves its signed URL', async ({page, sandboxURL}) => {
    const reports: unknown[] = []
    const requests: string[] = []
    let release!: () => void
    const held = new Promise<void>(resolve => {release = resolve})
    await page.route('**/api/monitor/log', route => {
        reports.push(route.request().postDataJSON())
        return route.fulfill({json: {code: 200}})
    })
    await page.route('https://images.example/**', async route => {
        requests.push(route.request().url())
        if (requests.length === 1) {
            await held
            return route.fulfill({status: 403, contentType: 'text/plain', body: 'denied'})
        }
        return route.fulfill({contentType: 'image/svg+xml', body: svg})
    })
    await page.route('**/second.svg', route => route.fulfill({contentType: 'image/svg+xml', body: svg}))
    await page.goto(sandboxURL, {waitUntil: 'domcontentloaded'})
    await expect(page.getByText('图片加载中', {exact: true})).toBeVisible()
    release()
    await expect(page.getByText('图片加载失败', {exact: true})).toBeVisible()
    await expect(page.getByText('图片加载中', {exact: true})).toHaveCount(0)
    await expect(page.getByRole('img', {name: '测试封面'})).toHaveCount(0)
    await expect.poll(() => reports.length).toBeGreaterThan(0)
    expect(JSON.stringify(reports)).not.toContain('PRIVATE_')
    expect(reports).toContainEqual(expect.objectContaining({type: 'resource_error', url: 'https://images.example/api/image_review/test'}))
    await page.getByRole('button', {name: '重新加载图片：测试封面'}).click()
    await expect(page.getByRole('img', {name: '测试封面'})).toBeVisible()
    await expect.poll(() => page.getByRole('img', {name: '测试封面'}).evaluate(image => (image as HTMLImageElement).naturalHeight)).toBe(3000)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toBe(requests[0])
    expect(requests[1]).toContain('token=PRIVATE_REVIEW_TOKEN')
    await expect(page.getByText('图片加载失败', {exact: true})).toHaveCount(0)
    await expect(page.locator('.asset-image')).toHaveAttribute('aria-busy', 'false')
    await expect(page.getByRole('img', {name: '测试封面'})).toHaveAttribute('loading', 'lazy')
    await expect(page.getByRole('img', {name: '测试封面'})).toHaveAttribute('decoding', 'async')
    await page.getByRole('button', {name: '更换图片'}).click()
    await expect(page.getByRole('img', {name: '测试封面'})).toHaveAttribute('src', '/second.svg')
    await page.getByRole('button', {name: '移除图片'}).click()
    await expect(page.locator('.asset-image')).toHaveCount(0)
})

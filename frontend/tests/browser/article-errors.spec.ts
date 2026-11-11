import {test, expect} from './sandbox'

test.use({entry: 'article-cover'})

for (const id of ['62，这是助手的介绍', '0', '-1', '2147483648']) {
    test(`invalid article route ${id} shows not found without requesting an article`, async ({page, sandboxURL}) => {
        const target = new URL(sandboxURL)
        target.hash = new URLSearchParams({path: `/article/${encodeURIComponent(id)}`}).toString()
        await page.goto(target.href)
        await expect(page.getByRole('heading', {name: '文章不存在或链接有误'})).toBeVisible()
        await expect(page.getByText('404', {exact: true})).toBeVisible()
        await expect(page.getByRole('button', {name: '重新加载'})).toHaveCount(0)
        await expect(page.getByRole('link', {name: '← 返回首页'})).toHaveAttribute('href', '/')
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)
    })
}

test('a missing article shows 404, while a service failure offers a real retry', async ({page, sandboxURL}) => {
    let requests = 0
    await page.route('**/api/public/notes/1', route => {
        requests++
        return route.fulfill({status: requests === 1 ? 503 : 404,
            json: {code: requests === 1 ? 500 : 404, message: 'synthetic error', data: null}})
    })
    await page.route('**/api/monitor/log', route => route.fulfill({json: {code: 200}}))
    await page.goto(sandboxURL)
    await expect(page.getByRole('alert')).toContainText('文章加载失败')
    await expect(page.getByText('404', {exact: true})).toHaveCount(0)
    await page.getByRole('button', {name: '重新加载'}).click()
    await expect(page.getByRole('heading', {name: '文章不存在或链接有误'})).toBeVisible()
    await expect(page.getByRole('button', {name: '重新加载'})).toHaveCount(0)
    expect(requests).toBe(2)
})

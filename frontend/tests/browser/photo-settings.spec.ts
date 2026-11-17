import {test, expect} from './sandbox'
test.use({entry: 'photo-settings'})
test('gallery opens on demand, paginates, preserves order and saves only album settings', async ({page, sandboxURL}) => {
    const pages: string[] = [], writes: unknown[] = []
    await page.route('**/api/protected/websetting', route => {
        if (route.request().method() === 'POST') { writes.push(route.request().postDataJSON()); return route.fulfill({json: {code: 200, data: 'ok'}}) }
        return route.fulfill({json: {code: 200, data: {featuredPhotos: []}}})
    })
    await page.route('**/api/protect/gallery/images?*', route => {
        const url = new URL(route.request().url()); pages.push(url.search)
        const after = url.searchParams.has('before')
        return route.fulfill({json: {code: 200, data: {items: [{imageKey: after ? 2 : 1, imageUrl: '/test-photo.svg', displayName: after ? '夜樱' : '春日', description: '', version: 'v1', folderId: 0, isFavorite: false}], nextCursor: after ? null : 1}}})
    })
    await page.route('**/test-photo.svg', route => route.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>'}))
    await page.goto(sandboxURL)
    await expect(page.getByRole('button', {name: '从图库选择'})).toBeEnabled()
    expect(pages).toHaveLength(0)
    await page.getByRole('button', {name: '从图库选择'}).click()
    await page.getByRole('button', {name: '选择 春日'}).click()
    expect(pages).toHaveLength(1)
    expect(pages[0]).toContain('limit=30')
    await page.getByRole('button', {name: '加载更多'}).click()
    await page.getByRole('button', {name: '选择 夜樱'}).click()
    await page.getByRole('button', {name: '完成选择'}).click()
    await page.getByRole('button', {name: '照片 2 前移'}).click()
    await page.getByRole('textbox', {name: '照片 2 的说明'}).fill('夜樱小径')
    await page.getByRole('button', {name: '保存精选相册'}).click()
    await expect.poll(() => writes.length).toBe(1)
    expect(writes[0]).toEqual({featuredPhotos: [{imageId: 2, caption: '夜樱小径'}, {imageId: 1, caption: '春日'}]})
    expect(pages).toHaveLength(2)
})

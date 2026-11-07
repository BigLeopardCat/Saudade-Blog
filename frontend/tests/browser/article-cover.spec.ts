import {readFileSync} from 'node:fs'
import {test, expect} from './sandbox'
import type {Page} from '@playwright/test'

test.use({entry: 'article-cover'})
const portrait = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="900"><rect width="300" height="900" fill="pink"/><text x="10" y="30">TOP</text><text x="10" y="880">BOTTOM</text></svg>'
async function article(page: Page, cover: string, fields = {}) {
    await page.route('**/api/public/notes/1', route => route.fulfill({json: {code: 200, data: {
        noteKey: 1, noteTitle: '离线封面文章', noteContent: '# 标题\n\n文章正文。', cover,
        description: '文章简介', noteTags: [], status: 'public', authorName: '示例作者',
        authorAvatar: '', createTime: '2026-01-01', updateTime: '2026-01-01', ...fields,
    }}}))
    await page.route('**/api/public/notes/1/view', route => route.fulfill({json: {
        code: 200, data: {views: 1, likes: 0, comments: 0, liked: false},
    }}))
    await page.route('**/api/public/notes/1/comments**', route => route.fulfill({json: {
        code: 200, data: [],
    }}))
}

for (const fit of ['contain', 'cover'] as const) {
    test(`article ${fit} cover persists through a real theme change without video`, async ({page, sandboxURL}) => {
        await page.emulateMedia({reducedMotion: 'no-preference'})
        await article(page, '/article-cover.svg', {coverFit: fit,
            coverFocusX: 0.2, coverFocusY: 0.8, coverZoom: 1.3})
        let imageRequests = 0
        await page.route('**/article-cover.svg', route => {
            imageRequests++
            return route.fulfill({contentType: 'image/svg+xml', body: portrait})
        })
        await page.goto(sandboxURL)
        const image = page.locator('.readCover > img')
        await expect(image).toBeVisible()
        await expect(image).toHaveJSProperty('naturalHeight', 900)
        await expect(image).toHaveCSS('object-fit', fit)
        await expect(page.locator('.readCover video')).toHaveCount(0)
        const initial = await image.elementHandle()
        expect(initial).not.toBeNull()
        if (fit === 'cover') await expect(image).toHaveCSS('object-position', '20% 80%')
        await page.getByRole('button', {name: '切换主题'}).click()
        await expect(page.locator('.frontDark')).toBeVisible()
        await expect(image).toHaveAttribute('src', '/article-cover.svg')
        await expect(image).toHaveCSS('object-fit', fit)
        expect(await initial!.evaluate(element => element.isConnected)).toBe(true)
        expect(imageRequests).toBe(1)
        await expect(page.locator('.readCover video')).toHaveCount(0)
        await expect(page.getByRole('heading', {name: '离线封面文章', exact: true})).toBeVisible()
    })
}

for (const cover of ['', '/broken-cover.png']) {
    test(`missing or failed cover keeps a stable readable fallback: ${cover || 'empty'}`, async ({page, sandboxURL}) => {
        await article(page, cover)
        if (cover) await page.route('**/broken-cover.png', route => route.fulfill({status: 404, body: ''}))
        await page.goto(sandboxURL)
        const fallback = page.locator('.readCoverFallback')
        await expect(fallback).toBeVisible()
        await expect(page.locator('.readCover > img, .readCover video')).toHaveCount(0)
        const background = await fallback.evaluate(element => getComputedStyle(element).backgroundImage)
        expect(background).not.toBe('none')
        await page.getByRole('button', {name: '切换主题'}).click()
        await expect(page.locator('.frontDark')).toBeVisible()
        await expect(fallback).toHaveCSS('background-image', background)
        await expect(page.getByRole('heading', {name: '离线封面文章', exact: true})).toBeVisible()
    })
}

test('a held lazy route shows centered existing loading art without visible status text', async ({page, sandboxURL}) => {
    await page.route('**/loading.svg', route => route.fulfill({contentType: 'image/svg+xml',
        body: readFileSync(new URL('../../public/loading.svg', import.meta.url), 'utf8')}))
    await page.goto(`${sandboxURL}#pending-route`)
    const status = page.getByRole('status', {name: '正在加载页面'})
    await expect(status).toBeVisible()
    await expect(status).toHaveText('')
    const image = status.locator('img')
    await expect(image).toHaveJSProperty('naturalWidth', 80)
    const layout = await image.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        const parent = element.parentElement!.getBoundingClientRect()
        return {centerX: Math.abs(bounds.left + bounds.width/2 - (parent.left + parent.width/2)),
            centerY: Math.abs(bounds.top + bounds.height/2 - (parent.top + parent.height/2)),
            height: parent.height, viewport: innerHeight}
    })
    expect(layout.centerX).toBeLessThan(1)
    expect(layout.centerY).toBeLessThan(1)
    expect(layout.height).toBeGreaterThanOrEqual(layout.viewport*0.4)
    await expect(page.locator('body')).not.toContainText(/正在加载页面|Loading\.\.\./)
    await page.evaluate(() => window.finishRouteLoad?.())
    await expect(page.getByRole('heading', {name: '页面已就绪'})).toBeVisible()
    await expect(status).toHaveCount(0)
})

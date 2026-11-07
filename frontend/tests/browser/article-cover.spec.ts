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
        const image = page.locator('.readCoverMedia > .asset-image > img')
        await expect(image).toBeVisible()
        await expect(image).toHaveJSProperty('naturalHeight', 900)
        await expect(image).toHaveCSS('object-fit', fit)
        await expect(page.locator('.readCover video')).toHaveCount(0)
        await expect(page.locator('img[src=""]')).toHaveCount(0)
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
        if (cover) {
            await page.route('**/broken-cover.png', route => route.fulfill({status: 404, body: ''}))
            await page.route('**/api/monitor/log', route => {
                expect(route.request().method()).toBe('POST')
                const payload = route.request().postDataJSON()
                expect(payload.type).toBe('resource_error')
                expect(new URL(payload.url).pathname).toBe('/broken-cover.png')
                return route.fulfill({json: {code: 200}})
            })
        }
        await page.goto(sandboxURL)
        const fallback = page.locator('.readCoverFallback')
        await expect(fallback).toBeVisible()
        await expect(page.locator('.readCoverMedia > .asset-image > img, .readCover video')).toHaveCount(0)
        const background = await fallback.evaluate(element => getComputedStyle(element).backgroundImage)
        expect(background).not.toBe('none')
        await page.getByRole('button', {name: '切换主题'}).click()
        await expect(page.locator('.frontDark')).toBeVisible()
        await expect(fallback).toHaveCSS('background-image', background)
        await expect(page.getByRole('heading', {name: '离线封面文章', exact: true})).toBeVisible()
    })
}

test('article header renders the provided author without an unrelated fallback', async ({page, sandboxURL}) => {
    await article(page, '', {authorName: '本文作者', authorAvatar: '/article-author.svg'})
    await page.route('**/article-author.svg', route => route.fulfill({
        contentType: 'image/svg+xml', body: portrait,
    }))
    await page.goto(sandboxURL)
    await expect(page.locator('.readAuthorName')).toHaveText('本文作者')
    await expect(page.locator('.readAuthor img')).toHaveAttribute('src', '/article-author.svg')
    await expect(page.locator('.readAuthor img')).toHaveJSProperty('naturalWidth', 300)
    await expect(page.locator('img[src=""]')).toHaveCount(0)
})

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

test('real cover pending art unmounts on error, retries the same URL and stops after load', async ({page, sandboxURL}) => {
    await page.emulateMedia({reducedMotion: 'no-preference'})
    await article(page, '/pending-cover.svg')
    const requests: string[] = []
    let releaseFailure!: () => void, releaseSuccess!: () => void
    const failure = new Promise<void>(resolve => {releaseFailure = resolve})
    const success = new Promise<void>(resolve => {releaseSuccess = resolve})
    await page.route('**/api/monitor/log', route => route.fulfill({json: {code: 200}}))
    await page.route('**/pending-cover.svg', async route => {
        requests.push(route.request().url())
        if (requests.length === 1) {
            await failure
            return route.fulfill({status: 404, body: ''})
        }
        await success
        return route.fulfill({contentType: 'image/svg+xml', body: portrait})
    })
    await page.goto(sandboxURL, {waitUntil: 'domcontentloaded'})
    const cover = page.locator('.readCover')
    const pending = cover.locator('.sweep-loading')
    await expect(pending).toBeVisible()
    await expect(pending.locator('.sweep-loading__sprite')).toHaveCSS('animation-play-state', 'running')
    const bounds = await cover.boundingBox()
    releaseFailure()
    await expect(cover.getByRole('button', {name: '重新加载图片：文章封面'})).toBeVisible()
    await expect(pending).toHaveCount(0)
    await expect(cover.locator('.readCoverFallback')).toBeVisible()
    await cover.getByRole('button', {name: '重新加载图片：文章封面'}).click()
    await expect(pending).toBeVisible()
    await expect(cover).toHaveCSS('height', `${bounds!.height}px`)
    releaseSuccess()
    await expect(cover.getByRole('img', {name: '文章封面'})).toHaveJSProperty('naturalHeight', 900)
    await expect(pending).toHaveCount(0)
    expect(requests).toHaveLength(2)
    expect(requests[0]).toBe(requests[1])
    await expect(cover.locator('.asset-image')).toHaveAttribute('aria-busy', 'false')
    expect(await cover.evaluate(element => element.getAnimations({subtree: true})
        .filter(animation => animation instanceof CSSAnimation && animation.animationName === 'saudade-sweep-loading').length)).toBe(0)
})

test('article data loading uses scoped quiet art rather than the retired global animation', async ({page, sandboxURL}) => {
    let release!: () => void
    const waiting = new Promise<void>(resolve => {release = resolve})
    await article(page, '')
    await page.route('**/api/public/notes/1', async route => {
        await waiting
        return route.fulfill({json: {code: 200, data: {noteKey: 1, noteTitle: '等待后就绪',
            noteContent: '文章正文。', cover: '', description: '', noteTags: [], status: 'public',
            authorName: '示例作者', authorAvatar: '', createTime: '2026-01-01', updateTime: '2026-01-01'}}})
    })
    await page.goto(sandboxURL, {waitUntil: 'domcontentloaded'})
    const status = page.getByRole('status', {name: '正在加载文章'})
    await expect(status.locator('.sweep-loading')).toBeVisible()
    await expect(status).toHaveText('')
    await expect(page.locator('#bongo-cat, .LoadingContainer')).toHaveCount(0)
    release()
    await expect(page.getByRole('heading', {name: '等待后就绪'})).toBeVisible()
    await expect(status).toHaveCount(0)
    await expect(page.locator('.sweep-loading')).toHaveCount(0)
})


for (const width of [375, 1440]) {
    test(`detail cover keeps a 3.5:1 image and readable metadata at ${width}px`, async ({page, sandboxURL}) => {
        await page.setViewportSize({width, height: 900})
        await article(page, '/ratio-cover.svg', {coverFit: 'cover'})
        await page.route('**/ratio-cover.svg', route => route.fulfill({contentType: 'image/svg+xml', body: portrait}))
        await page.goto(sandboxURL)
        const frame = page.locator('.readCoverMedia')
        await expect(frame.getByRole('img', {name: '文章封面'})).toHaveJSProperty('naturalHeight', 900)
        await expect.poll(async () => {
            const info = await page.locator('.readInfo').boundingBox()
            return !!info && info.x >= 0 && info.x + info.width <= width + 1
        }).toBe(true)
        const media = await frame.boundingBox()
        const info = await page.locator('.readInfo').boundingBox()
        expect(media && info).toBeTruthy()
        expect(Math.abs(media!.width / media!.height - 3.5)).toBeLessThan(0.02)
        expect(info!.x).toBeGreaterThanOrEqual(0)
        expect(info!.x + info!.width).toBeLessThanOrEqual(width + 1)
        if (width < 768) expect(info!.y).toBeGreaterThanOrEqual(media!.y + media!.height)
        else expect(info!.y).toBeGreaterThanOrEqual(media!.y)
    })
}

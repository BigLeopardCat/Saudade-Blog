import {readFileSync} from 'node:fs'
import {test, expect} from './sandbox'
import type {Page} from '@playwright/test'

test.use({entry: 'article-cover'})
test.beforeEach(async ({page, sandboxURL}) => {
    await page.route(new URL('/loading.svg', sandboxURL).href, route => route.fulfill({contentType: 'image/svg+xml',
        body: readFileSync(new URL('../../public/loading.svg', import.meta.url), 'utf8')}))
})
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

const mermaidContent = [
    'flowchart LR\n' + Array.from({length: 12}, (_, index) =>
        `n${index}[步骤 ${index} 的完整节点文字]`).join(' --> '),
    'flowchart TD\n' + Array.from({length: 16}, (_, index) =>
        `n${index}[步骤 ${index} 的完整节点文字]`).join(' --> '),
    'flowchart LR\nA[开始] --> B[结束]',
    'sequenceDiagram\nparticipant A as 浏览器\nparticipant B as 服务端\n'
        + Array.from({length: 14}, (_, index) => `A->>B: 请求 ${index}\nB-->>A: 返回完整结果`).join('\n'),
].map(code => '```mermaid\n' + code + '\n```').join('\n\n')

for (const viewport of [{width: 1440, height: 900}, {width: 375, height: 812}, {width: 812, height: 375}]) {
    test.describe(`Mermaid ${viewport.width}×${viewport.height}`, () => {
        test.use({viewport, hasTouch: viewport.width < 769})
        test('文章及查看器默认显示整图，缩放与主题切换仍可用', async ({page, sandboxURL}) => {
            await article(page, '', {noteContent: mermaidContent})
            await page.goto(sandboxURL)
            const diagrams = page.locator('#content .bytemd-mermaid')
            await expect(diagrams.locator('svg')).toHaveCount(4)
            for (let index = 0; index < 4; index++) {
                const diagram = diagrams.nth(index)
                await diagram.scrollIntoViewIfNeeded()
                // Measure the viewBox's mapped corners, not just the SVG's outer box.
                const inline = await diagram.evaluate(element => {
                    const svg = element.querySelector('svg')!
                    const bounds = svg.getBoundingClientRect()
                    const view = svg.viewBox.baseVal
                    const matrix = svg.getScreenCTM()!
                    const start = new DOMPoint(view.x, view.y).matrixTransform(matrix)
                    const end = new DOMPoint(view.x + view.width, view.y + view.height).matrixTransform(matrix)
                    return {width: bounds.width, height: bounds.height,
                        overflow: element.scrollWidth - element.clientWidth,
                        left: start.x - bounds.left, top: start.y - bounds.top,
                        right: bounds.right - end.x, bottom: bounds.bottom - end.y,
                        naturalWidth: view.width, naturalHeight: view.height}
                })
                expect(inline.width).toBeGreaterThan(0)
                expect(inline.height).toBeGreaterThan(0)
                expect(inline.height).toBeLessThanOrEqual(viewport.height * .7 + 1)
                expect(inline.overflow).toBeLessThanOrEqual(1)
                for (const space of [inline.left, inline.top, inline.right, inline.bottom]) {
                    expect(space, 'the full viewBox stays inside the SVG').toBeGreaterThanOrEqual(-1)
                }
                if (index === 0) expect(inline.naturalWidth).toBeGreaterThan(viewport.width)
                if (index === 1) expect(inline.naturalHeight).toBeGreaterThan(viewport.height)
                if (viewport.width < 769) {
                    expect(await diagram.evaluate(element => getComputedStyle(element, '::after').opacity)).toBe('1')
                }
                await diagram.focus()
                await page.keyboard.press('Enter')
                const content = page.locator('.md-zoom-content')
                await expect(content).toBeVisible()
                const fitted = await content.boundingBox()
                expect(fitted!.x).toBeGreaterThanOrEqual(0)
                expect(fitted!.y).toBeGreaterThanOrEqual(0)
                expect(fitted!.x + fitted!.width).toBeLessThanOrEqual(viewport.width)
                expect(fitted!.y + fitted!.height).toBeLessThanOrEqual(viewport.height)
                // The diagram frame has real dimensions and its SVG has no inherited crop.
                const svg = content.locator('svg')
                const full = (await svg.boundingBox())!
                expect(full.width).toBeGreaterThan(0)
                expect(full.height).toBeGreaterThan(0)
                expect(full.x).toBeGreaterThanOrEqual(fitted!.x)
                expect(full.y).toBeGreaterThanOrEqual(fitted!.y)
                expect(full.x + full.width).toBeLessThanOrEqual(fitted!.x + fitted!.width + 1)
                expect(full.y + full.height).toBeLessThanOrEqual(fitted!.y + fitted!.height + 1)
                const center = {x: viewport.width / 2, y: viewport.height / 2}
                await page.mouse.dblclick(center.x, center.y)
                expect((await content.boundingBox())!.width).toBeGreaterThan(fitted!.width * 1.05)
                await page.mouse.dblclick(center.x, center.y)
                expect((await content.boundingBox())!.width).toBeCloseTo(fitted!.width, 0)
                await page.mouse.move(center.x, center.y)
                await page.mouse.wheel(0, -150)
                await expect.poll(async () => (await content.boundingBox())!.width).toBeGreaterThan(fitted!.width)
                const before = (await content.boundingBox())!
                await page.mouse.down()
                await page.mouse.move(center.x + 30, center.y + 20)
                await page.mouse.up()
                const after = (await content.boundingBox())!
                expect(after.x - before.x).toBeCloseTo(30, 0)
                expect(after.y - before.y).toBeCloseTo(20, 0)
                await page.keyboard.press('Escape')
                await expect(page.locator('.md-zoom-overlay')).toHaveCount(0)
                await expect(diagram).toBeFocused()
            }
            const readingBounds = (await page.locator('.readBody').boundingBox())!
            expect(readingBounds.x).toBeGreaterThanOrEqual(0)
            expect(readingBounds.x + readingBounds.width).toBeLessThanOrEqual(viewport.width + 1)
            await page.getByRole('button', {name: '切换主题'}).click()
            await expect(page.locator('.frontDark')).toBeVisible()
            for (let index = 0; index < 4; index++) {
                expect(await diagrams.nth(index).evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
            }
            await diagrams.first().click()
            const rotated = {width: viewport.height, height: viewport.width}
            await page.setViewportSize(rotated)
            await expect.poll(async () => {
                const box = (await page.locator('.md-zoom-content').boundingBox())!
                return box.x >= 0 && box.y >= 0 && box.x + box.width <= rotated.width + 1
                    && box.y + box.height <= rotated.height + 1
            }).toBe(true)
            await page.getByRole('button', {name: '关闭放大视图'}).click()
            await expect(page.locator('.md-zoom-overlay')).toHaveCount(0)
        })
    })
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
    const pending = cover.locator('.asset-image-pending')
    await expect(pending).toBeVisible()
    await expect(pending.locator('img')).toHaveAttribute('src', '/loading.svg')
    await expect(pending.locator('img')).toHaveCSS('width', '40px')
    await expect(pending.locator('img')).toHaveCSS('height', '40px')
    await expect(cover.locator('.sweep-loading')).toHaveCount(0)
    const bounds = await cover.boundingBox()
    releaseFailure()
    await expect(cover.getByRole('button', {name: '重新加载图片：文章封面'})).toBeVisible()
    await expect(pending).toHaveCount(0)
    await expect(cover.locator('.readCoverFallback')).toBeVisible()
    await cover.getByRole('button', {name: '重新加载图片：文章封面'}).click()
    await expect(pending).toBeVisible()
    await expect.poll(async () => Math.abs((await cover.boundingBox())!.height - bounds!.height)).toBeLessThan(0.1)
    releaseSuccess()
    await expect(cover.getByRole('img', {name: '文章封面'})).toHaveJSProperty('naturalHeight', 900)
    await expect(pending).toHaveCount(0)
    expect(requests).toHaveLength(2)
    expect(requests[0]).toBe(requests[1])
    await expect(cover.locator('.asset-image')).toHaveAttribute('aria-busy', 'false')
    expect(await cover.evaluate(element => element.getAnimations({subtree: true})
        .filter(animation => animation instanceof CSSAnimation && animation.animationName === 'saudade-sweep-loading').length)).toBe(0)
})

test('article data loading preserves the Bongo Cat visual and unmounts when ready', async ({page, sandboxURL}) => {
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
    const art = status.locator('.readPendingArt')
    await expect(art).toBeVisible()
    await expect(art).toHaveJSProperty('naturalWidth', 784)
    await expect(status.locator('.sweep-loading')).toHaveCount(0)
    await expect(status).toHaveText('')
    expect(await art.evaluate(image => (image as HTMLImageElement).src)).toContain('image/svg+xml')
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

import {readFileSync} from 'node:fs'
import {test, expect} from './sandbox'

test.use({entry: 'reader-theme'})
for (const width of [375, 1440, 1920]) {
    test(`article keeps the selected night theme on navigation and reload at ${width}px`, async ({page, sandboxURL}) => {
        await page.setViewportSize({width, height: 900})
        await page.emulateMedia({reducedMotion: 'reduce'})
        await page.clock.setFixedTime(new Date('2026-11-17T12:00:00+08:00'))
        await page.addInitScript(() => { Object.assign(window, {__agentChatInjected: true}) })
        await page.route('**/api/**', route => {
            const path = new URL(route.request().url()).pathname
            const data = path === '/api/public/notes/1' ? {
                noteKey: 1, noteTitle: '夜间阅读示例', noteContent: '# 春日手记\n\n文章正文。\n\n> 这是一段引用。\n\n## 沿途风景\n\n后续内容。',
                cover: '', description: '夜间模式也应当清晰可读。', status: 'public', noteTags: [], authorName: '示例作者',
                createTime: '2026-11-17', updateTime: '2026-11-17',
            } : path.endsWith('/view') || path.endsWith('/stats') ? {views: 1, likes: 0, comments: 0, liked: false}
                : path.endsWith('/user') ? {blogTitle: 'Saudade', userTalk: ''} : path.endsWith('/social') ? {} : []
            return route.fulfill({json: {code: 200, data}})
        })
        await page.route('**/default-avatar.png', route => route.fulfill({contentType: 'image/png',
            body: readFileSync(new URL('../../public/default-avatar.png', import.meta.url))}))
        await page.route('**/loading.svg', route => route.fulfill({contentType: 'image/svg+xml',
            body: readFileSync(new URL('../../public/loading.svg', import.meta.url), 'utf8')}))
        await page.goto(sandboxURL)
        await page.getByRole('button', {name: '切换夜间模式'}).click()
        await expect(page.locator('html')).toHaveAttribute('data-scene-dark', 'true')
        await page.getByRole('link', {name: '打开示例文章'}).click()
        const assertNight = async () => {
            await expect(page.locator('.frontRoot')).toHaveClass(/frontDark/)
            await expect(page.locator('html')).toHaveAttribute('data-scene-dark', 'true')
            await expect(page.locator('#content h1')).toHaveText('春日手记')
            await expect(page.locator('.readContent')).toHaveCSS('background-color', 'rgba(24, 36, 46, 0.96)')
            await expect(page.locator('.readContent')).toHaveCSS('color', 'rgb(228, 240, 245)')
            await expect(page.locator('.readDescription')).toHaveCSS('background-color', 'rgba(24, 36, 46, 0.9)')
            await expect(page.locator('.readDescriptionLabel')).toHaveCSS('color', 'rgb(228, 240, 245)')
            await expect(page.locator('#content blockquote')).toHaveCSS('color', 'rgb(176, 197, 208)')
            const card = (await page.locator('.readContent').boundingBox())!
            const text = (await page.locator('#content').boundingBox())!
            expect(Math.abs(card.x + card.width / 2 - width / 2)).toBeLessThan(1)
            expect(Math.abs(text.x + text.width / 2 - width / 2)).toBeLessThan(1)
            expect(await page.locator('html').evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(width + 1)
        }
        await assertNight()
        await page.goto(sandboxURL + '#path=/article/1')
        await assertNight()
        await page.reload()
        await assertNight()
        await page.screenshot({path: test.info().outputPath('centered-article-night.png')})
        await page.getByRole('button', {name: '切换日间模式'}).click()
        await expect(page.locator('html')).toHaveAttribute('data-scene-dark', 'false')
        await expect(page.locator('.frontRoot')).not.toHaveClass(/frontDark/)
        await expect(page.locator('.readContent')).toHaveCSS('background-color', 'rgba(247, 253, 255, 0.94)')
        await expect(page.locator('.readDescriptionLabel')).toHaveCSS('color', 'rgb(37, 62, 73)')
    })
}

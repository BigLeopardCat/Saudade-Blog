import {test, expect} from './sandbox'

test.use({entry: 'sakura-home'})
const cover = '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="400"><rect width="500" height="400" fill="#decad7"/></svg>'
for (const {width, height} of [{width: 375, height: 812}, {width: 1440, height: 900}, {width: 1440, height: 720}]) {
    test(`scene selection persists independently from night mode at ${width}×${height}`, async ({page, sandboxURL}) => {
        await page.setViewportSize({width, height})
        await page.emulateMedia({reducedMotion: 'reduce'})
        await page.route('**/api/**', route => {
            const path = new URL(route.request().url()).pathname
            const note = {noteKey: 1, noteTitle: '春日手记：沿着樱花盛开的河岸', noteContent: '', cover: '/cover.svg', noteCategory: 1,
                noteTags: [], description: '把生活里的光、旅途里的风，慢慢写进日常。', status: 'public', authorName: 'Sora', authorAvatar: '/cover.svg', createTime: '2026-01-01', updateTime: '2026-01-01'}
            const data = path.endsWith('/topnotes') ? [note] : path.endsWith('/notes/feed') ? {items: Array.from({length: 6}, (_, index) => ({...note, noteKey: index + 2})), nextCursor: null}
                : path.endsWith('/user') ? {blogTitle: 'Saudade', blogAuthor: 'Sora', userTalk: '愿每一段日常，都有值得记录的光。'}
                : path.endsWith('/social') ? {socialQQ: '123456789', socialGithub: 'https://github.com/BigLeopardCat', socialBilibili: 'https://www.bilibili.com', socialEmail: 'hello@example.test'} : []
            return route.fulfill({json: {code: 200, data}})
        })
        await page.route('**/cover.svg', route => route.fulfill({contentType: 'image/svg+xml', body: cover}))
        await page.route('**/default-avatar.png', route => route.fulfill({contentType: 'image/svg+xml', body: cover}))
        await page.goto(sandboxURL)
        await expect(page.locator('html')).toHaveAttribute('data-scene', 'station')
        await expect(page.locator('.heroPanel')).toHaveCSS('background-color', 'rgb(255, 253, 248)')
        if (width === 1440 && height === 900) {
            await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
            await page.getByRole('button', {name: '复制 QQ'}).click()
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('123456789')
        }
        await expect(page.locator('.heroTag')).toHaveCount(0)
        await expect(page.locator('.heroBottom')).not.toContainText('愿每一段日常')
        await expect(page.locator('footer')).toContainText('愿每一段日常，都有值得记录的光。')
        for (const name of ['复制 QQ', 'GitHub', '哔哩哔哩', '复制 Email']) {
            const button = name.startsWith('复制') ? page.getByRole('button', {name}) : page.getByRole('link', {name, exact: true})
            await expect(button).toBeVisible()
            expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44)
        }
        await expect(page.locator('.featuredCard').first()).toBeVisible()
        expect((await page.locator('.featuredCard').first().boundingBox())!.y + (await page.locator('.featuredCard').first().boundingBox())!.height).toBeLessThanOrEqual(height)
        expect((await page.locator('#home-articles').boundingBox())!.y).toBeGreaterThanOrEqual(height)
        for (const [id, name] of [['riverside', '樱花河岸'], ['station', '春日车站'], ['atelier', '画室窗边'], ['rain', '雨后暮色']]) {
            await page.getByRole('button', {name: '切换场景主题'}).click()
            await page.getByRole('button', {name: new RegExp(name)}).click()
            await expect(page.locator('html')).toHaveAttribute('data-scene', id)
            await expect(page.getByRole('button', {name: '切换夜间模式'})).toBeVisible()
            expect(await page.evaluate(() => localStorage.getItem('isDarkMode'))).not.toBe('true')
            await page.evaluate(async () => { const image = new Image(); image.src = getComputedStyle(document.documentElement).getPropertyValue('--scene-image').trim().replace(/^url\(['"]?|['"]?\)$/g, ''); await image.decode() })
            if (width === 1440) await page.screenshot({path: test.info().outputPath(`scene-${id}.png`)})
        }
        await expect(page.getByText('昼夜独立切换')).toHaveCount(0)
        await page.getByRole('button', {name: '切换夜间模式'}).click()
        await expect(page.locator('html')).toHaveAttribute('data-scene-dark', 'true')
        await expect(page.locator('.heroPanel')).toHaveCSS('background-color', 'rgb(255, 253, 248)')
        await expect(page.locator('html')).toHaveAttribute('data-scene', 'rain')
        await page.reload()
        await expect(page.locator('html')).toHaveAttribute('data-scene', 'rain')
        await expect(page.locator('html')).toHaveAttribute('data-scene-dark', 'true')
        await page.getByRole('button', {name: '切换场景主题'}).click()
        await expect(page.getByRole('button', {name: /雨后暮色/})).toHaveAttribute('aria-pressed', 'true')
        await page.keyboard.press('Escape')
        await expect(page.getByRole('group', {name: '场景主题'})).toHaveCount(0)
        await expect(page.getByRole('button', {name: '切换场景主题'})).toBeFocused()
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
        await page.screenshot({path: test.info().outputPath('sakura-night.png')})
        await page.getByRole('button', {name: '切换日间模式'}).click()
        await page.getByRole('button', {name: '切换场景主题'}).click()
        await page.getByRole('button', {name: /画室窗边/}).click()
        await page.screenshot({path: test.info().outputPath('sakura-day.png')})

        await page.getByRole('button', {name: '切换场景主题'}).click()
        await page.mouse.click(4, 100)
        await expect(page.getByRole('group', {name: '场景主题'})).toHaveCount(0)
        await page.evaluate(() => document.getElementById('home-articles')!.scrollIntoView({block: 'start', behavior: 'instant'}))
        await expect.poll(() => page.locator('.article').first().evaluate(element => getComputedStyle(element).opacity)).toBe('1')
        await page.screenshot({path: test.info().outputPath('sakura-articles.png')})
    })
}

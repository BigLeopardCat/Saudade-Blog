import {test, expect} from './sandbox'
import type {Page} from '@playwright/test'

test.use({entry: 'article-grid'})
test.beforeEach(async ({page, sandboxURL}) => {
    await page.route(new URL('/api/monitor/log', sandboxURL).href, route => {
        expect(route.request().method()).toBe('POST')
        return route.fulfill({json: {code: 200}})
    })
})
const widths = [375, 414, 640, 768, 800, 1024, 1280, 1366, 1440, 1680, 1920, 2560]
async function geometry(page: Page) {
    return page.locator('.allArticles').evaluate(grid => {
        const tracks = getComputedStyle(grid).gridTemplateColumns.split(' ').map(parseFloat)
        const cards = Array.from(grid.querySelectorAll<HTMLElement>('.ArticleCard')).map(card => {
            const rect = card.getBoundingClientRect()
            return {top: rect.top, width: rect.width, height: rect.height}
        })
        return {tracks, cards}
    })
}

test('real article cards fill their grid tracks and align across twelve viewport sizes', async ({page, sandboxURL}) => {
    await page.goto(sandboxURL)
    await expect(page.locator('.ArticleCard')).toHaveCount(12)
    for (const width of widths) {
        await page.setViewportSize({width, height: 900})
        await expect.poll(async () => {
            const {tracks, cards} = await geometry(page)
            const rows = new Map<number, typeof cards>()
            for (const card of cards) {
                const row = Math.round(card.top)
                rows.set(row, [...rows.get(row) ?? [], card])
            }
            return cards.every(card => tracks.some(track => Math.abs(card.width - track) <= 1))
                && [...rows.values()].every(row =>
                    Math.max(...row.map(c => c.width)) - Math.min(...row.map(c => c.width)) <= 1
                    && Math.max(...row.map(c => c.height)) - Math.min(...row.map(c => c.height)) <= 1)
        }, `cards fill tracks and align at ${width}px`).toBe(true)
    }
})

test('long metadata stays inside the compact card without hiding its author or date', async ({page, sandboxURL}) => {
    await page.goto(sandboxURL)
    for (const width of [375, 768, 1440, 1920]) {
        await page.setViewportSize({width, height: 900})
        expect(await page.locator('.ArticleCard').evaluateAll(cards => cards.every(card => {
            const bounds = card.getBoundingClientRect()
            const footer = card.querySelector('.ArticleFooter')!.getBoundingClientRect()
            return card.scrollWidth <= card.clientWidth + 1 && footer.bottom <= bounds.bottom && footer.top >= bounds.top
        }))).toBe(true)
    }
})

test('compact hover responds without resizing cards, moving neighbors or expanding summaries', async ({page, sandboxURL}) => {
    await page.setViewportSize({width:1440,height:1000})
    await page.goto(sandboxURL)
    const card=page.locator('.ArticleCard').nth(2)
    await card.scrollIntoViewIfNeeded()
    await page.mouse.move(0,0)
    const before=(await card.boundingBox())!
    const later=page.locator('.ArticleCard').nth(5)
    const neighbor=(await later.boundingBox())!
    const summary=card.locator('.ArticleDescription')
    const summaryHeight=await summary.evaluate(el=>el.clientHeight)
    await card.hover()
    expect(await card.evaluate(el=>getComputedStyle(el).transitionDelay)).toMatch(/^0s(?:, 0s)*$/)
    await expect.poll(()=>card.evaluate(el=>new DOMMatrixReadOnly(getComputedStyle(el).transform).f)).toBe(-2)
    const hovered=(await card.boundingBox())!
    expect(hovered.width).toBeCloseTo(before.width,1)
    expect(hovered.height).toBe(256)
    expect((await later.boundingBox())!.y).toBeCloseTo(neighbor.y,1)
    expect(await summary.evaluate(el=>el.clientHeight)).toBe(summaryHeight)
    await expect(summary).toHaveCSS('position','static')
    await expect(card.locator('.noteCardDate')).toHaveCount(2)
    expect(await card.locator('.noteCardDate').evaluateAll(cells=>cells.every(cell=>{
        const label=cell.children[0].getBoundingClientRect(),date=cell.children[1].getBoundingClientRect()
        return Math.abs(label.x+label.width/2-date.x-date.width/2)<1
    }))).toBe(true)
    const cover=(await card.locator('.ArticleCover').boundingBox())!
    const content=(await card.locator('.ArticleContent').boundingBox())!
    expect(content.x).toBeGreaterThan(cover.x+cover.width)
    expect(await card.locator('.tags').evaluate(el=>el.scrollHeight<=el.clientHeight+1)).toBe(true)
    await page.mouse.move(0,0)
    await expect.poll(()=>card.evaluate(el=>getComputedStyle(el).transform)).toBe('none')
    await page.emulateMedia({reducedMotion:'reduce'})
    await card.hover()
    await expect(card).toHaveCSS('transform','none')
})


test('tag folding follows available width and reveals all short tags when space permits', async ({page,sandboxURL}) => {
    await page.setViewportSize({width:1280,height:1000})
    await page.goto(sandboxURL)
    const grid=page.locator('.allArticles')
    await grid.evaluate(el=>{Object.assign((el as HTMLElement).style,{width:'860px',gridTemplateColumns:'1fr'})})
    const card=page.locator('.ArticleCard').nth(2)
    await card.scrollIntoViewIfNeeded()
    const tags=card.locator('.tagFitVisible .ant-tag')
    await expect(tags).toHaveCount(6)
    await expect(tags.filter({hasText:/^\+/})).toHaveCount(0)
    await grid.evaluate(el=>{(el as HTMLElement).style.width='430px'})
    await expect(tags.filter({hasText:/^\+/})).toHaveCount(1)
    const visible=(await tags.count())-1
    expect(visible).toBeGreaterThan(2)
    expect(visible).toBeLessThan(6)
    await expect(tags.last()).toHaveText(`+${6-visible}`)
    expect(await card.locator('.responsiveNoteTags').evaluate(el=>{
        const host=el.getBoundingClientRect(),row=el.querySelector('.tagFitVisible')!.getBoundingClientRect()
        return row.right<=host.right+1 && el.scrollWidth<=el.clientWidth+1
    })).toBe(true)
    await tags.last().hover()
    await expect(page.locator('.ant-popover-inner')).toContainText('标签6')
    await page.mouse.move(0,0)
    await grid.evaluate(el=>{(el as HTMLElement).style.width='860px'})
    await expect(tags).toHaveCount(6)
    await expect(tags.filter({hasText:/^\+/})).toHaveCount(0)
})

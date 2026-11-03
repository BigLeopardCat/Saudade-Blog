import {test, expect} from './sandbox'
import type {Page} from '@playwright/test'

test.use({entry: 'article-grid'})
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

test('removing card flex growth reproduces the old narrow-card defect', async ({page, sandboxURL}) => {
    await page.goto(sandboxURL)
    const undo = await page.addStyleTag({content: '.allArticles > .article > .ArticleCard {flex: 0 1 auto !important}'})
    for (const width of widths.filter(width => width >= 640)) {
        await page.setViewportSize({width, height: 900})
        await expect.poll(async () => {
            const {tracks, cards} = await geometry(page)
            return cards.some(card => tracks.every(track => Math.abs(card.width - track) > 1))
        }, `negative control reproduces narrow cards at ${width}px`).toBe(true)
    }
    await undo.evaluate(el => (el as HTMLStyleElement).remove())
    await expect.poll(async () => {
        const {tracks, cards} = await geometry(page)
        return cards.every(card => tracks.some(track => Math.abs(card.width - track) <= 1))
    }).toBe(true)
})

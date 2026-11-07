import {test,expect} from './sandbox'
import type {Page} from '@playwright/test'
test.use({entry:'home-hero'})
for (const width of [375,1440]) {
  test(`homepage retains its hero and does not load graph modules at ${width}px`,async ({page,sandboxURL}) => {
    await page.setViewportSize({width,height:900})
    const graphRequests:string[]=[]
    await page.route('**/api/**',route => {
      if (route.request().url().includes('/graph/')) graphRequests.push(route.request().url())
      return route.fulfill({json:{code:200,data:[]}})
    })
    await page.goto(sandboxURL)
    await expect(page.locator('.SelfDescription')).toBeVisible()
    await expect(page.locator('.heroPanel')).toBeVisible()
    await expect(page.locator('.heroRight .vitrine')).toHaveCount(0)
    await expect(page.locator('canvas')).toHaveCount(0)
    expect(graphRequests).toEqual([])
    expect(await page.locator('.SelfDescription').evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1)
    if (width===375) {
      const panel=await page.locator('.heroPanel').boundingBox()
      expect(panel!.x+panel!.width).toBeLessThanOrEqual(width+1)
    }
    await page.locator('.frontRoot').evaluate(el=>el.classList.add('frontDark'))
    await expect(page.locator('.heroPanel')).toBeVisible()
  })
}


const coverSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="900"><rect width="300" height="900" fill="pink"/></svg>'
function note(id: number, revision = 'old') {
  return {noteKey: id, noteTitle: `文章 ${id}`, noteContent: '', cover: `/${revision}-cover.svg`,
    coverFit: 'cover', carouselFit: 'cover', noteCategory: 1, noteTags: [],
    description: '封面测试文章', status: 'public', authorName: '测试作者', authorAvatar: '',
    createTime: '2026-01-01', updateTime: '2026-01-01'}
}
async function images(page: Page) {
  await page.route('**/*-cover.svg', route => route.fulfill({contentType: 'image/svg+xml', body: coverSVG}))
}
for (const width of [375, 1440]) {
  test(`homepage cover containers match card and carousel previews at ${width}px`, async ({page, sandboxURL}) => {
    await page.setViewportSize({width, height: 900})
    await images(page)
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url())
      const rows = url.pathname === '/api/public/topnotes' ? [note(1)]
        : url.pathname === '/api/public/notes/page' ? [note(2)] : []
      return route.fulfill({json: {code: 200, data: rows}})
    })
    await page.goto(sandboxURL)
    const card = page.locator('.ArticleCover').first()
    const carousel = page.locator('.TopCover').first()
    await expect(card).toBeVisible()
    await expect(carousel).toBeVisible()
    for (const [container, ratio] of [[card, 16 / 9], [carousel, 1]] as const) {
      const box = await container.boundingBox()
      expect(box!.width / box!.height).toBeCloseTo(ratio, 2)
    }
    const title = await page.locator('.topContent .contentTitle').boundingBox()
    const content = await page.locator('.topContent').boundingBox()
    expect(title!.x).toBeGreaterThanOrEqual(content!.x)
    expect(title!.x + title!.width).toBeLessThanOrEqual(content!.x + content!.width + 1)
  })
}

test('Agent completion refreshes loaded pages and carousel without losing the More offset', async ({page, sandboxURL}) => {
  await page.setViewportSize({width: 1440, height: 900})
  await images(page)
  let revision = 'old'
  const requested: {page: number; size: number}[] = []
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url())
    let rows: ReturnType<typeof note>[] = []
    if (url.pathname === '/api/public/topnotes') rows = [note(1, revision)]
    if (url.pathname === '/api/public/notes/page') {
      const number = Number(url.searchParams.get('page'))
      const size = Number(url.searchParams.get('pageSize'))
      requested.push({page: number, size})
      rows = Array.from({length: size}, (_, index) => note(100 + (number - 1) * size + index, revision))
    }
    return route.fulfill({json: {code: 200, data: rows}})
  })
  await page.goto(sandboxURL)
  const more = page.getByRole('button', {name: 'More', exact: true})
  await expect(more).toBeEnabled()
  await more.click()
  await expect(more).toBeEnabled()
  await expect.poll(() => requested.at(-1)?.page).toBe(2)
  const size = requested.at(-1)!.size
  await expect(page.locator('.ArticleCard')).toHaveCount(size * 2)
  revision = 'new'
  const start = requested.length
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('agent-turn-done', {detail: {confirmationAttempted: true, articleIdsToRefresh: [100]}})))
  await expect(page.locator('.TopCover img')).toHaveAttribute('src', '/new-cover.svg')
  const firstCover = page.locator('.ArticleCover').first()
  await firstCover.scrollIntoViewIfNeeded()
  const firstImage = firstCover.locator('img')
  await expect(firstImage).toHaveAttribute('src', '/new-cover.svg')
  await expect(page.locator('.ArticleCard')).toHaveCount(size * 2)
  await expect(more).toBeEnabled()
  expect(requested.slice(start)).toEqual([{page: 1, size}, {page: 2, size}])
  await more.click()
  await expect.poll(() => requested.at(-1)?.page).toBe(3)
  await expect(page.locator('.ArticleCard')).toHaveCount(size * 3)
})

test('Agent completion during the initial carousel fetch queues one fresh read', async ({page, sandboxURL}) => {
  await images(page)
  let topRequests = 0
  let release!: () => void
  const held = new Promise<void>(resolve => {release = resolve})
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    let rows: ReturnType<typeof note>[] = []
    if (url.pathname === '/api/public/topnotes') {
      topRequests++
      rows = [note(1, topRequests === 1 ? 'old' : 'new')]
      if (topRequests === 1) await held
    } else if (url.pathname === '/api/public/notes/page') rows = [note(2)]
    return route.fulfill({json: {code: 200, data: rows}})
  })
  try {
    await page.goto(sandboxURL)
    await expect(page.locator('.ArticleCard')).toHaveCount(1)
    await expect.poll(() => topRequests).toBe(1)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('agent-turn-done', {detail: {confirmationAttempted: true, articleIdsToRefresh: [1]}})))
  } finally {release()}
  await expect(page.locator('.TopCover img')).toHaveAttribute('src', '/new-cover.svg')
  expect(topRequests).toBe(2)
})

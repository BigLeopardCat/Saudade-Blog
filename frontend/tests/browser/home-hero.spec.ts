import {test, expect} from './sandbox'
import type {Page} from '@playwright/test'
test.use({entry: 'home-hero'})
const coverSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="900"><rect width="300" height="900" fill="pink"/></svg>'
function note(id: number, revision = 'old') {
  return {noteKey: id, noteTitle: `文章 ${id}：关于生活与代码的一些记录`, noteContent: '', cover: `/${revision}-cover.svg`,
    coverFit: 'cover', carouselFit: 'cover', noteCategory: 1, noteTags: [], noteTagRefs: [{id: 1, level: 1, name: '生活与代码', color: 'blue'}],
    description: '封面测试文章，保留清晰的标题、摘要和作者信息。'.repeat(8), status: 'public', authorName: '测试作者', authorAvatar: '/old-cover.svg',
    createTime: '2026-01-01', updateTime: '2026-01-01'}
}
async function images(page: Page) {
  await page.route('**/*-cover.svg', route => route.fulfill({contentType: 'image/svg+xml', body: coverSVG}))
}
function emptyData(path: string) {
  return path === '/api/public/notes/feed' ? {items: [], nextCursor: null} : []
}
for (const width of [375, 1440]) {
  test(`homepage retains its hero and does not load graph modules at ${width}px`, async ({page, sandboxURL}) => {
    await page.setViewportSize({width, height: 900})
    const graphRequests: string[] = []
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname
      if (path.includes('/graph/')) graphRequests.push(path)
      return route.fulfill({json: {code: 200, data: emptyData(path)}})
    })
    await page.goto(sandboxURL)
    await expect(page.locator('.SelfDescription')).toBeVisible()
    await expect(page.locator('.heroPanel')).toBeVisible()
    await expect(page.locator('.heroRight .vitrine')).toHaveCount(0)
    await expect(page.locator('canvas')).toHaveCount(0)
    expect(graphRequests).toEqual([])
    expect(await page.locator('.SelfDescription').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    if (width === 375) {
      const panel = await page.locator('.heroPanel').boundingBox()
      expect(panel!.x + panel!.width).toBeLessThanOrEqual(width + 1)
    }
    await page.locator('.frontRoot').evaluate(el => el.classList.add('frontDark'))
    await expect(page.locator('.heroPanel')).toBeVisible()
  })

  test(`homepage keeps compact pinned cards and cover crops at ${width}px`, async ({page, sandboxURL}) => {
    await page.setViewportSize({width, height: 900})
    await page.emulateMedia({reducedMotion: 'reduce'})
    await images(page)
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname
      const data = path === '/api/public/topnotes' ? [note(1), note(3)]
        : path === '/api/public/notes/feed' ? {items: [note(2)], nextCursor: null} : []
      return route.fulfill({json: {code: 200, data}})
    })
    await page.goto(sandboxURL)
    const featured = page.locator('.featuredArticles')
    await featured.scrollIntoViewIfNeeded()
    await expect(featured).toBeVisible()
    await expect(page.getByRole('button', {name: 'More', exact: true})).toHaveCount(0)
    for (const [container, ratio] of [[page.locator('.ArticleCover').first(), 16 / 9], [page.locator('.featuredCover'), 1]] as const) {
      const box = await container.boundingBox()
      expect(box!.width / box!.height).toBeCloseTo(ratio, 2)
    }
    const title = (await page.locator('.featuredContent h2').boundingBox())!
    const content = (await page.locator('.featuredContent').boundingBox())!
    const card = (await page.locator('.featuredCard').boundingBox())!
    const grid = (await page.locator('.allArticles:not(.allArticlesMeasure)').boundingBox())!
    expect(title.x).toBeGreaterThanOrEqual(content.x)
    expect(title.x + title.width).toBeLessThanOrEqual(content.x + content.width + 1)
    expect(Math.abs(card.x - grid.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(card.width - grid.width)).toBeLessThanOrEqual(1)
    expect(card.width).toBeLessThanOrEqual(1280)
    expect(card.height).toBeLessThanOrEqual(width < 640 ? 320 : 420)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
    await expect(featured.locator('h2 a')).toHaveAttribute('href', '/article/1')
    await page.getByRole('button', {name: '下一篇置顶文章'}).click()
    await expect(featured.locator('h2 a')).toHaveAttribute('href', '/article/3')
    await expect(page.locator('.featuredCount')).toHaveText('2 / 2')
    await page.getByRole('button', {name: '暂停置顶轮播'}).click()
    await expect(page.getByRole('button', {name: '播放置顶轮播'})).toHaveAttribute('aria-pressed', 'true')
    await featured.screenshot({path: test.info().outputPath('pinned-light.png')})
    await page.locator('.frontRoot').evaluate(el => el.classList.add('frontDark'))
    await featured.screenshot({path: test.info().outputPath('pinned-dark.png')})
  })
}

test('scrolling loads cursors; Agent refresh preserves the loaded window and uses fresh cursors', async ({page, sandboxURL}) => {
  await page.setViewportSize({width: 1440, height: 900})
  await images(page)
  let revision = 'old'
  const requested: {cursor: string | null; size: number}[] = []
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url())
    let data: unknown = []
    if (url.pathname === '/api/public/topnotes') data = [note(1, revision)]
    if (url.pathname === '/api/public/notes/feed') {
      const cursor = url.searchParams.get('cursor')
      const size = Number(url.searchParams.get('limit'))
      requested.push({cursor, size})
      const chunk = cursor ? Number(cursor.split(':')[1]) : 0
      data = {items: Array.from({length: size}, (_, index) => note(100 + chunk * size + index, revision)),
        nextCursor: chunk < 2 ? `${revision}:${chunk + 1}` : null}
    }
    return route.fulfill({json: {code: 200, data}})
  })
  await page.goto(sandboxURL)
  await expect.poll(() => requested.length).toBe(1)
  const size = requested[0].size
  await page.locator('.homeFeedBoundary').scrollIntoViewIfNeeded()
  await expect(page.locator('.ArticleCard')).toHaveCount(size * 2)
  await page.locator('.ArticleCard').first().scrollIntoViewIfNeeded()
  revision = 'new'
  const start = requested.length
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('agent-turn-done', {detail: {confirmationAttempted: true, articleIdsToRefresh: [100]}})))
  await expect(page.locator('.featuredCover img')).toHaveAttribute('src', '/new-cover.svg')
  await expect(page.locator('.ArticleCover img').first()).toHaveAttribute('src', '/new-cover.svg')
  await expect(page.locator('.ArticleCard')).toHaveCount(size * 2)
  await expect.poll(() => requested.slice(start)).toEqual([{cursor: null, size}, {cursor: 'new:1', size}])
  await page.locator('.homeFeedBoundary').scrollIntoViewIfNeeded()
  await expect(page.locator('.ArticleCard')).toHaveCount(size * 3)
  await expect(page.locator('.homeFeedBoundary')).toContainText('已经看到全部文章了')
  expect(requested.at(-1)).toEqual({cursor: 'new:2', size})
})

test('a failed automatic page preserves articles and retries the same cursor only on request', async ({page, sandboxURL}) => {
  await images(page)
  const cursors: (string | null)[] = []
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url())
    let data: unknown = []
    if (url.pathname === '/api/public/notes/feed') {
      const cursor = url.searchParams.get('cursor')
      cursors.push(cursor)
      if (cursor && cursors.length === 2) return route.fulfill({status: 503, json: {code: 503}})
      const size = Number(url.searchParams.get('limit'))
      data = {items: Array.from({length: size}, (_, index) => note((cursor ? 100 : 0) + index)), nextCursor: cursor ? null : 'next'}
    }
    return route.fulfill({json: {code: 200, data}})
  })
  await page.goto(sandboxURL)
  await expect.poll(() => cursors.length).toBe(1)
  await expect(page.locator('.ArticleCard').first()).toBeVisible()
  const count = await page.locator('.ArticleCard').count()
  await page.locator('.homeFeedBoundary').scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', {name: '重试', exact: true})).toBeVisible()
  await expect(page.locator('.ArticleCard')).toHaveCount(count)
  await page.waitForTimeout(300)
  expect(cursors).toEqual([null, 'next'])
  await page.getByRole('button', {name: '重试', exact: true}).click()
  await expect(page.locator('.ArticleCard')).toHaveCount(count * 2)
  expect(cursors).toEqual([null, 'next', 'next'])
})

test('Agent completion during the initial pinned fetch queues one fresh read', async ({page, sandboxURL}) => {
  await images(page)
  let topRequests = 0
  let release!: () => void
  const held = new Promise<void>(resolve => {release = resolve})
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    let data: unknown = emptyData(path)
    if (path === '/api/public/topnotes') {
      topRequests++
      data = [note(1, topRequests === 1 ? 'old' : 'new')]
      if (topRequests === 1) await held
    } else if (path === '/api/public/notes/feed') data = {items: [note(2)], nextCursor: null}
    return route.fulfill({json: {code: 200, data}})
  })
  try {
    await page.goto(sandboxURL)
    await expect(page.locator('.ArticleCard')).toHaveCount(1)
    await expect.poll(() => topRequests).toBe(1)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('agent-turn-done', {detail: {confirmationAttempted: true, articleIdsToRefresh: [1]}})))
  } finally {release()}
  await expect(page.locator('.featuredCover img')).toHaveAttribute('src', '/new-cover.svg')
  expect(topRequests).toBe(2)
})

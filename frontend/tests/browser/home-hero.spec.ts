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
    await expect(page.locator('.featuredPhotoStack')).toHaveCount(0)
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

  test(`homepage shows compact horizontal pinned cards before the scrolling article feed at ${width}px`, async ({page, sandboxURL}) => {
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
    await expect(page.getByRole('button', {name: '浏览全部文章'})).toHaveCount(0)
    await expect(page.locator('.heroBottom')).toHaveCount(0)
    const title = (await featured.locator('.ArticleTitle').first().boundingBox())!
    const content = (await featured.locator('.ArticleContent').first().boundingBox())!
    const card = (await page.locator('.featuredCard').first().boundingBox())!
    const cover = (await featured.locator('.ArticleCover').first().boundingBox())!
    const firstScreen = (await page.locator('.homeFirstScreen').boundingBox())!
    const feed = (await page.locator('#home-articles').boundingBox())!
    expect(title.x).toBeGreaterThanOrEqual(content.x)
    expect(title.x + title.width).toBeLessThanOrEqual(content.x + content.width + 1)
    expect(content.x).toBeGreaterThanOrEqual(cover.x + cover.width)
    expect(card.y + card.height).toBeLessThanOrEqual(firstScreen.y + firstScreen.height)
    expect(feed.y).toBeGreaterThanOrEqual(firstScreen.y + firstScreen.height)
    expect(card.height).toBe(216)
    expect(await page.locator('.featuredArticles .ArticleCover img').first().evaluate(el => getComputedStyle(el).objectFit)).toBe('cover')
    await expect(featured.locator('.homeSectionTitle')).toHaveText('置顶')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
    await expect(featured.locator('.ArticleTitle a').first()).toHaveAttribute('href', '/article/1')
    if (width === 375) {
      const segment = featured.getByRole('button', {name: /^第 2 组/})
      await segment.click()
      await expect(segment).toHaveAttribute('aria-pressed', 'true')
    } else await expect(featured.getByRole('button')).toHaveCount(0)
    await page.mouse.move(0, 0)
    await page.waitForTimeout(350)
    const box = (await featured.boundingBox())!
    const clip = {x: box.x, y: Math.max(0, box.y - 44), width: box.width, height: box.height + Math.min(44, box.y)}
    await page.screenshot({clip, path: test.info().outputPath('pinned-light.png')})
    await page.locator('.frontRoot').evaluate(el => el.classList.add('frontDark'))
    await page.screenshot({clip, path: test.info().outputPath('pinned-dark.png')})
    await page.locator('.frontRoot').evaluate(el => el.classList.remove('frontDark'))
    await page.locator('#home-articles').scrollIntoViewIfNeeded()
    await expect(page.locator('#home-articles .ArticleTitle').first()).toHaveCSS('font-size', '19px')
    await expect(page.locator('#home-articles .ArticleCard').first()).toHaveCSS('height', '256px')
    await page.screenshot({fullPage: true, path: test.info().outputPath('pinned-feed-comparison.png')})
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
  // Enter the prefetch band, then leave it before refreshing the loaded window.
  await page.locator('.homeFeedBoundary').evaluate(element => window.scrollTo({top: window.scrollY + element.getBoundingClientRect().top - innerHeight - 160, behavior:'instant'}))
  await expect(page.locator('.allArticles .ArticleCard')).toHaveCount(size * 2)
  await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}))
  revision = 'new'
  const start = requested.length
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('agent-turn-done', {detail: {confirmationAttempted: true, articleIdsToRefresh: [100]}})))
  await expect(page.locator('.featuredArticles .ArticleCover img').first()).toHaveAttribute('src', '/new-cover.svg')
  await expect(page.locator('.ArticleCover img').first()).toHaveAttribute('src', '/new-cover.svg')
  await expect(page.locator('.allArticles .ArticleCard')).toHaveCount(size * 2)
  await expect.poll(() => requested.slice(start)).toEqual([{cursor: null, size}, {cursor: 'new:1', size}])
  await page.locator('.homeFeedBoundary').scrollIntoViewIfNeeded()
  await expect(page.locator('.allArticles .ArticleCard')).toHaveCount(size * 3)
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
  await expect(page.locator('.allArticles .ArticleCard').first()).toBeVisible()
  const count = await page.locator('.allArticles .ArticleCard').count()
  await page.locator('.homeFeedBoundary').scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', {name: '重试', exact: true})).toBeVisible()
  await expect(page.locator('.allArticles .ArticleCard')).toHaveCount(count)
  await page.waitForTimeout(300)
  expect(cursors).toEqual([null, 'next'])
  await page.getByRole('button', {name: '重试', exact: true}).click()
  await expect(page.locator('.allArticles .ArticleCard')).toHaveCount(count * 2)
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
    await expect(page.locator('.allArticles .ArticleCard')).toHaveCount(1)
    await expect.poll(() => topRequests).toBe(1)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('agent-turn-done', {detail: {confirmationAttempted: true, articleIdsToRefresh: [1]}})))
  } finally {release()}
  await expect(page.locator('.featuredArticles .ArticleCover img').first()).toHaveAttribute('src', '/new-cover.svg')
  expect(topRequests).toBe(2)
})

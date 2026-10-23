import { test, expect } from './sandbox'

test.use({ entry: 'public-header' })
for (const width of [375, 390, 1440]) {
  test(`real header aggregate search routes, filters and layout at ${width}px`, async ({ page, sandboxURL }) => {
    await page.setViewportSize({ width, height: 900 })
    const makeHit = (type: string, key: number) => ({ type, key, title: type === 'board' ? '' : '河灯部署', snippet: '<img src=x onerror=alert(1)> 河灯部署正文', author: '署名', noteId: 5, createTime: '2026-10-23' })
    const hits = [makeHit('note', 5), makeHit('talk', 9), makeHit('board', 8), makeHit('comment', 41)]
    const queries: Record<string, unknown>[] = []
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/search')) {
        const query = route.request().postDataJSON() as Record<string, unknown>
        queries.push(query)
        const selected = hits.filter(hit => !query.type || hit.type === query.type)
        return route.fulfill({ json: { code: 200, data: { total: 4, counts: { note: 1, talk: 1, board: 1, comment: 1 }, notes: selected.filter(hit => hit.type === 'note'), talks: selected.filter(hit => hit.type === 'talk'), board: selected.filter(hit => hit.type === 'board'), comments: selected.filter(hit => hit.type === 'comment'), terms: ['河灯', '部署'], page: 1, pageSize: 20, hasMore: false } } })
      }
      return route.fulfill({ json: { code: 200, data: path.endsWith('/user') ? { blogTitle: 'Saudade', blogAuthor: '作者' } : path.endsWith('/social') ? {} : [] } })
    })
    await page.route('**/default-avatar.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') }))
    await page.goto(sandboxURL)
    async function open() {
      if (width < 1200) {
        await page.getByRole('button', { name: '打开导航菜单' }).click()
        await page.locator('.mSearchInput').click()
      } else await page.locator('.homeRight > div').first().click()
      await expect(page.getByRole('combobox', { name: '搜索站内内容' })).toBeVisible()
      await page.getByRole('combobox').fill('河灯部署')
      await expect(page.getByRole('option')).toHaveCount(4)
    }
    await open()
    await expect(page.locator('.searchTotal')).toHaveText('搜索结果（4）')
    await expect(page.locator('.search-badge')).toHaveText(['文章', '说说', '留言', '评论'])
    await expect(page.locator('.search-item img')).toHaveCount(0)
    expect(await page.locator('.search-chip').evaluateAll(elements => elements.every(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth }))).toBe(true)
    expect(await page.locator('.ant-modal-content:visible').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: test.info().outputPath('aggregate-search.png') })
    await page.getByRole('button', { name: '说说（1）' }).click()
    await expect(page.getByRole('option')).toHaveCount(1)
    expect(queries[queries.length - 1]).toEqual({ keyword: '河灯部署', page: 1, pageSize: 20, type: 'talk' })
    await page.getByRole('button', { name: '说说（1）' }).click()
    await expect(page.getByRole('option')).toHaveCount(4)
    await expect(page.locator('.aggregateSearchCard')).toHaveCSS('background-color', 'rgb(255, 253, 250)')
    const targets = ['/article/5', '/talk?tk=9', '/guestbook?lid=8', '/article/5?cid=41']
    for (let index = 0; index < targets.length; index++) {
      if (index) await open()
      await page.getByRole('option').nth(index).click()
      await expect(page.getByTestId('location')).toHaveText(targets[index])
      await expect(page.getByRole('combobox')).toHaveCount(0)
    }
    if (width === 1440) {
      await page.locator('.homeSwitch .theme-switch').click()
      await open()
      await expect(page.locator('.washiDark .search-item').first()).toHaveCSS('color', 'rgb(243, 232, 246)')
      await page.screenshot({ path: test.info().outputPath('aggregate-search-dark.png') })
    }
  })
}

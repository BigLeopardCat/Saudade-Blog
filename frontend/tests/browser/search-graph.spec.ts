import { test, expect } from './sandbox'
test.use({ entry: 'public-header' })
const graph = {v: 'fixture20261104', model: 'fixture', dim: 2, built: '', stats: {},
  nodes: [{i: 0, w: 'Python', x: 0, y: 0, z: 0, n: 1, h: 1, a: 0, a2: 0}], edges: [],
  articles: [{id: 5, t: 'Python 入门', g: ['Python'], c: '编程'}]}
for (const {width, signedIn, available} of [
  {width:375,signedIn:false,available:false}, {width:1440,signedIn:false,available:false},
  {width:1440,signedIn:true,available:false}, {width:1440,signedIn:true,available:true},
]) {
  test(`one search input at ${width}px, signed in=${signedIn}, semantic=${available}`, async ({page, sandboxURL}) => {
    await page.setViewportSize({width, height: 900})
    if (signedIn) await page.addInitScript(() => {
      const claims=btoa(JSON.stringify({sub:4,role:'user',exp:Date.now()/1000+600}))
      localStorage.setItem('tokenKey',`fixture.${claims}.fixture`)
    })
    let searchCalls = 0, vectorCalls = 0
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/graph/manifest')) return route.fulfill({json: {v: graph.v, file: `graph-${graph.v}.js`, site: sandboxURL}})
      if (path.endsWith(`/graph/artifact/graph-${graph.v}.js`)) return route.fulfill({contentType: 'text/javascript', body: `export default ${JSON.stringify(graph)}`})
      if (path.endsWith('/graph/query')) { vectorCalls++; return route.fulfill({json: available ? {ok:true,words:[{w:'python',s:.9}]} : {ok: false, reason: 'service_unavailable', words: []}}) }
      if (path.endsWith('/search')) { searchCalls++; return route.fulfill({json: {code: 200, data: {total: 0, counts: {note:0,talk:0,board:0,comment:0}, notes:[],talks:[],board:[],comments:[],terms:[],hasMore:false}}}) }
      return route.fulfill({json: {code:200,data: path.endsWith('/user') ? {blogTitle:'博客'} : {}}})
    })
    await page.route('**/default-avatar.png', route => route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')}))
    await page.goto(sandboxURL)
    if (width < 1200) { await page.getByRole('button', {name:'打开导航菜单'}).click(); await page.locator('.mSearchInput').click() }
    else await page.locator('.homeRight > div').first().click()
    const input = page.getByRole('combobox', {name:'搜索站内内容'})
    await input.fill('Python')
    await expect(page.getByText('未找到相关内容')).toBeVisible()
    const mode = page.getByRole('button', {name:'文章向量图谱检索'})
    await mode.click()
    await expect(mode).toHaveAttribute('aria-pressed','true')
    await expect(input).toHaveValue('Python')
    await expect(page.getByLabel('相关文章', {exact:true}).getByRole('link', {name:'Python 入门'})).toBeVisible()
    await expect(page.getByText(!signedIn ? '当前使用关键词匹配，登录后可使用语义检索。' : available ? '已按语义关联定位；图中距离仅供探索参考。' : '语义检索暂不可用，当前显示关键词匹配结果。')).toBeVisible()
    expect(vectorCalls).toBe(signedIn ? 1 : 0)
    expect(searchCalls).toBe(1)
    await expect(page.locator('.articleGraph canvas')).toBeVisible()
    expect(await page.locator('.ant-modal-content:visible').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({path:test.info().outputPath('article-graph.png')})
    await mode.click()
    await expect(page.getByText('未找到相关内容')).toBeVisible()
    expect(searchCalls).toBe(1)
    await mode.click()
    await page.getByLabel('相关文章', {exact:true}).getByRole('link', {name:'Python 入门'}).click()
    await expect(page.getByTestId('location')).toHaveText('/article/5')
    await expect(page.getByRole('combobox')).toHaveCount(0)
  })
}

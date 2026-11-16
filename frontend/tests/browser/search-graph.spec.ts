import {test, expect} from './sandbox'
test.use({entry: 'public-header'})
for (const width of [375, 1440]) {
    test(`paused visualization makes no graph requests and preserves content search at ${width}px`, async ({page, sandboxURL}) => {
        await page.setViewportSize({width, height: 900})
        const graphCalls: string[] = []
        let searchCalls = 0
        await page.route('**/api/**', route => {
            const path = new URL(route.request().url()).pathname
            if (path.includes('/graph/')) { graphCalls.push(path); return route.fulfill({json: {}}) }
            if (path.endsWith('/search')) { searchCalls++; return route.fulfill({json: {code: 200, data: {total: 0, counts: {note:0,talk:0,board:0,comment:0},notes:[],talks:[],board:[],comments:[],terms:[],hasMore:false}}}) }
            return route.fulfill({json: {code:200,data: path.endsWith('/user') ? {blogTitle:'博客'} : {}}})
        })
        await page.route('**/default-avatar.png', route => route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg"/>'}))
        await page.goto(sandboxURL)
        if (width < 1200) { await page.getByRole('button', {name:'打开导航菜单'}).click(); await page.locator('.mSearchInput').click() }
        else await page.getByRole('button', {name:'搜索', exact:true}).click()
        await page.getByRole('combobox', {name:'搜索站内内容'}).fill('Python')
        await expect(page.getByText('未找到相关内容')).toBeVisible()
        await expect(page.getByRole('button', {name:'文章向量图谱检索'})).toHaveCount(0)
        expect(graphCalls).toEqual([])
        expect(searchCalls).toBe(1)
    })
}

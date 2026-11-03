import {test,expect} from './sandbox'
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

import {test, expect} from './sandbox'

test.use({entry:'image-viewer'})
for (const viewport of [{width:1280,height:900},{width:375,height:812},{width:812,height:375}]) {
  test(`后台直接加载时图片可放大且完整适配 ${viewport.width}×${viewport.height}`, async ({page,sandboxURL}) => {
    await page.setViewportSize(viewport)
    await page.goto(sandboxURL)
    for (let index=0;index<3;index++) {
      const source=page.getByAltText(`图片${index}`,{exact:true})
      await expect.poll(() => source.evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBeGreaterThan(0)
      await page.evaluate(()=>{document.body.style.overflow='hidden'})
      await source.click()
      await expect(page.getByRole('dialog',{name:'图片放大视图'})).toBeVisible()
      await expect(page.getByRole('button',{name:'关闭放大视图'})).toBeVisible()
      await page.keyboard.press('Tab')
      await expect(page.getByRole('button',{name:'关闭放大视图'})).toBeFocused()
      const bounds=await page.locator('.md-zoom-content img').evaluate(image=>{
        const box=image.getBoundingClientRect()
        return {width:box.width,height:box.height,left:box.left,top:box.top,right:box.right,bottom:box.bottom}
      })
      expect(bounds.width).toBeGreaterThan(0)
      expect(bounds.height).toBeGreaterThan(0)
      expect(bounds.left).toBeGreaterThanOrEqual(0)
      expect(bounds.top).toBeGreaterThanOrEqual(0)
      expect(bounds.right).toBeLessThanOrEqual(viewport.width)
      expect(bounds.bottom).toBeLessThanOrEqual(viewport.height)
      if (index===2) {
        await page.mouse.move(viewport.width/2,viewport.height/2)
        await page.mouse.wheel(0,-20)
        const after=await page.locator('.md-zoom-content img').evaluate(image=>image.getBoundingClientRect().height)
        expect(after/bounds.height).toBeLessThan(1.1)
      }
      await page.keyboard.press('Escape')
      await expect(page.locator('.md-zoom-overlay')).toHaveCount(0)
      expect(await page.evaluate(()=>document.body.style.overflow)).toBe('hidden')
    }
  })
}

import {test, expect} from './sandbox'

test.use({entry:'sticker-picker',viewport:{width:375,height:720}})

for (const dark of [false,true]) test(`sticker picker stays readable and inside the viewport: ${dark}`, async ({page,sandboxURL}) => {
  await page.route('**/stickers/**', route => route.fulfill({status:200,contentType:'image/png',
    body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCfsAAAAASUVORK5CYII=', 'base64')}))
  await page.goto(sandboxURL)
  if (dark) await page.evaluate(() => {
    localStorage.setItem('isDarkMode','true')
    window.dispatchEvent(new CustomEvent('darkmode-change',{detail:true}))
  })
  const trigger = page.getByRole('button',{name:/表情/})
  await trigger.click()
  const panel = page.getByRole('dialog',{name:'选择站内表情'})
  await expect(panel).toBeVisible()
  const bounds = await panel.evaluate(element => {
    const popup = element.closest('.ant-popover')!, r=popup.getBoundingClientRect()
    const image=element.querySelector('img')!.getBoundingClientRect()
    return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:innerHeight,
      width:innerWidth,image:image.height,dark:popup.classList.contains('washiDark')}
  })
  expect(bounds.left).toBeGreaterThanOrEqual(0)
  expect(bounds.right).toBeLessThanOrEqual(bounds.width)
  expect(bounds.top).toBeGreaterThanOrEqual(0)
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height)
  expect(bounds.image).toBeGreaterThanOrEqual(60)
  expect(bounds.dark).toBe(dark)
  await panel.getByRole('button').first().click()
  await expect(page.getByRole('status')).toContainText(':')
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(trigger).toHaveAttribute('aria-expanded','false')
})

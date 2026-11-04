import {test, expect} from './sandbox'

test.use({entry:'seo'})
test('SPA 元数据替换静态回退，私有与不存在页面不索引，返回公开页恢复', async ({page,sandboxURL})=>{
  await page.route('https://v1.jinrishici.com/all',route=>route.fulfill({json:{content:'合成诗句'}}))
  await page.goto(sandboxURL)
  await expect(page).toHaveTitle('测试文章 | 示例博客')
  await expect(page.locator('head link[rel="canonical"]')).toHaveCount(1)
  await expect(page.locator('head link[rel="canonical"]')).toHaveAttribute('href','https://example.test/article/23')
  for(const selector of ['meta[name="description"]','meta[name="robots"]','meta[property="og:title"]',
    'meta[property="og:url"]','meta[property="og:image"]','meta[name="twitter:card"]'])
    await expect(page.locator('head '+selector)).toHaveCount(1)
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content','页面独立摘要')
  await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute('content','https://cdn.example.test/cover.webp')
  for(const path of ['/login','/dashboard/users','/missing']) {
    await page.getByRole('button',{name:path,exact:true}).click()
    await expect(page.locator('head meta[name="robots"]')).toHaveCount(1)
    await expect(page.locator('head meta[name="robots"]')).toHaveAttribute('content','noindex, follow')
    await expect(page.locator('head link[rel="canonical"]')).toHaveCount(0)
  }
  await page.getByRole('button',{name:'/guestbook',exact:true}).click()
  await expect(page.locator('head meta[name="robots"]')).toHaveAttribute('content','index, follow')
  await expect(page.locator('head link[rel="canonical"]')).toHaveAttribute('href','https://example.test/guestbook')
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content','https://example.test/logo.png')
  await expect(page.locator('footer')).toContainText(/© \d{4} 测试站主/)
  await expect(page.locator('footer')).toContainText('林陌青川 (LinMo)')
  await expect(page.locator('footer')).toContainText('Sora Saudade')
  await expect(page.getByRole('link',{name:'Memory-Blog',exact:true})).toHaveAttribute('href','https://github.com/LinMoQC/Memory-Blog')
})

import {test, expect} from './sandbox'

test.use({entry: 'article-collaboration', viewport: {width: 1280, height: 1000}})

test('real editor reviews body, updates summary directly and preserves undo', async ({page, sandboxURL}) => {
  await page.goto(sandboxURL)
  await expect(page.locator('.CodeMirror')).toBeVisible()
  await page.evaluate(() => {
    const editor = window.__saudadeArticleEditor!
    const snapshot = editor.execute({kind:'article_editor',operation:'read',command_id:'read'})
    editor.execute({kind:'article_editor',operation:'propose',command_id:'propose',
      editor_id:snapshot.editor_id,revision:snapshot.revision,
      edits:[{old_text:'原始正文。',new_text:'精简后的正文。'},{old_text:'第二节正文。',new_text:'改写的第二节。'}]})
    const summary = editor.execute({kind:'article_editor',operation:'summary',command_id:'summary',
      editor_id:snapshot.editor_id,revision:snapshot.revision,description:'新生成的文章概述'})
    if (summary.description !== '新生成的文章概述' || summary.revision !== snapshot.revision + 1)
      throw new Error('编辑器未返回实际应用的摘要与版本。')
  })
  const review = page.getByRole('region',{name:'正文修改建议'})
  await expect(review).toBeVisible()
  await expect(review.locator('pre del').first()).toContainText('原始正文。')
  await expect(review.locator('pre ins').first()).toContainText('精简后的正文。')
  await expect(page.getByLabel('文章摘要概述')).toHaveText('新生成的文章概述')
  await expect(page.getByLabel('草稿正文')).toContainText('原始正文。')
  await review.getByRole('button',{name:'采纳此处'}).last().click()
  await expect(page.getByLabel('草稿正文')).toContainText('改写的第二节。')
  await review.getByRole('button',{name:'全部采纳'}).click()
  await expect(review).not.toBeVisible()
  await expect(page.getByLabel('草稿正文')).toContainText('精简后的正文。')
  await page.locator('.CodeMirror textarea').focus()
  await page.keyboard.press('Control+z')
  await expect(page.getByLabel('草稿正文')).toContainText('原始正文。')
  await expect(page.getByLabel('文章摘要概述')).toHaveText('新生成的文章概述')
})

test('live typing and account changes invalidate writes; suggestions render as text', async ({page,sandboxURL}) => {
  await page.goto(sandboxURL)
  await expect(page.locator('.CodeMirror')).toBeVisible()
  await page.evaluate(() => {
    const editor = window.__saudadeArticleEditor!
    const snapshot=editor.execute({kind:'article_editor',operation:'read',command_id:'read'})
    editor.execute({kind:'article_editor',operation:'propose',command_id:'propose',
      editor_id:snapshot.editor_id,revision:snapshot.revision,
      edits:[{old_text:'原始正文。',new_text:'<img src=x onerror="window.bad=true">'}]})
  })
  await expect(page.getByRole('region',{name:'正文修改建议'}).locator('img')).toHaveCount(0)
  const source=page.locator('.CodeMirror textarea')
  await source.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\n用户继续输入')
  const result=await page.evaluate(() => window.__saudadeArticleEditor!.execute({kind:'article_editor',operation:'read',command_id:'fresh'}))
  expect(result.content).toContain('用户继续输入')
  await expect(page.getByRole('button',{name:'全部采纳'})).toBeDisabled()
  const blocked=await page.evaluate(() => {
    localStorage.setItem('tokenKey','different-account')
    try { window.__saudadeArticleEditor!.execute({kind:'article_editor',operation:'read',command_id:'other'}); return false }
    catch { return true }
  })
  expect(blocked).toBe(true)
  await expect(page.getByLabel('草稿正文')).toContainText('用户继续输入')
})

import {test, expect} from './sandbox'

test.use({entry: 'note-editor', viewport: {width: 1280, height: 900}})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`editor preview uses the source pane's light canvas: ${colorScheme}`, async ({page, sandboxURL}) => {
    await page.emulateMedia({colorScheme})
    await page.goto(sandboxURL)
    const preview = page.locator('.saudade-note-editor .markdown-body')
    await expect(preview.getByRole('heading', {name: '编辑预览'})).toBeVisible()
    await expect(preview).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(preview).toHaveCSS('color', 'rgb(31, 35, 40)')
    await expect(page.locator('.CodeMirror')).toHaveCSS('background-color', 'rgb(255, 255, 255)')

    // 模拟稍后载入的页面样式；编辑器画布不受全局 Markdown 主题覆盖。
    await page.addStyleTag({content: '.markdown-body { background-color: #0d1117; color: #f0f6fc; }'})
    await expect(preview).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(preview).toHaveCSS('color', 'rgb(31, 35, 40)')
    const outside = page.getByTestId('outside-preview')
    await expect(outside).toHaveCSS('padding', '0px')
    await expect(outside).toHaveCSS('background-color', 'rgb(13, 17, 23)')

    const source = page.locator('.CodeMirror textarea')
    await source.focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText('\n\n新增草稿段落')
    await expect(preview).toContainText('新增草稿段落')
  })
}

test('editor math renders with shared KaTeX and rejects untrusted links', async ({page, sandboxURL}) => {
  await page.goto(sandboxURL)
  const source = page.locator('.CodeMirror textarea')
  await source.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(String.raw`

公式 $E=mc^2$

$$\frac{1}{2}$$

$\href{javascript:alert(1)}{unsafe}$`)
  const preview = page.locator('.saudade-note-editor .markdown-body')
  await expect(preview.locator('.katex').first()).toBeVisible()
  await expect(preview.locator('.katex-display')).toBeVisible()
  await expect(preview.locator('a[href^="javascript:"]')).toHaveCount(0)
  await expect(preview).toContainText('unsafe')
})

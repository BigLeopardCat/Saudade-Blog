import {test, expect} from './sandbox'

test.use({entry: 'cover-display'})
test('portrait covers retain the full image after selection and reopening', async ({page, sandboxURL}) => {
    await page.goto(sandboxURL)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('完整图片，不裁切', {exact: true})).toBeVisible()
    await dialog.getByRole('button', {name: /确\s*定/}).click()
    const image = page.getByAltText('保存的文章封面')
    await expect(image).toHaveCSS('object-fit', 'contain')
    expect(await image.evaluate((el: HTMLImageElement) => el.naturalHeight / el.naturalWidth)).toBe(3)
    await page.getByRole('button', {name: '调整封面'}).click()
    await expect(dialog.getByText('完整图片，不裁切', {exact: true})).toBeVisible()
    await dialog.getByText('铺满裁切', {exact: true}).click()
    const cropper = dialog.locator('.reactEasyCrop_Container')
    await expect(cropper.locator('img')).toBeVisible()
    const stage = await cropper.boundingBox()
    if (!stage) throw new Error('Crop stage is missing')
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2)
    await page.mouse.down()
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2 - 45, {steps: 5})
    await page.mouse.up()
    const transform = await cropper.locator('img').evaluate(el => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform)
        return [matrix.a, matrix.d, matrix.e, matrix.f]
    })
    await dialog.getByRole('button', {name: /确\s*定/}).click()
    await expect(image).toHaveCSS('object-fit', 'cover')
    await page.getByRole('button', {name: '调整封面'}).click()
    await expect(cropper.locator('img')).toHaveJSProperty('complete', true)
    await expect.poll(async () => {
        const actual = await cropper.locator('img').evaluate(el => {
            const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform)
            return [matrix.a, matrix.d, matrix.e, matrix.f]
        })
        return Math.max(...actual.map((value, index) => Math.abs(value - transform[index])))
    }).toBeLessThan(0.2)
})


test('an unreadable image cannot be confirmed', async ({page, sandboxURL}) => {
    await page.goto(sandboxURL)
    await page.getByRole('dialog').locator('.ant-modal-close').click()
    await page.getByRole('button', {name: '使用损坏图片'}).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('status')).toHaveText('图片加载失败，请重新选择')
    await expect(dialog.getByRole('button', {name: /确\s*定/})).toBeDisabled()
})

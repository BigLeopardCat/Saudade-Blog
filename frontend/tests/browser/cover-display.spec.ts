import {test, expect} from './sandbox'

test.use({entry: 'cover-display'})
test('portrait covers retain the full image after selection and reopening', async ({page, sandboxURL}) => {
    await page.goto(sandboxURL)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('完整图片，不裁切', {exact: true})).toBeVisible()
    await dialog.getByRole('button', {name: '确定', exact: true}).click()
    const image = page.getByAltText('保存的文章封面')
    await expect(image).toHaveCSS('object-fit', 'contain')
    expect(await image.evaluate((el: HTMLImageElement) => el.naturalHeight / el.naturalWidth)).toBe(3)
    await page.getByRole('button', {name: '调整封面'}).click()
    await expect(dialog.getByText('完整图片，不裁切', {exact: true})).toBeVisible()
    await dialog.getByText('铺满裁切', {exact: true}).click()
    await expect(dialog.locator('.reactEasyCrop_Container')).toBeVisible()
    await dialog.getByRole('button', {name: '确定', exact: true}).click()
    await expect(image).toHaveCSS('object-fit', 'cover')
})

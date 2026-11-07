import {test, expect} from './sandbox'
import http from 'node:http'

test.use({entry: 'cover-display'})
test('portrait covers retain the full image after selection and reopening', async ({page, sandboxURL}) => {
    await page.goto(sandboxURL)
    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('.reactEasyCrop_Container img')).toBeVisible()
    await dialog.getByText('完整显示（允许留边）', {exact: true}).click()
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

test('R2 covers load when the widget wraps window.Image with anonymous CORS', async ({page, sandboxURL}) => {
    await page.addInitScript(() => {
        const OriginalImage = window.Image
        window.Image = function (...args: ConstructorParameters<typeof Image>) {
            const image = new OriginalImage(...args)
            image.crossOrigin = 'anonymous'
            return image
        } as unknown as typeof Image
        window.Image.prototype = OriginalImage.prototype
    })
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGO40nDlPwAHfAMoc3ODKQAAAABJRU5ErkJggg==', 'base64')
    const modes: (string | undefined)[] = []
    // Real responses matter: route.fulfill can supply CORS headers automatically.
    const images = http.createServer((req, res) => {
        modes.push(req.headers['sec-fetch-mode'] as string | undefined)
        res.writeHead(200, {'Content-Type': 'image/png'}).end(png)
    })
    await new Promise<void>(resolve => images.listen(0, '127.0.0.1', resolve))
    try {
        const address = images.address()
        if (!address || typeof address === 'string') throw new Error('Image server did not bind')
        const source = `http://127.0.0.1:${address.port}/gallery/cover.png`
        await page.route(source, route => route.continue())
        await page.goto(`${sandboxURL}#${encodeURIComponent(source)}`)
        await page.getByRole('dialog').locator('.ant-modal-close').click()
        await page.getByRole('button', {name: '使用 R2 图片'}).click()
        const dialog = page.getByRole('dialog')
        const confirm = dialog.getByRole('button', {name: /确\s*定/})
        await expect(confirm).toBeEnabled()
        await expect(dialog.getByRole('status')).toHaveCount(0)
        await dialog.getByText('铺满裁切', {exact: true}).click()
        await expect(dialog.locator('.reactEasyCrop_Image')).toHaveJSProperty('naturalWidth', 1)
        expect(modes.length).toBeGreaterThan(0)
        expect(modes).not.toContain('cors')
        await confirm.click()
        const saved = page.getByAltText('保存的文章封面')
        await expect(saved).toHaveAttribute('src', source)
        await page.getByRole('button', {name: '调整封面'}).click()
        await expect(confirm).toBeEnabled()
    } finally {
        images.closeAllConnections()
        await new Promise<void>(resolve => images.close(() => resolve()))
    }
})


test('new cover selection starts in fill mode and uses the three declared preview ratios', async ({page, sandboxURL}) => {
    await page.goto(sandboxURL)
    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('.reactEasyCrop_Container img')).toBeVisible()
    const card = dialog.locator('.ccPreviewItem').filter({hasText: '文章卡片'}).locator('.ccPreviewFrame')
    const detail = dialog.locator('.ccPreviewItem').filter({hasText: '详情横幅'}).locator('.ccPreviewFrame')
    for (const [frame, ratio] of [[card, 16 / 9], [detail, 3.5]] as const) {
        const box = await frame.boundingBox()
        expect(box!.width / box!.height).toBeCloseTo(ratio, 2)
    }
    await dialog.getByRole('tab', {name: '首页置顶轮播'}).click()
    const carousel = await dialog.locator('.ccPreviewItem').filter({hasText: '首页轮播'}).locator('.ccPreviewFrame').boundingBox()
    expect(carousel!.width / carousel!.height).toBeCloseTo(1, 2)
    await dialog.getByRole('button', {name: /确\s*定/}).click()
    await expect(page.getByAltText('保存的文章封面')).toHaveCSS('object-fit', 'cover')
})

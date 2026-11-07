import {test, expect} from './sandbox'
import {statSync} from 'node:fs'

test.use({entry: 'sweep-loading'})

test('the eight approved frames run in row-major order within a stable stage', async ({page, sandboxURL}) => {
    await page.emulateMedia({reducedMotion: 'no-preference'})
    await page.goto(sandboxURL)
    const stage = page.getByRole('region', {name: '浅色预览'}).locator('.sweep-loading')
    const sprite = stage.locator('.sweep-loading__sprite')
    await expect(sprite).toHaveCSS('animation-play-state', 'running')
    await expect(stage).toHaveCSS('width', '96px')
    await expect(stage).toHaveCSS('height', '96px')
    await expect(sprite).toHaveCSS('background-size', '384px 192px')
    expect(statSync(new URL('../../src/components/SweepLoading/assets/sweep.webp', import.meta.url)).size)
        .toBeLessThan(120*1024)
    const bitmap = await sprite.evaluate(async element => {
        const image = new Image()
        image.src = getComputedStyle(element).backgroundImage.slice(5, -2)
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d')!
        context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        let transparent = false, opaque = false
        for (let index = 3; index < pixels.length; index += 4) {
            if (pixels[index] === 0) transparent = true
            if (pixels[index] === 255) opaque = true
        }
        return {width: canvas.width, height: canvas.height, transparent, opaque}
    })
    expect(bitmap).toEqual({width: 768, height: 384, transparent: true, opaque: true})
    const frames = await sprite.evaluate(element => {
        const animation = element.getAnimations()[0]
        animation.pause()
        return Array.from({length: 8}, (_, frame) => {
            animation.currentTime = frame*150 + 20
            return getComputedStyle(element).backgroundPosition
        })
    })
    expect(frames).toEqual(['0px 0px', '-96px 0px', '-192px 0px', '-288px 0px',
        '0px -96px', '-96px -96px', '-192px -96px', '-288px -96px'])
    await page.getByRole('button', {name: '完成加载'}).click()
    await expect(page.locator('.sweep-loading')).toHaveCount(0)
})

test('instances outside the viewport pause and reduced motion keeps frame zero', async ({page, sandboxURL}) => {
    await page.emulateMedia({reducedMotion: 'no-preference'})
    await page.goto(sandboxURL)
    const light = page.getByRole('region', {name: '浅色预览'}).locator('.sweep-loading__sprite')
    const dark = page.getByRole('region', {name: '深色预览'}).locator('.sweep-loading__sprite')
    await expect(light).toHaveCSS('animation-play-state', 'running')
    await expect(dark).toHaveCSS('animation-play-state', 'paused')
    await dark.scrollIntoViewIfNeeded()
    await expect(dark).toHaveCSS('animation-play-state', 'running')
    await expect(light).toHaveCSS('animation-play-state', 'paused')
    await page.emulateMedia({reducedMotion: 'reduce'})
    await expect(dark).toHaveCSS('animation-name', 'none')
    await expect(dark).toHaveCSS('background-position', '0px 0px')
    expect(await dark.evaluate(element => element.getAnimations().length)).toBe(0)
})
